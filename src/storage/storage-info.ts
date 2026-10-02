export interface StorageInfo { usage: number | null; quota: number | null; persistent: boolean | null }

export async function getStorageInfo(): Promise<StorageInfo> {
  if (!navigator.storage?.estimate) return { usage: null, quota: null, persistent: null };
  const [estimate, persistent] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(null)]);
  return { usage: estimate.usage ?? null, quota: estimate.quota ?? null, persistent };
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Unavailable';
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
