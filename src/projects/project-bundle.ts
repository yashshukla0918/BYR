import { PROJECT_SCHEMA_VERSION, createPhotoEdit, createProject, isCanvasRatio, sanitizePhotoEdit, type MediaRecord, type Project, type ProjectBundle } from '../domain/models';
import { prepareMediaFiles } from '../media/media-service';
import { listProjectMedia, replaceProjectAndMedia } from '../storage/database';

const MAX_BUNDLE_SIZE = 170 * 1024 * 1024;
const MAX_SOURCE_MEDIA_SIZE = 120 * 1024 * 1024;

export async function exportProjectBundle(project: Project): Promise<void> {
  const storedMedia = await listProjectMedia(project.id);
  const sourceBytes = storedMedia.reduce((total, record) => total + record.source.size, 0);
  if (sourceBytes > MAX_SOURCE_MEDIA_SIZE) throw new Error('Project packages can include up to 120 MB of source media. Remove some files or export a smaller project copy.');
  const media: ProjectBundle['media'] = [];
  for (const record of storedMedia) {
    media.push({
      mediaKey: record.id,
      name: record.name, mimeType: record.mimeType, kind: record.kind, size: record.size,
      width: record.width, height: record.height, duration: record.duration,
      data: await blobToBase64(record.source),
    });
  }
  const bundle: ProjectBundle = {
    format: 'byr-project', schemaVersion: PROJECT_SCHEMA_VERSION, exportedAt: new Date().toISOString(),
    project: {
      schemaVersion: PROJECT_SCHEMA_VERSION, name: project.name, mediaIds: storedMedia.map((record) => record.id), selectedMediaId: project.selectedMediaId,
      canvasRatio: project.canvasRatio, photoEdits: project.photoEdits, sequence: project.sequence,
    }, media,
  };
  download(new Blob([JSON.stringify(bundle)], { type: 'application/json' }), `${safeFilename(project.name)}.byr`);
}

export async function importProjectBundle(file: File): Promise<Project> {
  if (file.size > MAX_BUNDLE_SIZE) throw new Error('Project packages must be smaller than 170 MB.');
  let bundle: unknown;
  try { bundle = JSON.parse(await file.text()); } catch { throw new Error('This file is not a valid BYR project package.'); }
  if (!isProjectBundle(bundle)) throw new Error('This project package is incomplete or uses an unsupported version.');

  const project = createProject(bundle.project.name);
  const records: MediaRecord[] = [];
  const restoredIds = new Map<string, string>();
  for (const [index, item] of bundle.media.entries()) {
    const blob = base64ToBlob(item.data, item.mimeType);
    const imported = new File([blob], item.name, { type: item.mimeType });
    const result = await prepareMediaFiles(project.id, [imported]);
    if (result.records.length !== 1) throw new Error(`Could not restore “${item.name}”: ${result.rejected[0]?.reason ?? 'unsupported media'}.`);
    records.push(result.records[0]);
    restoredIds.set(item.mediaKey || `legacy-${index}`, result.records[0].id);
  }
  const photoEdits = Object.fromEntries(Object.entries(bundle.project.photoEdits ?? {}).flatMap(([oldId, edit]) => restoredIds.has(oldId) ? [[restoredIds.get(oldId)!, sanitizePhotoEdit(edit)]] : []));
  const sequence = (bundle.project.sequence ?? []).slice(0, 500).flatMap((clip) => {
    const mediaId = restoredIds.get(clip.mediaId);
    return mediaId ? [{ ...clip, id: crypto.randomUUID(), mediaId, duration: Math.max(0.5, Math.min(120, Number.isFinite(clip.duration) ? clip.duration : 3)) }] : [];
  });
  const next: Project = {
    ...project,
    name: bundle.project.name,
    mediaIds: records.map((record) => record.id),
    selectedMediaId: restoredIds.get(bundle.project.selectedMediaId ?? '') ?? records[0]?.id ?? null,
    canvasRatio: isCanvasRatio(bundle.project.canvasRatio) ? bundle.project.canvasRatio : '9:16',
    photoEdits: { ...Object.fromEntries(records.map((record) => [record.id, createPhotoEdit()])), ...photoEdits },
    sequence: sequence.length ? sequence : records.map((record) => ({ id: crypto.randomUUID(), mediaId: record.id, duration: record.kind === 'image' ? 3 : Math.min(30, record.duration ?? 5) })),
  };
  await replaceProjectAndMedia(next, records);
  return next;
}

function isProjectBundle(value: unknown): value is ProjectBundle {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { format?: string; schemaVersion?: number; project?: { name?: unknown }; media?: Array<{ name?: unknown; mimeType?: unknown; data?: unknown }> };
  return candidate.format === 'byr-project' && (candidate.schemaVersion === PROJECT_SCHEMA_VERSION || candidate.schemaVersion === 1)
    && !!candidate.project && typeof candidate.project.name === 'string' && Array.isArray(candidate.media)
    && candidate.media.every((item) => item && typeof item.name === 'string' && typeof item.mimeType === 'string' && typeof item.data === 'string')
    && candidate.media.reduce((total, item) => total + Math.floor((item.data as string).length * 0.75), 0) <= MAX_SOURCE_MEDIA_SIZE;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read project media.'));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(value: string, mimeType: string): Blob {
  const binary = atob(value);
  const chunks: ArrayBuffer[] = [];
  for (let offset = 0; offset < binary.length; offset += 0x8000) {
    const slice = binary.slice(offset, offset + 0x8000);
    const buffer = new ArrayBuffer(slice.length);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < slice.length; index += 1) bytes[index] = slice.charCodeAt(index);
    chunks.push(buffer);
  }
  return new Blob(chunks, { type: mimeType });
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(name: string): string {
  return name.trim().replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'byr-project';
}
