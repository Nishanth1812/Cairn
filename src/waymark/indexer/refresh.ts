import type Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { getHeadCommit } from '../core/gitstate/gitRunner.js';
import { INDEX_SCHEMA_VERSION, indexRepository, indexRepositoryLocked, indexWaitBudgetMs, IndexingInProgress, populateReferenceSites, storeFile, withIndexLock } from './indexer.js';
import { readCandidate } from './walker.js';

const PATCH_LIMIT = 200;
export type Refresh = 'fresh' | 'patched' | 'reindexed' | 'none';

function alive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid!, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
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
    const child = spawn(process.execPath, [process.argv[1]!, 'index', repoId], { cwd: dirname(resolve(process.argv[1]!)), detached: true, stdio: 'ignore', windowsHide: true });
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
 * Modified and deleted files are found by stat and patched in place (milliseconds); a new or removed file
 * shows up as a directory newer than the index and, when `reindex` is set, triggers the incremental index.
 * shortcut: new files are detected through directory mtimes, so a file created without touching its directory is missed until the next index.
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
  if (options.reindex && db.name !== ':memory:' && !db.prepare('SELECT 1 FROM reference_index_generations WHERE generation_id = ?').get(state.active_generation)) startBackgroundIndex(db, repoId);
  return refreshed;
}

async function refreshIndexLocked(db: Database.Database, repoId: string, root: string, options: { reindex: boolean }): Promise<Refresh> {
  const state = db.prepare('SELECT active_generation, schema_version, git_head AS gitHead FROM repo_index_state WHERE repo_id = ?').get(repoId) as { active_generation: number | null; schema_version: number; gitHead: string | null } | undefined;
  const generation = state?.active_generation;
  if (generation == null) return 'none';
  // Built by an older extractor: rebuild, or a new kind of symbol stays invisible until its file happens to change.
  if (options.reindex && state?.schema_version !== INDEX_SCHEMA_VERSION) { await indexRepositoryLocked(db, repoId, root, {}); return 'reindexed'; }
  const head = options.reindex ? await getHeadCommit(root) : null;
  const indexedHead = state?.gitHead ?? null;
  if (head && indexedHead !== null && indexedHead !== head) {
    await indexRepositoryLocked(db, repoId, root, { force: true });
    db.prepare('UPDATE repo_index_state SET git_head = ? WHERE repo_id = ?').run(head, repoId);
    return 'reindexed';
  }
  const rows = db.prepare('SELECT id, path, mtime_ms AS mtimeMs, size_bytes AS sizeBytes FROM files WHERE generation_id = ?').all(generation) as Array<{ id: number; path: string; mtimeMs: number; sizeBytes: number }>;
  const completed = db.prepare('SELECT completed_at AS at FROM index_generations WHERE id = ?').get(generation) as { at: string | null } | undefined;
  const builtAt = completed?.at ? Date.parse(completed.at) : 0;

  const changed: Array<{ row: (typeof rows)[number]; info: { mtimeMs: number; size: number } }> = [];
  const gone: number[] = [];
  await Promise.all(rows.map(async (row) => {
    const info = await stat(join(root, row.path)).catch(() => null);
    if (!info) gone.push(row.id);
    else if (Math.round(info.mtimeMs) !== row.mtimeMs || info.size !== row.sizeBytes) changed.push({ row, info });
  }));

  let structural = false;
  // shortcut: any create/delete/rename in an indexed directory forces one full rebuild (a process that makes a directory per run rebuilds per run), upgrade to comparing directory listings.
  if (options.reindex) {
    const directories = [...new Set(rows.map((row) => dirname(row.path)))];
    await Promise.all(directories.map(async (directory) => {
      const info = await stat(join(root, directory)).catch(() => null);
      if (!info || info.mtimeMs > builtAt) structural = true;
    }));
  }
  if (options.reindex && (structural || changed.length + gone.length > PATCH_LIMIT)) {
    await indexRepositoryLocked(db, repoId, root, {});
    if (head) db.prepare('UPDATE repo_index_state SET git_head = ? WHERE repo_id = ?').run(head, repoId);
    return 'reindexed';
  }
  if (!changed.length && !gone.length) {
    if (head) db.prepare('UPDATE repo_index_state SET git_head = ? WHERE repo_id = ?').run(head, repoId);
    return 'fresh';
  }

  const parsed = await Promise.all(changed.map(async ({ row, info }) => ({ row, file: await readCandidate(join(root, row.path), row.path, info) })));
  const now = new Date().toISOString();
  const prepared = {
    file: db.prepare('INSERT INTO files (repo_id, generation_id, path, content_hash, mtime_ms, size_bytes, language, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    symbol: db.prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)'),
    chunk: db.prepare('INSERT INTO chunks (file_id, ordinal, start_line, end_line, content_hash, safe_text, search_extra, token_estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    meta: db.prepare('INSERT INTO file_search_meta(file_id, path_text, symbol_text) VALUES (?, ?, ?)'),
  };
  db.transaction(() => {
    const remove = db.prepare('DELETE FROM files WHERE id = ?');
    for (const id of gone) remove.run(id);
    for (const { row, file } of parsed) {
      remove.run(row.id);
      if (file) storeFile(db, repoId, generation, file, now, prepared);
    }
    if (db.prepare('SELECT 1 FROM reference_index_generations WHERE generation_id = ?').get(generation)) populateReferenceSites(db, generation, parsed.map(({ row }) => row.path));
  }).immediate();
  if (head) db.prepare('UPDATE repo_index_state SET git_head = ? WHERE repo_id = ?').run(head, repoId);
  return 'patched';
}
