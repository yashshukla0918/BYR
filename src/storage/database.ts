import { PROJECT_SCHEMA_VERSION, migrateProject, type MediaRecord, type Project } from '../domain/models';

const DATABASE_NAME = 'byr-local-workspace';
const DATABASE_VERSION = 1;
const PROJECTS_STORE = 'projects';
const MEDIA_STORE = 'media';
let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECTS_STORE)) {
        const store = database.createObjectStore(PROJECTS_STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!database.objectStoreNames.contains(MEDIA_STORE)) {
        const store = database.createObjectStore(MEDIA_STORE, { keyPath: 'id' });
        store.createIndex('projectId', 'projectId');
      }
    };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => { databasePromise = undefined; reject(request.error ?? new Error('Could not open local project storage.')); };
    request.onblocked = () => reject(new Error('Close another BYR tab to finish updating local storage.'));
  });
  return databasePromise;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Local storage transaction was cancelled.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not write to local storage.'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not read local project data.'));
  });
}

export async function listProjects(): Promise<Project[]> {
  const db = await openDatabase();
  const rows = await requestResult<Array<Project & { schemaVersion?: number }>>(db.transaction(PROJECTS_STORE).objectStore(PROJECTS_STORE).getAll());
  const projects = rows.map((row) => migrateProject(row));
  await Promise.all(projects.filter((_, index) => rows[index].schemaVersion !== PROJECT_SCHEMA_VERSION).map(saveProject));
  return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<Project | undefined> {
  const db = await openDatabase();
  const row = await requestResult<Project | undefined>(db.transaction(PROJECTS_STORE).objectStore(PROJECTS_STORE).get(id));
  if (!row) return undefined;
  const project = migrateProject(row);
  if (row.schemaVersion !== PROJECT_SCHEMA_VERSION) await saveProject(project);
  return project;
}

export async function saveProject(project: Project): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(PROJECTS_STORE, 'readwrite');
  tx.objectStore(PROJECTS_STORE).put(project);
  await transactionDone(tx);
}

export async function deleteProjectRecords(id: string): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction([PROJECTS_STORE, MEDIA_STORE], 'readwrite');
  const projects = tx.objectStore(PROJECTS_STORE);
  const media = tx.objectStore(MEDIA_STORE);
  projects.delete(id);
  const records = await requestResult<MediaRecord[]>(media.index('projectId').getAll(id));
  records.forEach(({ id: mediaId }) => media.delete(mediaId));
  await transactionDone(tx);
}

export async function clearWorkspaceRecords(): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction([PROJECTS_STORE, MEDIA_STORE], 'readwrite');
  tx.objectStore(PROJECTS_STORE).clear();
  tx.objectStore(MEDIA_STORE).clear();
  await transactionDone(tx);
}

export async function listProjectMedia(projectId: string): Promise<MediaRecord[]> {
  const db = await openDatabase();
  const rows = await requestResult<MediaRecord[]>(db.transaction(MEDIA_STORE).objectStore(MEDIA_STORE).index('projectId').getAll(projectId));
  return rows.sort((a, b) => b.importedAt - a.importedAt);
}

export async function getMedia(id: string): Promise<MediaRecord | undefined> {
  const db = await openDatabase();
  return requestResult(db.transaction(MEDIA_STORE).objectStore(MEDIA_STORE).get(id));
}

export async function addMediaRecords(project: Project, records: MediaRecord[]): Promise<Project> {
  const next = { ...project, mediaIds: [...project.mediaIds, ...records.map((record) => record.id)], updatedAt: Date.now() };
  const db = await openDatabase();
  const tx = db.transaction([PROJECTS_STORE, MEDIA_STORE], 'readwrite');
  records.forEach((record) => tx.objectStore(MEDIA_STORE).add(record));
  tx.objectStore(PROJECTS_STORE).put(next);
  await transactionDone(tx);
  return next;
}

export async function removeMediaRecord(project: Project, mediaId: string): Promise<Project> {
  const { [mediaId]: _removed, ...photoEdits } = project.photoEdits;
  const next = {
    ...project, mediaIds: project.mediaIds.filter((id) => id !== mediaId),
    selectedMediaId: project.selectedMediaId === mediaId ? null : project.selectedMediaId,
    photoEdits, sequence: project.sequence.filter((clip) => clip.mediaId !== mediaId), updatedAt: Date.now(),
  };
  const db = await openDatabase();
  const tx = db.transaction([PROJECTS_STORE, MEDIA_STORE], 'readwrite');
  tx.objectStore(MEDIA_STORE).delete(mediaId);
  tx.objectStore(PROJECTS_STORE).put(next);
  await transactionDone(tx);
  return next;
}

export async function replaceProjectAndMedia(project: Project, records: MediaRecord[]): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction([PROJECTS_STORE, MEDIA_STORE], 'readwrite');
  tx.objectStore(PROJECTS_STORE).put(project);
  records.forEach((record) => tx.objectStore(MEDIA_STORE).put(record));
  await transactionDone(tx);
}

export async function cloneProjectRecords(source: Project, target: Project): Promise<Project> {
  const records = await listProjectMedia(source.id);
  const cloned = records.map((record) => ({ ...record, id: crypto.randomUUID(), projectId: target.id, importedAt: Date.now() }));
  const project = { ...target, mediaIds: cloned.map((record) => record.id), selectedMediaId: null };
  await replaceProjectAndMedia(project, cloned);
  return project;
}
