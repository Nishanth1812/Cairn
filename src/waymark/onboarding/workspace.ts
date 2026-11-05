import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../storage/db.js';
import { migrate } from '../storage/migrator.js';
import { ensureRepoOnboarded } from './auto.js';

export interface WorkspaceRepo { id: string; rootPath: string; name: string }

const SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'vendor']);

/** Git repositories at most two folders below `dir` (a workspace like Projects/App/{frontend,backend}); stops descending at the first `.git`. */
export function findChildGitRepos(dir: string, depth = 2): string[] {
  if (depth < 1) return [];
  let names: string[];
  try { names = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)).map((entry) => entry.name); } catch { return []; }
  return names.flatMap((name) => {
    const child = join(dir, name);
    return existsSync(join(child, '.git')) ? [child] : findChildGitRepos(child, depth - 1);
  });
}

/** Registers every child repo of a non-git folder (indexing runs in a detached child) and returns the registered rows. */
export async function onboardWorkspace(db: Database.Database, dir: string, options: { spawnIndex?: boolean } = {}): Promise<WorkspaceRepo[]> {
  const found: WorkspaceRepo[] = [];
  for (const child of findChildGitRepos(dir).slice(0, 12)) {
    // The registered row is found by the id onboarding returns: its root_path is the canonical path, which can differ from `child` (symlinks, 8.3 short names).
    const onboarded = await ensureRepoOnboarded(child, { spawnIndex: options.spawnIndex });
    const row = 'id' in onboarded ? db.prepare('SELECT id, root_path AS rootPath, display_name AS name FROM repositories WHERE id = ?').get(onboarded.id) as WorkspaceRepo | undefined : undefined;
    if (row) found.push(row);
  }
  return found;
}

/** One-line session-start note for a non-git folder that holds repos; empty when it holds none. */
export async function workspaceHint(dir: string, stateDir: string): Promise<string> {
  if (!findChildGitRepos(dir).length) return '';
  const db = openDatabase(stateDir);
  try {
    migrate(db);
    const repos = await onboardWorkspace(db, dir);
    return repos.length ? `Workspace of ${repos.length} repos (${repos.map((repo) => repo.name).join(', ')}). Run cairn context "<question>" inside each repo before Grep/Glob/Read.` : '';
  } finally { db.close(); }
}
