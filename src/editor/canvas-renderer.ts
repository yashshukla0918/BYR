import { createPhotoEdit, type CanvasOverlay, type CanvasRatio, type PhotoEdit, type Project, type TextOverlay } from '../domain/models';
import type { MediaRecord } from '../domain/models';

export type DrawableMedia = ImageBitmap | HTMLImageElement | HTMLVideoElement;

export function dimensionsForRatio(ratio: CanvasRatio, longEdge = 1200): { width: number; height: number } {
  const values: Record<CanvasRatio, [number, number]> = { '9:16': [9, 16], '16:9': [16, 9], '1:1': [1, 1], '4:5': [4, 5] };
  const [w, h] = values[ratio];
  return w < h ? { width: Math.round(longEdge * w / h), height: longEdge } : { width: longEdge, height: Math.round(longEdge * h / w) };
}

export class CanvasRenderer {
  private readonly cache = new Map<string, { drawable: DrawableMedia; url: string }>();
  private readonly pending = new Map<string, Promise<DrawableMedia>>();

  async loadSource(record: MediaRecord): Promise<DrawableMedia> {
    const cached = this.cache.get(record.id);
    if (cached) return cached.drawable;
    const pending = this.pending.get(record.id);
    if (pending) return pending;
    const url = URL.createObjectURL(record.source);
    const task = (record.kind === 'video' ? loadVideo(url) : loadImage(record.source, url))
      .then((drawable) => { this.cache.set(record.id, { drawable, url }); return drawable; })
      .catch((error: unknown) => { URL.revokeObjectURL(url); throw error; })
      .finally(() => this.pending.delete(record.id));
    this.pending.set(record.id, task);
    return task;
  }

