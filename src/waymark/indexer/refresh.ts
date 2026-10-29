import type Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { indexRepository, storeFile } from './indexer.js';
import { readCandidate } from './walker.js';

const PATCH_LIMIT = 200;

export type Refresh = 'fresh' | 'patched' | 'reindexed' | 'none';

/**
 * Bring the active index in line with the disk so a search never answers from stale files.
 * Modified and deleted files are found by stat and patched in place (milliseconds); a new or removed file
 * shows up as a directory newer than the index and, when `reindex` is set, triggers the incremental index.
 * shortcut: new files are detected through directory mtimes, so a file created without touching its directory is missed until the next index.
 */
export async function refreshIndex(db: Database.Database, repoId: string, root: string, options: { reindex: boolean }): Promise<Refresh> {
  const state = db.prepare('SELECT active_generation FROM repo_index_state WHERE repo_id = ?').get(repoId) as { active_generation: number | null } | undefined;
  const generation = state?.active_generation;
  if (generation == null) {
    if (!options.reindex) return 'none';
    await indexRepository(db, repoId, root);
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
    await indexRepository(db, repoId, root);
    return 'reindexed';
  }
  if (!changed.length && !gone.length) return 'fresh';

  const parsed = await Promise.all(changed.map(async ({ row, info }) => ({ row, file: await readCandidate(join(root, row.path), row.path, info) })));
  const now = new Date().toISOString();
  db.transaction(() => {
    const remove = db.prepare('DELETE FROM files WHERE id = ?');
    for (const id of gone) remove.run(id);
    for (const { row, file } of parsed) {
      remove.run(row.id);
      if (file) storeFile(db, repoId, generation, file, now);
    }
  }).immediate();
  return 'patched';
}
