import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getUserPaths, normalizeCanonicalPath } from '../config/paths.js';
import { loadConfig } from '../config/manager.js';
import { openDatabase } from '../storage/db.js';
import { migrate } from '../storage/migrator.js';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function ensureRepoOnboarded(cwd: string, options: { stateDir?: string; home?: string; cliPath?: string; spawnChild?: typeof spawn; spawnIndex?: boolean; allowProtected?: boolean; configPath?: string; tempDir?: string } = {}) {
  if (!(await loadConfig(options.configPath)).autoOnboard) return { onboarded: false, reason: 'disabled' };
  let root = resolve(cwd);
  while (!existsSync(join(root, '.git'))) { const parent = dirname(root); if (parent === root) return { onboarded: false, reason: 'not-git' }; root = parent; }
  const home = resolve(options.home ?? homedir()), paths = getUserPaths();
  const protectedPaths = [home, paths.state, paths.cache, options.tempDir ?? tmpdir()].map((path) => resolve(path));
  const normalize = (path: string) => resolve(path).replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
  const within = (path: string, base: string) => normalize(path) === normalize(base) || normalize(path).startsWith(`${normalize(base)}/`);
  if (!options.allowProtected && (root === dirname(root) || protectedPaths.some((p) => within(root, p)))) return { onboarded: false, reason: 'protected' };
  const rootPath = await normalizeCanonicalPath(root);
  const stateDir = options.stateDir ?? paths.state;
  const db = openDatabase(stateDir);
  try {
    migrate(db);
    const existing = db.prepare('SELECT id FROM repositories WHERE lower(root_path) = lower(?)').get(rootPath) as { id: string } | undefined;
    if (existing) return { onboarded: false, reason: 'registered', id: existing.id };
    const id = randomUUID(), now = new Date().toISOString(), name = basename(rootPath);
    db.prepare('INSERT INTO repositories (id, root_path, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(id, rootPath, name, now, now);
    const cli = options.cliPath ?? process.argv[1];
    if (cli && options.spawnIndex !== false) (options.spawnChild ?? spawn)(process.execPath, [cli, 'index', id], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { onboarded: true, id, rootPath };
  } finally { db.close(); }
}

/** Called by the detached index child (and MCP's first synchronous index), never by the hook. */
export async function indexWithinLimit(root: string, limit: number, db: ReturnType<typeof openDatabase>, repoId: string) {
  let note: string | null = null;
  try {
    const { stdout } = await run('git', ['ls-files', '-z'], { cwd: root, timeout: 1500, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    let count = 0;
    for (const file of stdout.split('\0')) if (file && ++count > limit) break;
    if (count > limit) note = `Index skipped: repository has more than ${limit} tracked files (limit ${limit}).`;
  } catch { note = 'Index skipped: tracked file count could not be completed within 1.5 seconds.'; }
  db.prepare('UPDATE repositories SET config_json = json_set(config_json, \'$.weftOnboardingNote\', ?) WHERE id = ?').run(note, repoId);
  return note;
}
