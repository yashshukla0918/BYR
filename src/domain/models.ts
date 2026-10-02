export const PROJECT_SCHEMA_VERSION = 2 as const;

export type MediaKind = 'image' | 'video';

export interface Project {
  id: string;
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  name: string;
  createdAt: number;
  updatedAt: number;
  mediaIds: string[];
  selectedMediaId: string | null;
  canvasRatio: CanvasRatio;
  photoEdits: Record<string, PhotoEdit>;
  sequence: SequenceClip[];
}

export type CanvasRatio = '9:16' | '16:9' | '1:1' | '4:5';

export interface TextOverlay {
  kind: 'text';
  id: string;
  text: string;
  x: number;
  y: number;
  size: number;
  color: string;
  opacity: number;
  font: 'sans' | 'serif' | 'mono';
  align: 'left' | 'center' | 'right';
}

export interface ShapeOverlay {
  kind: 'shape';
  id: string;
  shape: 'rectangle' | 'ellipse' | 'frame' | 'line' | 'arrow' | 'star' | 'heart' | 'speech';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  opacity: number;
}

export type CanvasOverlay = TextOverlay | ShapeOverlay;

export interface PhotoEdit {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  highlights: number;
  shadows: number;
  look: 'none' | 'warm' | 'cool' | 'mono' | 'fade' | 'overlay' | 'burn' | 'multiply' | 'screen' | 'soft-light';
  filterAmount: number;
  zoom: number;
  rotation: 0 | 90 | 180 | 270;
  flipHorizontal: boolean;
  fit: 'cover' | 'contain';
  backgroundColor: string;
  overlays: CanvasOverlay[];
}

export interface SequenceClip {
  id: string;
  mediaId: string;
  duration: number;
}

export interface MediaRecord {
  id: string;
  projectId: string;
  name: string;
  mimeType: string;
  kind: MediaKind;
  size: number;
  importedAt: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  source: Blob;
  thumbnail: Blob | null;
}

export interface ProjectBundle {
  format: 'byr-project';
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  exportedAt: string;
  project: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>;
  media: Array<Omit<MediaRecord, 'id' | 'projectId' | 'importedAt' | 'thumbnail' | 'source'> & { mediaKey: string; data: string }>;
}

export function createProject(name: string): Project {
  const now = Date.now();
  return {
    id: crypto.randomUUID(), schemaVersion: PROJECT_SCHEMA_VERSION, name: name.trim() || 'Untitled project', createdAt: now, updatedAt: now,
    mediaIds: [], selectedMediaId: null, canvasRatio: '9:16', photoEdits: {}, sequence: [],
  };
}

export function createPhotoEdit(): PhotoEdit {
  return { brightness: 0, contrast: 0, saturation: 0, temperature: 0, highlights: 0, shadows: 0, look: 'none', filterAmount: 70, zoom: 1, rotation: 0, flipHorizontal: false, fit: 'cover', backgroundColor: '#171916', overlays: [] };
}

export function isCanvasRatio(value: unknown): value is CanvasRatio {
  return value === '9:16' || value === '16:9' || value === '1:1' || value === '4:5';
}

