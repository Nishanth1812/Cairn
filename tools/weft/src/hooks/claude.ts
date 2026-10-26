import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getUserPaths } from '../config/paths.js';
import { openDatabase } from '../storage/db.js';
import { migrate } from '../storage/migrator.js';
import { latestVerification, resumeTask, saveCheckpoint } from '../memory/taskManager.js';
import { runGit, type WorkingTreeStatus } from '../core/gitstate/gitRunner.js';
import { computeWorkingTreeFingerprint } from '../core/fingerprint/hasher.js';
import { estimateTokens } from '../core/estimate/tokenEstimator.js';
import { redactSafe } from '../core/security/redactor.js';
import { runHookSafely } from '../integrations/claude-code/index.js';
import type Database from 'better-sqlite3';

const MARKER = 'weft-hook';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'PreCompact'] as const;
type Event = typeof EVENTS[number];
type GitState = (root: string, kind: 'status' | 'head') => Promise<WorkingTreeStatus | string | null>;
export async function hookGitRoot(cwd: string): Promise<string | null> {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}
// One `git status` spawn (~100ms on Windows) yields branch, HEAD and changes; memoised per root so status+head share it.
const realGitState: GitState = (() => {
  const cache = new Map<string, Promise<{ status: WorkingTreeStatus; head: string | null } | null>>();
  const load = (root: string) => {
    let hit = cache.get(root);
    if (!hit) {
      hit = runGit(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { timeoutMs: 300 }).then((result) => {
        if (result.exitCode !== 0) return null;
        const staged: string[] = [], unstaged: string[] = [], untracked: string[] = [];
        let branch = 'HEAD', head: string | null = null;
        const entries = result.stdout.split('\0');
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]!;
          if (entry.startsWith('# branch.oid ')) { const oid = entry.slice(13); head = oid === '(initial)' ? null : oid; }
          else if (entry.startsWith('# branch.head ')) { const name = entry.slice(14); branch = name === '(detached)' ? 'HEAD' : name; }
          else if (entry.startsWith('? ')) untracked.push(entry.slice(2));
          else if (entry[0] === '1' || entry[0] === '2' || entry[0] === 'u') {
            const x = entry[2] ?? '.', y = entry[3] ?? '.';
            if (x !== '.') staged.push(entry.split(' ').slice(entry[0] === '1' ? 8 : entry[0] === '2' ? 9 : 10).join(' '));
            if (y !== '.' && x === '.') unstaged.push(entry.split(' ').slice(entry[0] === '1' ? 8 : entry[0] === '2' ? 9 : 10).join(' '));
            if (entry[0] === '2') i++;
          }
        }
        return { status: { staged, unstaged, untracked, branch, clean: !staged.length && !unstaged.length && !untracked.length }, head };
      }).catch(() => null);
      cache.set(root, hit);
    }
    return hit;
  };
  return async (root, kind) => { const state = await load(root); return kind === 'head' ? state?.head ?? null : state?.status ?? null; };
})();
const samePath = (a: string, b: string) => resolve(a).replace(/\\/g, '/').toLowerCase() === resolve(b).replace(/\\/g, '/').toLowerCase();

// Starts the memoised git call now so it runs while the caller opens the database and checks onboarding.
export function prefetchGitState(cwd: string): void {
  void hookGitRoot(cwd).then((root) => root && realGitState(root, 'status')).catch(() => undefined);
}

function dbAt(stateDir: string): Database.Database { const db = openDatabase(stateDir); migrate(db); return db; }
export function repoFor(db: Database.Database, cwd: string) {
  return db.prepare('SELECT id, root_path AS rootPath, display_name AS name FROM repositories').all()
    .find((repo) => samePath((repo as { rootPath: string }).rootPath, cwd)) as { id: string; rootPath: string; name: string } | undefined;
}
function latestTask(db: Database.Database, repoId: string) {
  return db.prepare("SELECT id, title FROM tasks WHERE repo_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1").get(repoId) as { id: string; title: string } | undefined;
}

