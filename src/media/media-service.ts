import type { MediaKind, MediaRecord } from '../domain/models';

export const MAX_MEDIA_FILE_SIZE = 100 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);
const SUPPORTED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg', 'video/x-m4v']);

export interface ImportResult { records: MediaRecord[]; rejected: Array<{ name: string; reason: string }> }

export async function prepareMediaFiles(projectId: string, files: FileList | File[]): Promise<ImportResult> {
  const records: MediaRecord[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  for (const file of Array.from(files)) {
    const kind = detectKind(file);
    if (!kind) { rejected.push({ name: file.name, reason: 'Unsupported file type' }); continue; }
    if (file.size === 0) { rejected.push({ name: file.name, reason: 'File is empty' }); continue; }
    if (file.size > MAX_MEDIA_FILE_SIZE) { rejected.push({ name: file.name, reason: 'Larger than 100 MB' }); continue; }
    try { records.push(await createMediaRecord(projectId, file, kind)); }
    catch (error) { rejected.push({ name: file.name, reason: error instanceof Error ? error.message : 'Could not read file' }); }
  }
  return { records, rejected };
}

function detectKind(file: File): MediaKind | null {
  if (file.type.startsWith('image/') && SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())) return 'image';
  if (file.type.startsWith('video/') && SUPPORTED_VIDEO_TYPES.has(file.type.toLowerCase())) return 'video';
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'].includes(extension ?? '')) return 'image';
  if (['mp4', 'm4v', 'mov', 'webm', 'ogv'].includes(extension ?? '')) return 'video';
  return null;
}

async function createMediaRecord(projectId: string, file: File, kind: MediaKind): Promise<MediaRecord> {
  const details = kind === 'image' ? await inspectImage(file) : await inspectVideo(file);
  const mimeType = file.type || inferMimeType(file.name, kind);
  return {
    id: crypto.randomUUID(), projectId, name: file.name, mimeType,
    kind, size: file.size, importedAt: Date.now(), width: details.width, height: details.height, duration: details.duration,
    source: file.slice(0, file.size, file.type), thumbnail: details.thumbnail,
  };
}

function inferMimeType(name: string, kind: MediaKind): string {
  const extension = name.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg',
  };
  return types[extension ?? ''] ?? `${kind}/octet-stream`;
}

async function inspectImage(file: File): Promise<{ width: number | null; height: number | null; duration: null; thumbnail: Blob | null }> {
  try {
    const bitmap = await createImageBitmap(file);
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 480 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    context?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return { width, height, duration: null, thumbnail: await canvasToBlob(canvas) };
  } catch {
    throw new Error('This image could not be decoded by the browser');
  }
}

async function inspectVideo(file: File): Promise<{ width: number | null; height: number | null; duration: number | null; thumbnail: Blob | null }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata'; video.muted = true; video.playsInline = true; video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Video metadata timed out')), 10_000);
      video.onloadedmetadata = () => { window.clearTimeout(timeout); resolve(); };
      video.onerror = () => { window.clearTimeout(timeout); reject(new Error('Video format is not supported by this browser')); };
    });
    const width = video.videoWidth || null; const height = video.videoHeight || null; const duration = Number.isFinite(video.duration) ? video.duration : null;
    let thumbnail: Blob | null = null;
    if (width && height) {
      try {
        video.currentTime = Math.min(0.15, (duration ?? 1) / 2);
        await new Promise<void>((resolve) => { video.onseeked = () => resolve(); window.setTimeout(resolve, 1200); });
        const canvas = document.createElement('canvas'); const scale = Math.min(1, 480 / Math.max(width, height));
        canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
        canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height); thumbnail = await canvasToBlob(canvas);
      } catch { /* Video remains importable without a generated thumbnail. */ }
    }
    return { width, height, duration, thumbnail };
  } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.78));
}

export function formatDuration(duration: number | null): string {
  if (duration === null) return 'Duration unavailable';
  const seconds = Math.floor(duration);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
