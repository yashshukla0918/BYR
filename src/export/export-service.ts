import type { MediaRecord, Project } from '../domain/models';
import { CanvasRenderer, dimensionsForRatio, seekVideo } from '../editor/canvas-renderer';

export type StillType = 'image/png' | 'image/jpeg' | 'image/webp';
export const MAX_SEQUENCE_DURATION = 120;

export function supportedVideoMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1.42E01E', 'video/mp4'].find((mime) => MediaRecorder.isTypeSupported(mime)) ?? null;
}

export function estimateVideoBytes(duration: number, quality: number): number {
  const bitsPerSecond = 1_000_000 + Math.round(Math.max(0, Math.min(1, quality)) * 5_000_000);
  return Math.ceil(duration * bitsPerSecond / 8);
}

export async function exportStillImage(renderer: CanvasRenderer, record: MediaRecord, project: Project, width: number, height: number, type: StillType, quality: number): Promise<Blob> {
  const canvas = await renderer.render(record, project, width, height);
  return canvasBlob(canvas, type, quality);
}

export async function exportSequenceVideo(
  renderer: CanvasRenderer,
  project: Project,
  records: MediaRecord[],
  options: { width: number; height: number; frameRate: number; quality: number },
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<{ blob: Blob; mimeType: string }> {
  const mimeType = supportedVideoMime();
  if (!mimeType) throw new Error('This browser cannot record a canvas video. Try PNG or JPEG export instead.');
  if (!project.sequence.length) throw new Error('Add at least one photo or video to the sequence before exporting.');
  const totalDuration = project.sequence.reduce((sum, clip) => sum + clip.duration, 0);
  if (totalDuration > MAX_SEQUENCE_DURATION) throw new Error(`Video sequences are limited to ${MAX_SEQUENCE_DURATION} seconds on this export path.`);
  const lookup = new Map(records.map((record) => [record.id, record]));
  const firstRecord = lookup.get(project.sequence[0].mediaId);
  if (!firstRecord) throw new Error('A sequence item is missing from this project. Remove it and add the media again.');
  const firstSource = await renderer.loadSource(firstRecord);

  const canvas = document.createElement('canvas'); canvas.width = options.width; canvas.height = options.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas rendering is unavailable.');
  const stream = canvas.captureStream(options.frameRate);
  const videoBitsPerSecond = Math.round(1_000_000 + Math.max(0, Math.min(1, options.quality)) * 5_000_000);
  let recorder: MediaRecorder;
  try { recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond }); }
  catch { stream.getTracks().forEach((track) => track.stop()); throw new Error(`The selected video format is unavailable: ${mimeType}.`); }
  const chunks: BlobPart[] = [];
  let resolveStop!: (blob: Blob) => void;
  let rejectStop!: (error: Error) => void;
  const stopped = new Promise<Blob>((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  recorder.onerror = () => rejectStop(new Error('The browser encoder stopped unexpectedly. Try a lower resolution or quality.'));
  recorder.onstop = () => resolveStop(new Blob(chunks, { type: mimeType }));
  let recordingStarted = false;
  let elapsedBeforeClip = 0;
  try {
    renderer.drawRecord(context, firstSource, firstRecord, project, options.width, options.height);
    recorder.start(500);
    recordingStarted = true;
    for (const clip of project.sequence) {
      if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
      const record = lookup.get(clip.mediaId)!;
      const source = await renderer.loadSource(record);
      if (source instanceof HTMLVideoElement) {
        await seekVideo(source, 0);
        await source.play();
      }
      const clipStarted = performance.now();
      while ((performance.now() - clipStarted) / 1000 < clip.duration) {
        if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
        renderer.drawRecord(context, source, record, project, options.width, options.height);
        const elapsed = elapsedBeforeClip + Math.min(clip.duration, (performance.now() - clipStarted) / 1000);
        onProgress(Math.min(100, elapsed / totalDuration * 100));
        await nextFrame(signal);
      }
      if (source instanceof HTMLVideoElement) source.pause();
      elapsedBeforeClip += clip.duration;
      if (record.id !== project.selectedMediaId) renderer.release(record.id);
    }
    recorder.stop();
    const blob = await stopped;
    onProgress(100);
    if (!blob.size) throw new Error('The browser created an empty video. Try another browser or export a still image.');
    return { blob, mimeType: blob.type || mimeType };
  } catch (error) {
    if (recorder.state !== 'inactive') recorder.stop();
    if (recordingStarted) await stopped.catch(() => undefined);
    throw error;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function outputDimensions(ratio: Project['canvasRatio'], longEdge: number): { width: number; height: number } {
  return dimensionsForRatio(ratio, longEdge);
}

export function safeOutputName(value: string, extension: string): string {
  const base = value.trim().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'byr-export';
  return `${base}.${extension}`;
}

function canvasBlob(canvas: HTMLCanvasElement, type: StillType, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('The browser could not encode this image. Try a smaller size.')); return; }
        if (blob.type !== type) { reject(new Error(`This browser cannot export ${type.split('/')[1].toUpperCase()} images. Choose PNG or JPEG instead.`)); return; }
        resolve(blob);
      }, type, quality);
    } catch { reject(new Error('Image export failed. Try a smaller output size.')); }
  });
}

function nextFrame(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Export cancelled.', 'AbortError')); return; }
    const requestId = requestAnimationFrame(() => { signal.removeEventListener('abort', cancel); resolve(); });
    const cancel = () => { cancelAnimationFrame(requestId); reject(new DOMException('Export cancelled.', 'AbortError')); };
    signal.addEventListener('abort', cancel, { once: true });
  });
}