export async function runSessionStartHook(options: { cwd?: string; stateDir: string; gitState?: GitState; gitRoot?: (cwd: string) => Promise<string | null>; writeIndexMarker?: boolean; disableDetachedIndex?: boolean; budgetMs?: number } ): Promise<string> {
  const result = await runHookSafely(async () => {
    const cwd = resolve(options.cwd ?? process.cwd());
    const root = await (options.gitRoot ?? hookGitRoot)(cwd);
    if (!root) return '';
    const db = dbAt(options.stateDir);
    try {
      const repo = repoFor(db, root);
      if (!repo) return '';
      const git = options.gitState ?? realGitState;
      const [status, head] = await Promise.all([git(root, 'status'), git(root, 'head')]);
      if (!status || typeof status === 'string') return '';
      const headId = typeof head === 'string' ? head : '';
      const marker = join(options.stateDir, `hook-head-${createHash('sha1').update(repo.id).digest('hex')}`);
      const previousHead = existsSync(marker) ? await readFile(marker, 'utf8').catch(() => '') : '';
      // Reindex in a detached child: awaiting it here kept the hook alive ~500ms on every session start.
      if (headId && previousHead !== headId && options.writeIndexMarker !== false && !options.disableDetachedIndex && process.argv[1]) {
        spawn(process.execPath, [process.argv[1], 'index', repo.id], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        await writeFile(marker, headId, 'utf8').catch(() => undefined);
      }
      const fingerprint = computeWorkingTreeFingerprint(status, headId, status.branch);
      const task = latestTask(db, repo.id);
      let lines = [`Repo ${repo.name} | ${status.branch} | ${status.clean ? 'clean' : `dirty: ${status.staged.length + status.unstaged.length + status.untracked.length} files`}`];
      if (task) {
        const resumed = resumeTask(db, task.id, fingerprint);
        const checkpoint = resumed.checkpoint;
        if (checkpoint) {
          const objective = (checkpoint.objective || task.title).replace(/\s+/g, ' ').slice(0, 100);
          lines.push(`Resume: ${redactSafe(objective)}${resumed.isStale ? ' (stale)' : ''}`);
          if (checkpoint.nextAction) lines.push(`Next: ${redactSafe(checkpoint.nextAction.replace(/\s+/g, ' ').slice(0, 100))}`);
          const verification = latestVerification(db, task.id);
          if (verification) lines.push(`Tests: ${verification.exitCode === 0 ? 'passed' : `FAILED (exit ${verification.exitCode})`} ${verification.command.slice(0, 100)}`);
          const checkpointFiles = checkpoint.decisions.flatMap((decision) => {
            try { const parsed = JSON.parse(decision) as { changedFiles?: string[] }; return parsed.changedFiles ?? []; } catch { return []; }
          });
          const files = [...new Set([...status.staged, ...status.unstaged, ...status.untracked, ...checkpointFiles])].slice(0, 3);
          if (files.length) lines.push(`Files: ${files.join(', ')}`);
        }
      }
      lines.push('Explore code with mcp__weft__weft_context / weft_search (load via ToolSearch if deferred) before Grep/Glob/Read; weft_read for line ranges.');
      let output = lines.join('\n');
      while (estimateTokens(output) > 400) { output = lines.slice(0, -1).join('\n') + '\n' + lines.at(-1); if (lines.length <= 1) break; lines.splice(1, 1); }
      return redactSafe(output);
    } finally { db.close(); }
  }, options.budgetMs ?? 430, options.budgetMs ?? 499).catch(() => undefined);
  return typeof result === 'string' ? result : '';
}

export async function runCheckpointHook(options: { cwd?: string; stateDir: string; gitState?: GitState; gitRoot?: (cwd: string) => Promise<string | null>; budgetMs?: number }): Promise<void> {
  await runHookSafely(async () => {
    try {
      const cwd = resolve(options.cwd ?? process.cwd());
      const root = await (options.gitRoot ?? hookGitRoot)(cwd);
      if (!root) return;
      const db = dbAt(options.stateDir);
      try {
        const repo = repoFor(db, root); if (!repo) return;
        const task = latestTask(db, repo.id); if (!task) return;
        const git = options.gitState ?? realGitState;
        const [status, head] = await Promise.all([git(root, 'status'), git(root, 'head')]);
        if (!status || typeof status === 'string') return;
        const headId = typeof head === 'string' ? head : '';
        const fingerprint = computeWorkingTreeFingerprint(status, headId, status.branch);
        const previous = db.prepare('SELECT working_tree_fingerprint AS fingerprint, revision FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(task.id) as { fingerprint: string; revision: string | null } | undefined;
        if (previous?.fingerprint === fingerprint && previous.revision === headId) return;
        const changedFiles = [...new Set([...status.staged, ...status.unstaged, ...status.untracked])];
        const verification = latestVerification(db, task.id);
        const details = redactSafe(JSON.stringify({ branch: status.branch, changedFiles, lastCommit: headId }));
        saveCheckpoint(db, { taskId: task.id, workingTreeFingerprint: fingerprint, revision: headId, objective: '', status: 'active', findings: [], decisions: [details], verification: verification ? [{ command: verification.command, result: verification.exitCode === 0 ? 'passed' : `failed (exit ${verification.exitCode})`, at: verification.ranAt }] : [], nextAction: '' });
      } finally { db.close(); }
    } catch (error) { await logHookFailure(options.stateDir, error); }
  }, options.budgetMs ?? 430, options.budgetMs ?? 499);
}

export async function logHookFailure(stateDir: string, error: unknown): Promise<void> {
  try {
    await mkdir(stateDir, { recursive: true });
    const path = join(stateDir, 'hooks.log');
    const line = `${new Date().toISOString()} ${redactSafe(error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ')}\n`;
    const size = await stat(path).then(info => info.size, () => 0);
    if (size + Buffer.byteLength(line) > 200 * 1024) {
      await rename(path, `${path}.1`).catch(() => undefined);
      await writeFile(`${path}.1`, (await readFile(`${path}.1`).catch(() => Buffer.alloc(0))).subarray(-100 * 1024));
    }
    await appendFile(path, line, 'utf8');
  } catch { /* Hook diagnostics must never interrupt the host session. */ }
}

type Settings = { hooks?: Partial<Record<Event, Array<{ matcher?: string; hooks?: Array<Record<string, unknown>> }>>>; [key: string]: unknown };
function hookEntry(event: Event, bin: string) { return { matcher: event === 'PreToolUse' ? 'Read' : '', hooks: [{ type: 'command', command: `${bin} hook ${event === 'SessionStart' ? 'session-start' : event === 'UserPromptSubmit' ? 'user-prompt-submit' : event === 'PreToolUse' ? 'pre-tool-use' : event === 'Stop' ? 'stop' : 'pre-compact'} # ${MARKER}` }] }; }
function isWeftHook(hook: Record<string, unknown>) { return typeof hook.command === 'string' && hook.command.includes(`# ${MARKER}`); }
export async function installClaudeHooks(options: { projectRoot?: string; home?: string; global?: boolean; dryRun?: boolean; bin?: string } = {}) {
  const path = options.global ? join(options.home ?? homedir(), '.claude', 'settings.json') : join(options.projectRoot ?? process.cwd(), '.claude', 'settings.json');
  let settings: Settings = {};
  try { settings = JSON.parse(await readFile(path, 'utf8')) as Settings; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const updated: Settings = { ...settings, hooks: { ...settings.hooks } };
  for (const event of EVENTS) {
    const entries = [...(updated.hooks?.[event] ?? [])];
    const cleaned = entries.map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((hook) => !isWeftHook(hook)) })).filter((entry) => (entry.hooks ?? []).length);
    cleaned.push(hookEntry(event, options.bin ?? 'weft'));
    updated.hooks![event] = cleaned;
  }
  const content = `${JSON.stringify(updated, null, 2)}\n`;
  const before = await readFile(path, 'utf8').catch(() => '');
  const modified = before !== content;
  if (modified && !options.dryRun) { await mkdir(join(path, '..'), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, content, 'utf8'); await rename(temp, path); }
  return { path, modified, dryRun: !!options.dryRun };
}

export async function uninstallClaudeHooks(options: { projectRoot?: string; home?: string; global?: boolean; dryRun?: boolean } = {}) {
  const path = options.global ? join(options.home ?? homedir(), '.claude', 'settings.json') : join(options.projectRoot ?? process.cwd(), '.claude', 'settings.json');
  let settings: Settings;
  try { settings = JSON.parse(await readFile(path, 'utf8')) as Settings; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, modified: false }; throw error; }
  const hooks = { ...settings.hooks };
  let modified = false;
  for (const event of EVENTS) {
    const entries = hooks[event] ?? [];
    hooks[event] = entries.map((entry) => {
      const kept = (entry.hooks ?? []).filter((hook) => !isWeftHook(hook));
      if (kept.length !== (entry.hooks ?? []).length) modified = true;
      return { ...entry, hooks: kept };
    }).filter((entry) => (entry.hooks ?? []).length);
  }
  if (modified && !options.dryRun) { const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`, 'utf8'); await rename(temp, path); }
  return { path, modified };
}

export function hookStateDir() { return process.env.WEFT_STATE_DIR ?? getUserPaths().state; }
export function hookSettingsRoot() { return process.cwd(); }