export function sanitizePhotoEdit(value: unknown): PhotoEdit {
  const fallback = createPhotoEdit();
  if (!value || typeof value !== 'object') return fallback;
  const source = value as Partial<PhotoEdit>;
  const rawLayers: unknown[] = Array.isArray(source.overlays) ? source.overlays : [];
  const overlays: CanvasOverlay[] = rawLayers.slice(0, 100).flatMap<CanvasOverlay>((item) => {
    if (!item || typeof item !== 'object') return [];
    const layer = item as Record<string, unknown>;
    if (typeof layer.id !== 'string') return [];
    if (layer.kind === 'text' && typeof layer.text === 'string') return [{
      kind: 'text', id: layer.id.slice(0, 80), text: layer.text.slice(0, 100),
      x: clamp(layer.x, 0.02, 0.98, 0.5), y: clamp(layer.y, 0.02, 0.98, 0.76), size: clamp(layer.size, 16, 240, 56), color: safeColor(layer.color),
      opacity: clamp(layer.opacity, 0, 1, 1), font: layer.font === 'serif' || layer.font === 'mono' ? layer.font : 'sans', align: layer.align === 'left' || layer.align === 'right' ? layer.align : 'center',
    }];
    if (layer.kind === 'shape' && isShapeKind(layer.shape)) return [{
      kind: 'shape', id: layer.id.slice(0, 80), shape: layer.shape,
      x: clamp(layer.x, 0.02, 0.98, 0.5), y: clamp(layer.y, 0.02, 0.98, 0.5),
      width: clamp(layer.width, 0.08, 0.9, 0.35), height: clamp(layer.height, 0.04, 0.7, 0.12), color: safeColor(layer.color), opacity: clamp(layer.opacity, 0, 1, 0.8),
    }];
    return [];
  });
  return {
    brightness: clamp(source.brightness, -80, 80, 0), contrast: clamp(source.contrast, -60, 80, 0), saturation: clamp(source.saturation, -100, 100, 0),
    temperature: clamp(source.temperature, -100, 100, 0), highlights: clamp(source.highlights, -100, 100, 0), shadows: clamp(source.shadows, -100, 100, 0),
    look: ['warm', 'cool', 'mono', 'fade', 'overlay', 'burn', 'multiply', 'screen', 'soft-light'].includes(String(source.look)) ? source.look as PhotoEdit['look'] : 'none',
    filterAmount: clamp(source.filterAmount, 0, 100, 70),
    zoom: clamp(source.zoom, 1, 3, 1), rotation: [0, 90, 180, 270].includes(source.rotation ?? -1) ? source.rotation as PhotoEdit['rotation'] : 0,
    flipHorizontal: source.flipHorizontal === true, fit: source.fit === 'contain' ? 'contain' : 'cover',
    backgroundColor: safeColor(source.backgroundColor || fallback.backgroundColor), overlays,
  };
}

export function migrateProject(value: Project | Record<string, unknown>): Project {
  const legacy = value as Partial<Project>;
  const mediaIds = Array.isArray(legacy.mediaIds) ? legacy.mediaIds.filter((id): id is string => typeof id === 'string') : [];
  return {
    ...createProject(typeof legacy.name === 'string' ? legacy.name : 'Untitled project'),
    ...legacy,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    mediaIds,
    selectedMediaId: typeof legacy.selectedMediaId === 'string' ? legacy.selectedMediaId : null,
    canvasRatio: isCanvasRatio(legacy.canvasRatio) ? legacy.canvasRatio : '9:16',
    photoEdits: legacy.photoEdits && typeof legacy.photoEdits === 'object'
      ? Object.fromEntries(Object.entries(legacy.photoEdits).slice(0, 500).map(([id, edit]) => [id, sanitizePhotoEdit(edit)])) : {},
    sequence: Array.isArray(legacy.sequence)
      ? legacy.sequence.slice(0, 500).filter((clip) => clip && typeof clip.mediaId === 'string' && mediaIds.includes(clip.mediaId)).map((clip) => ({ id: typeof clip.id === 'string' ? clip.id : crypto.randomUUID(), mediaId: clip.mediaId, duration: clamp(clip.duration, 0.5, 120, 3) }))
      : mediaIds.map((mediaId) => ({ id: crypto.randomUUID(), mediaId, duration: 3 })),
  };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function safeColor(value: unknown): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff';
}

function isShapeKind(value: unknown): value is ShapeOverlay['shape'] {
  return value === 'rectangle' || value === 'ellipse' || value === 'frame' || value === 'line' || value === 'arrow' || value === 'star' || value === 'heart' || value === 'speech';
}
