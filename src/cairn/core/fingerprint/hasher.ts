import { createHash } from 'node:crypto';
import type { WorkingTreeStatus } from '../gitstate/gitRunner.js';

export function hashBytes(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function hashString(str: string): string {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

export function orderedFingerprint(parts: (string | number | boolean | null | undefined)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const value = part === null ? 'null' : part === undefined ? 'undefined' : `${typeof part}:${String(part)}`;
    hash.update(`${Buffer.byteLength(value, 'utf8')}:`);
    hash.update(value, 'utf8');
  }
  return hash.digest('hex');
}

export function computeWorkingTreeFingerprint(status: WorkingTreeStatus, headSha: string, branch: string): string {
  return orderedFingerprint([
    headSha,
    branch,
    ...[...status.staged].sort(),
    ...[...status.unstaged].sort(),
    ...[...status.untracked].sort(),
  ]);
}