  async render(record: MediaRecord, project: Project, width: number, height: number, videoTime = 0): Promise<HTMLCanvasElement> {
    const source = await this.loadSource(record);
    if (source instanceof HTMLVideoElement && Number.isFinite(videoTime) && Math.abs(source.currentTime - videoTime) > 0.08) {
      await seekVideo(source, videoTime);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas rendering is not available in this browser.');
    this.drawRecord(context, source, record, project, width, height);
    return canvas;
  }

  drawRecord(context: CanvasRenderingContext2D, source: CanvasImageSource, record: MediaRecord, project: Project, width: number, height: number): void {
    const edit = project.photoEdits[record.id] ?? createPhotoEdit();
    context.save();
    context.fillStyle = edit.backgroundColor || '#171916'; context.fillRect(0, 0, width, height);
    context.filter = `brightness(${100 + edit.brightness}%) contrast(${100 + edit.contrast}%) saturate(${100 + edit.saturation}%)`;
    const bitmapSource = source as CanvasImageSource & { width: number; height: number };
    const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source instanceof HTMLImageElement ? source.naturalWidth : bitmapSource.width;
    const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source instanceof HTMLImageElement ? source.naturalHeight : bitmapSource.height;
    if (sourceWidth > 0 && sourceHeight > 0) {
      const rotation = edit.rotation * Math.PI / 180;
      const rotatedWidth = edit.rotation % 180 === 0 ? width : height;
      const rotatedHeight = edit.rotation % 180 === 0 ? height : width;
      const fitScale = edit.fit === 'cover' ? Math.max(rotatedWidth / sourceWidth, rotatedHeight / sourceHeight) : Math.min(rotatedWidth / sourceWidth, rotatedHeight / sourceHeight);
      const drawWidth = sourceWidth * fitScale * edit.zoom;
      const drawHeight = sourceHeight * fitScale * edit.zoom;
      context.translate(width / 2, height / 2); context.rotate(rotation); context.scale(edit.flipHorizontal ? -1 : 1, 1);
      context.drawImage(source, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    }
    context.restore();
    applyTone(context, width, height, edit);
    edit.overlays.forEach((overlay) => drawOverlay(context, overlay, width, height));
  }

  dispose(): void {
    this.cache.forEach(({ drawable, url }) => {
      if (typeof ImageBitmap !== 'undefined' && drawable instanceof ImageBitmap) drawable.close();
      if (drawable instanceof HTMLVideoElement) { drawable.pause(); drawable.removeAttribute('src'); drawable.load(); }
      URL.revokeObjectURL(url);
    });
    this.cache.clear();
  }

  release(id: string): void {
    const cached = this.cache.get(id);
    if (!cached) return;
    const { drawable, url } = cached;
    if (typeof ImageBitmap !== 'undefined' && drawable instanceof ImageBitmap) drawable.close();
    if (drawable instanceof HTMLVideoElement) { drawable.pause(); drawable.removeAttribute('src'); drawable.load(); }
    URL.revokeObjectURL(url); this.cache.delete(id);
  }

  clearCacheExcept(id: string): void {
    this.cache.forEach(({ drawable, url }, key) => {
      if (key === id) return;
      if (typeof ImageBitmap !== 'undefined' && drawable instanceof ImageBitmap) drawable.close();
      if (drawable instanceof HTMLVideoElement) { drawable.pause(); drawable.removeAttribute('src'); drawable.load(); }
      URL.revokeObjectURL(url); this.cache.delete(key);
    });
  }
}

function applyTone(context: CanvasRenderingContext2D, width: number, height: number, edit: PhotoEdit): void {
  if (!edit.temperature && !edit.highlights && !edit.shadows && edit.look === 'none') return;
  const frame = context.getImageData(0, 0, width, height);
  const pixels = frame.data;
  const strength = Math.max(0, Math.min(1, edit.filterAmount / 100));
  const warmth = edit.temperature * 0.18 + (edit.look === 'warm' ? 10 : edit.look === 'cool' ? -7 : 0);
  const mono = edit.look === 'mono'; const fade = edit.look === 'fade';
  const blend = edit.look === 'overlay' ? 128 : edit.look === 'burn' ? 54 : edit.look === 'multiply' ? 190 : edit.look === 'screen' ? 110 : edit.look === 'soft-light' ? 150 : null;
  for (let index = 0; index < pixels.length; index += 4) {
    let red = pixels[index]; let green = pixels[index + 1]; let blue = pixels[index + 2];
    const luminance = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
    const shadowLift = edit.shadows * (1 - luminance) ** 2 * 0.48;
    const highlightAdjust = edit.highlights * luminance ** 2 * 0.48;
    red += shadowLift + highlightAdjust + warmth;
    green += shadowLift * 0.62 + highlightAdjust * 0.72;
    blue += shadowLift * 0.42 + highlightAdjust * 0.5 - warmth;
    if (mono) { const gray = red * 0.2126 + green * 0.7152 + blue * 0.0722; red = red * (1 - strength) + gray * strength; green = green * (1 - strength) + gray * strength; blue = blue * (1 - strength) + gray * strength; }
    if (fade) { red = red * (1 - strength) + (red * 0.86 + 28) * strength; green = green * (1 - strength) + (green * 0.86 + 28) * strength; blue = blue * (1 - strength) + (blue * 0.86 + 28) * strength; }
    if (blend !== null) {
      red = blendChannel(pixels[index], blend, edit.look, strength);
      green = blendChannel(pixels[index + 1], blend, edit.look, strength);
      blue = blendChannel(pixels[index + 2], blend, edit.look, strength);
    }
    pixels[index] = clampChannel(red); pixels[index + 1] = clampChannel(green); pixels[index + 2] = clampChannel(blue);
  }
  context.putImageData(frame, 0, 0);
}

function blendChannel(base: number, blend: number, mode: PhotoEdit['look'], strength: number): number {
  const b = base / 255; const m = blend / 255;
  let result = b;
  if (mode === 'overlay') result = b < 0.5 ? 2 * b * m : 1 - 2 * (1 - b) * (1 - m);
  else if (mode === 'burn') result = m <= 0 ? 0 : 1 - Math.min(1, (1 - b) / m);
  else if (mode === 'multiply') result = b * m;
  else if (mode === 'screen') result = 1 - (1 - b) * (1 - m);
  else if (mode === 'soft-light') result = m < 0.5 ? b - (1 - 2 * m) * b * (1 - b) : b + (2 * m - 1) * (Math.sqrt(b) - b);
  return base * (1 - strength) + result * 255 * strength;
}

function clampChannel(value: number): number { return Math.max(0, Math.min(255, Math.round(value))); }

function drawOverlay(context: CanvasRenderingContext2D, overlay: CanvasOverlay, width: number, height: number): void {
  if (overlay.kind === 'shape') {
    context.save(); context.fillStyle = overlay.color; context.globalAlpha = overlay.opacity;
    const x = overlay.x * width; const y = overlay.y * height; const shapeWidth = overlay.width * width; const shapeHeight = overlay.height * height;
    if (overlay.shape === 'ellipse') { context.beginPath(); context.ellipse(x, y, shapeWidth / 2, shapeHeight / 2, 0, 0, Math.PI * 2); context.fill(); }
    else if (overlay.shape === 'frame') { context.globalAlpha = 1; context.lineWidth = Math.max(2, width * 0.012); context.strokeStyle = overlay.color; context.strokeRect(x - shapeWidth / 2, y - shapeHeight / 2, shapeWidth, shapeHeight); }
    else if (overlay.shape === 'line' || overlay.shape === 'arrow') {
      context.globalAlpha = Math.max(overlay.opacity, 0.8); context.strokeStyle = overlay.color; context.fillStyle = overlay.color; context.lineWidth = Math.max(2, width * 0.008); context.lineCap = 'round';
      context.beginPath(); context.moveTo(x - shapeWidth / 2, y); context.lineTo(x + shapeWidth / 2, y); context.stroke();
      if (overlay.shape === 'arrow') { context.beginPath(); context.moveTo(x + shapeWidth / 2, y); context.lineTo(x + shapeWidth / 2 - shapeHeight * 0.55, y - shapeHeight * 0.38); context.lineTo(x + shapeWidth / 2 - shapeHeight * 0.55, y + shapeHeight * 0.38); context.closePath(); context.fill(); }
    }
    else if (overlay.shape === 'star' || overlay.shape === 'heart' || overlay.shape === 'speech') {
      context.beginPath();
      if (overlay.shape === 'star') { for (let point = 0; point < 10; point += 1) { const angle = -Math.PI / 2 + point * Math.PI / 5; const radius = point % 2 === 0 ? 0.5 : 0.22; const px = x + Math.cos(angle) * shapeWidth * radius; const py = y + Math.sin(angle) * shapeHeight * radius; point ? context.lineTo(px, py) : context.moveTo(px, py); } context.closePath(); }
      else if (overlay.shape === 'heart') { context.moveTo(x, y + shapeHeight * 0.42); context.bezierCurveTo(x - shapeWidth * 0.8, y - shapeHeight * 0.05, x - shapeWidth * 0.35, y - shapeHeight * 0.65, x, y - shapeHeight * 0.25); context.bezierCurveTo(x + shapeWidth * 0.35, y - shapeHeight * 0.65, x + shapeWidth * 0.8, y - shapeHeight * 0.05, x, y + shapeHeight * 0.42); }
      else { context.roundRect(x - shapeWidth / 2, y - shapeHeight / 2, shapeWidth, shapeHeight, Math.min(shapeHeight * 0.18, 14)); context.moveTo(x - shapeWidth * 0.22, y + shapeHeight / 2); context.lineTo(x - shapeWidth * 0.35, y + shapeHeight * 0.72); context.lineTo(x - shapeWidth * 0.02, y + shapeHeight / 2); }
      context.fill();
    }
    else context.fillRect(x - shapeWidth / 2, y - shapeHeight / 2, shapeWidth, shapeHeight);
    context.restore(); return;
  }
  drawText(context, overlay, width, height);
}

function drawText(context: CanvasRenderingContext2D, overlay: TextOverlay, width: number, height: number): void {
  const fontSize = Math.round(overlay.size * height / 1200);
  context.save(); context.textAlign = overlay.align; context.textBaseline = 'middle'; context.fillStyle = overlay.color; context.globalAlpha = overlay.opacity;
  const family = overlay.font === 'serif' ? 'Georgia, serif' : overlay.font === 'mono' ? 'ui-monospace, monospace' : 'system-ui, sans-serif';
  context.font = `600 ${fontSize}px ${family}`; context.shadowColor = '#0009'; context.shadowBlur = Math.max(2, fontSize * 0.13);
  const maxWidth = width * 0.82; const words = overlay.text.split(/\s+/); const lines: string[] = [];
  let line = '';
  words.forEach((word) => {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) { lines.push(line); line = word; } else line = candidate;
  });
  if (line) lines.push(line);
  const x = overlay.x * width; const y = overlay.y * height; const lineHeight = fontSize * 1.2;
  const alignX = overlay.align === 'left' ? x - maxWidth / 2 : overlay.align === 'right' ? x + maxWidth / 2 : x;
  lines.forEach((content, index) => context.fillText(content, alignX, y + (index - (lines.length - 1) / 2) * lineHeight, maxWidth));
  context.restore();
}

async function loadImage(blob: Blob, url: string): Promise<DrawableMedia> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  return new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('The browser could not decode this image.')); image.src = url;
  });
}

async function loadVideo(url: string): Promise<HTMLVideoElement> {
  const video = document.createElement('video'); video.preload = 'auto'; video.muted = true; video.playsInline = true; video.src = url;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Video preview timed out while decoding this file.')), 15000);
    video.onloadeddata = () => { clearTimeout(timer); resolve(); };
    video.onerror = () => { clearTimeout(timer); reject(new Error('This browser cannot decode the selected video.')); };
  });
  return video;
}

export function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  const target = Math.max(0, Math.min(time, Number.isFinite(video.duration) ? video.duration : time));
  if (Math.abs(video.currentTime - target) < 0.04) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Seeking this video frame timed out.')), 5000);
    video.onseeked = () => { clearTimeout(timer); resolve(); };
    video.onerror = () => { clearTimeout(timer); reject(new Error('Could not decode the requested video frame.')); };
    video.currentTime = target;
  });
}

export function defaultEdit(_project: Project, record: MediaRecord): PhotoEdit {
  return _project.photoEdits[record.id] ?? createPhotoEdit();
}
