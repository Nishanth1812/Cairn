import { statfsSync } from 'node:fs';
import { resolve } from 'node:path';

export class StorageFailure extends Error {
  readonly exitCode = 1;
}

export function isStorageError(error: unknown): boolean {
  if (error instanceof StorageFailure) return true;
  const code = (error as { code?: string })?.code ?? '';
  const systemCode = (error as { code?: string })?.code ?? '';
  return /^SQLITE_(FULL|READONLY|IOERR)/.test(code) || /^(ENOSPC|EROFS|EIO)$/.test(systemCode);
}

export function freeSpaceBytes(stateDir: string): number {
  const stats = statfsSync(stateDir);
  return stats.bavail * stats.bsize;
}

export function storageFailure(stateDir: string, error: unknown, neededBytes: number, availableBytes?: number): StorageFailure {
  if (error instanceof StorageFailure) return error;
  let free = availableBytes;
  if (free === undefined) {
    try { free = freeSpaceBytes(stateDir); } catch { /* Report an unknown free-space value when the path cannot be inspected. */ }
  }
  const code = (error as { code?: string })?.code;
  const reason = code ? `${code}: ` : '';
  const available = free === undefined ? 'unknown' : formatBytes(free);
  return new StorageFailure(
    `Storage error in Cairn state directory ${resolve(stateDir)} (${reason}${error instanceof Error ? error.message : String(error)}). Free: ${available}; estimated needed: about ${formatBytes(neededBytes)}. Free disk space, run \`cairn waymark clean --scope indexes --yes\`, or set a smaller maxTrackedFiles, then retry.`,
    { cause: error },
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  const mib = bytes / (1024 * 1024);
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(mib / 1024).toFixed(1)} GiB`;
}
