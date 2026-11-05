import type Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { getHeadCommit } from '../core/gitstate/gitRunner.js';
import { applyIndexChanges, INDEX_SCHEMA_VERSION, indexRepository, indexRepositoryLocked, indexWaitBudgetMs, IndexingInProgress, withIndexLock } from './indexer.js';
import { readCandidate } from './walker.js';

const PATCH_LIMIT = 200;
const STAT_BATCH_SIZE = 128;
export type Refresh = 'fresh' | 'patched' | 'reindexed' | 'none';

function alive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid!, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function gitHeadPath(root: string): string | undefined {
  const direct = join(root, '.git', 'HEAD');
  if (existsSync(direct)) return direct;
  try {
    const gitDir = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(root, '.git'), 'utf8'))?.[1];
    return gitDir ? join(resolve(root, gitDir), 'HEAD') : undefined;
  } catch { return undefined; }
}
function backgroundLockPath(db: Database.Database, repoId: string): string {
  return `${db.name}.${createHash('sha1').update(repoId).digest('hex')}.background.lock`;
}

function startBackgroundIndex(db: Database.Database, repoId: string): void {
  if (db.name === ':memory:' || !process.argv[1] || !existsSync(process.argv[1])) return;
  const id = createHash('sha1').update(repoId).digest('hex');
  const writerLock = `${db.name}.${id}.index.lock`;
  try {
    const lock = JSON.parse(readFileSync(writerLock, 'utf8')) as { pid?: number };
    if (alive(lock.pid)) return;
  } catch { /* No active indexer. */ }

  const backgroundLock = backgroundLockPath(db, repoId);
  for (;;) {
    try { writeFileSync(backgroundLock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const lock = JSON.parse(readFileSync(backgroundLock, 'utf8')) as { pid?: number };
        if (alive(lock.pid)) return;
      } catch { /* A partial marker is replaced below. */ }
      rmSync(backgroundLock, { force: true });
    }
  }
  try {
    const child = spawn(process.execPath, [process.argv[1]!, 'index', repoId, '--force'], { cwd: dirname(resolve(process.argv[1]!)), detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => rmSync(backgroundLock, { force: true }));
    if (child.pid) writeFileSync(backgroundLock, JSON.stringify({ pid: child.pid, at: Date.now() }));
    child.unref();
  } catch (error) {
    rmSync(backgroundLock, { force: true });
    throw error;
  }
}

async function waitForBackgroundExit(db: Database.Database, repoId: string, deadline: number): Promise<void> {
  const lockPath = backgroundLockPath(db, repoId);
  while (Date.now() < deadline) {
    let pid: number | undefined;
    try { pid = (JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number }).pid; } catch { return; }
    if (!alive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  }
  throw new IndexingInProgress('The background index is still finishing.');
}

async function awaitIndex(db: Database.Database, repoId: string, root: string): Promise<void> {
  startBackgroundIndex(db, repoId);
  const waitMs = indexWaitBudgetMs();
  const deadline = Date.now() + waitMs;
  do {
    const state = db.prepare('SELECT active_generation FROM repo_index_state WHERE repo_id = ?').get(repoId) as { active_generation: number | null } | undefined;
    if (state?.active_generation != null) { await waitForBackgroundExit(db, repoId, deadline); return; }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  } while (true);
  throw new IndexingInProgress(`Indexing ${basename(root)} in the background; use grep for now or retry after it finishes.`);
}

/**
 * Bring the active index in line with the disk so a search never answers from stale files.
 * Modified and deleted files are found by stat and patched in place; directory snapshots detect
 * structural and ignore-rule changes when `reindex` is set.
 */
export async function refreshIndex(db: Database.Database, repoId: string, root: string, options: { reindex: boolean }): Promise<Refresh> {
  const state = db.prepare('SELECT active_generation, schema_version FROM repo_index_state WHERE repo_id = ?').get(repoId) as { active_generation: number | null; schema_version: number } | undefined;
  if (state?.active_generation == null) {
    if (!options.reindex) return 'none';
    if (db.name === ':memory:') { await indexRepository(db, repoId, root); return 'reindexed'; }
    await awaitIndex(db, repoId, root);
    return 'reindexed';
  }
  const refreshed = await withIndexLock(db, repoId, () => refreshIndexLocked(db, repoId, root, options), indexWaitBudgetMs());
  // Re-read: the refresh may have swapped the active generation, and the old id has no reference rows.
  const active = (db.prepare('SELECT active_generation FROM repo_index_state WHERE repo_id = ?').get(repoId) as { active_generation: number | null } | undefined)?.active_generation;
  if (options.reindex && db.name !== ':memory:' && active != null && !db.prepare('SELECT 1 FROM reference_index_generations WHERE generation_id = ?').get(active)) startBackgroundIndex(db, repoId);
  return refreshed;
}

async function refreshIndexLocked(db: Database.Database, repoId: string, root: string, options: { reindex: boolean }): Promise<Refresh> {
  const state = db.prepare('SELECT active_generation, schema_version, git_head AS gitHead FROM repo_index_state WHERE repo_id = ?').get(repoId) as { active_generation: number | null; schema_version: number; gitHead: string | null } | undefined;
  const generation = state?.active_generation;
  if (generation == null) return 'none';
  // Built by an older extractor: rebuild, or a new kind of symbol stays invisible until its file happens to change.
  if (options.reindex && state?.schema_version !== INDEX_SCHEMA_VERSION) { await indexRepositoryLocked(db, repoId, root, {}); return 'reindexed'; }
  const indexedHead = state?.gitHead ?? null;
  const completed = db.prepare('SELECT completed_at AS at FROM index_generations WHERE id = ?').get(generation) as { at: string | null } | undefined;
  const builtAt = completed?.at ? Date.parse(completed.at) : 0;
  const headFile = options.reindex ? gitHeadPath(root) : undefined;
  const headInfo = headFile ? await stat(headFile).catch(() => null) : null;
  const head = options.reindex && (indexedHead === null || (headInfo && headInfo.mtimeMs >= builtAt)) ? await getHeadCommit(root) : null;
  if (head && indexedHead !== null && indexedHead !== head) {
    await indexRepositoryLocked(db, repoId, root, { force: true });
    db.prepare('UPDATE repo_index_state SET git_head = ? WHERE repo_id = ?').run(head, repoId);
    return 'reindexed';
  }
  const rows = db.prepare('SELECT id, path, mtime_ms AS mtimeMs, size_bytes AS sizeBytes FROM files WHERE generation_id = ?').all(generation) as Array<{ id: number; path: string; mtimeMs: number; sizeBytes: number }>;
  const changed: Array<{ row: (typeof rows)[number]; info: { mtimeMs: number; size: number } }> = [];
  const gone: number[] = [];
  for (let offset = 0; offset < rows.length; offset += STAT_BATCH_SIZE) {
    await Promise.all(rows.slice(offset, offset + STAT_BATCH_SIZE).map(async (row) => {
      const info = await stat(join(root, row.path)).catch(() => null);
      if (!info) gone.push(row.id);
      else if (Math.round(info.mtimeMs) !== row.mtimeMs || info.size !== row.sizeBytes) changed.push({ row, info });
    }));
  }

  let structural = false;
  if (options.reindex) {
    const directories = db.prepare('SELECT path, mtime_ms AS mtimeMs, ignore_mtime_ms AS ignoreMtimeMs, ignore_size AS ignoreSize FROM index_directories WHERE generation_id = ?').all(generation) as Array<{ path: string; mtimeMs: number | null; ignoreMtimeMs: number | null; ignoreSize: number | null }>;
    if (!directories.length) structural = true;
    for (let offset = 0; offset < directories.length; offset += STAT_BATCH_SIZE) {
      await Promise.all(directories.slice(offset, offset + STAT_BATCH_SIZE).map(async (directory) => {
        const [info, ignore] = await Promise.all([
          stat(join(root, directory.path)).catch(() => null),
          stat(join(root, directory.path, '.gitignore')).catch(() => null),
        ]);
        if (!info || directory.mtimeMs === null || Math.round(info.mtimeMs) !== directory.mtimeMs || (ignore ? Math.round(ignore.mtimeMs) : null) !== directory.ignoreMtimeMs || (ignore?.size ?? null) !== directory.ignoreSize) structural = true;
      }));
    }
  }
  if (options.reindex && (structural || changed.length + gone.length > PATCH_LIMIT)) {
    await indexRepositoryLocked(db, repoId, root, { patchSmall: true });
    if (head) db.prepare('UPDATE repo_index_state SET git_head = ? WHERE repo_id = ?').run(head, repoId);
    return 'reindexed';
  }
  if (!changed.length && !gone.length) {
    if (head) db.prepare('UPDATE repo_index_state SET git_head = ? WHERE repo_id = ?').run(head, repoId);
    return 'fresh';
  }

  const parsed = await Promise.all(changed.map(async ({ row, info }) => ({ row, file: await readCandidate(join(root, row.path), row.path, info) })));
  const now = new Date().toISOString();
  db.transaction(() => {
    applyIndexChanges(db, repoId, generation, parsed.map(({ row, file }) => ({ path: row.path, file, oldId: row.id })), gone, now);
    db.prepare('UPDATE index_generations SET fingerprint = ? WHERE id = ?').run(`patched:${randomUUID()}`, generation);
  }).immediate();
  if (head) db.prepare('UPDATE repo_index_state SET git_head = ? WHERE repo_id = ?').run(head, repoId);
  return 'patched';
}
