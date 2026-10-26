import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, delimiter, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getUserPaths } from '../../config/paths.js';
import { loadConfig, saveConfig } from '../../config/manager.js';
import { setupWeft } from '../../integrations/setup.js';
import { createTask, resumeTask, saveCheckpoint } from '../../memory/taskManager.js';
import { checkRepoHealth, type HealthReport } from '../../health/healthChecker.js';
import { generatePortfolioSummary } from '../../health/portfolio.js';
import { indexRepository } from '../../indexer/indexer.js';
import { packContext } from '../../context/packer.js';
import { searchChunks } from '../../context/search.js';
import { rankCandidates } from '../../context/ranker.js';
import { parseIntent, generateDefaultIntent } from '../../core/intents/intentParser.js';
import { getGitRoot, getHeadCommit, getWorkingTreeStatus } from '../../core/gitstate/gitRunner.js';
import { computeWorkingTreeFingerprint } from '../../core/fingerprint/hasher.js';
import { normalizeCanonicalPath } from '../../config/paths.js';
import { fuzzyFindRepo } from '../../core/registry/repoRegistry.js';
import { onboardWorkspace } from '../../onboarding/workspace.js';
import { createWorkspaceHandler } from '../../mcp/workspace.js';
import { syncClaudeInstructions, CLAUDE_CODE_GUIDELINES, installClaudeHooks, uninstallClaudeHooks } from '../../integrations/claude-code/index.js';
import { runHookCommand } from '../hookCommand.js';
import { syncCodexInstructions, CODEX_GUIDELINES } from '../../integrations/codex/index.js';
import { checkInstructions } from '../../integrations/instructions.js';
import { getCacheDiagnostics, getCostSummary, listSessions } from '../../telemetry/analytics.js';
import { getStats } from '../../telemetry/stats.js';
import { ingestTranscripts } from '../../telemetry/transcripts.js';
import { migrateDevPulse } from '../../migration/devpulse/migrator.js';
import { openDatabase, repairCorruptDatabase } from '../../storage/db.js';
import { migrate } from '../../storage/migrator.js';
import type Database from 'better-sqlite3';
import { installMcpConfig, type Harness } from '../../integrations/mcpConfig.js';
import { checkIntegrations } from '../../integrations/doctor.js';
import { findMcpRepo, serveMcp } from '../../mcp/server.js';
import { runRetrievalBenchmark } from '../../bench/retrieval.js';
import { loadSuite, runLiveSuite } from '../../bench/live.js';
import { ensureRepoOnboarded, indexWithinLimit } from '../../onboarding/auto.js';
import { runVerification } from '../../verification/runner.js';
import { suggestChecks } from '../../verification/suggest.js';
import { recordVerification } from '../../memory/taskManager.js';

type Result = { code: number; data?: unknown; warnings?: string[]; errors?: string[]; status?: string };
class CommandError extends Error { constructor(message: string, readonly exitCode: number) { super(message); } }
function fail(message: string, code: number): never { throw new CommandError(message, code); }
const paths = getUserPaths();
const dbFile = join(paths.state, 'weft.db');

function database(required = true): Database.Database {
  if (required && !existsSync(dbFile)) fail('Weft is not initialized. Run `weft init` first.', 3);
  const db = openDatabase(paths.state);
  try { migrate(db); } catch (error) { db.close(); throw error; }
  return db;
}

function option(args: string[], name: string, fallback?: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`, 2);
  return value;
}
function positional(args: string[]): string[] {
  const values: string[] = [];
  const valued = new Set(['--name', '--limit', '--budget', '--scope', '--since', '--source']);
  for (let i = 0; i < args.length; i++) {
    if (valued.has(args[i]!)) { i++; continue; }
    if (!args[i]!.startsWith('--')) values.push(args[i]!);
  }
  return values;
}
function requireCount(value: string | undefined, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) fail(`${label} must be a positive integer`, 2);
  return number;
}
function repoRow(db: Database.Database, query?: string): { id: string; root_path: string; display_name: string } {
  const root = process.cwd();
  const rows = db.prepare('SELECT id, root_path, display_name FROM repositories ORDER BY display_name').all() as Array<{ id: string; root_path: string; display_name: string }>;
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const same = (a: string, b: string) => norm(a) === norm(b);
  const match = query ? rows.find((row) => row.id === query || row.display_name.toLowerCase() === query.toLowerCase() || same(row.root_path, resolve(query)))
    : rows.find((row) => same(row.root_path, root));
  if (match) return match;
  if (!query && !rows.length) fail('No repositories are registered. Run `weft repos register` first.', 3);
  if (!query) fail(`Current directory is not registered: ${root}`, 3);
  fail(`Repository not found: ${query}`, 3);
}
function allRepos(db: Database.Database) {
  return db.prepare('SELECT id, root_path AS rootPath, display_name AS name, created_at AS registeredAt FROM repositories ORDER BY display_name').all() as Array<{ id: string; rootPath: string; name: string; registeredAt: string }>;
}
function duration(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d+)([smhdw])$/i.exec(value);
  if (!match) fail('--since must be a duration such as 7d or 2h', 2);
  const factors: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return new Date(Date.now() - Number(match[1]) * factors[match[2]!.toLowerCase()]!).toISOString();
}
function isHarness(value: string | undefined): value is Harness { return ['claude-code', 'codex', 'opencode', 't3'].includes(value ?? ''); }
function commandOnPath(name: string): boolean {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  return (process.env.PATH ?? '').split(delimiter).some((dir) => extensions.some((extension) => existsSync(join(dir, `${name}${extension}`))));
}

export async function runCommand(args: string[], compactOutput = false): Promise<Result> {
  const [group, sub, ...rest] = args;
  validateFlags(args);
  if (group === 'verify') {
    const separator = args.indexOf('--'), command = separator < 0 ? '' : args.slice(separator + 1).join(' ');
    const root = await getGitRoot(process.cwd()); if (!root) fail('Current directory is not a Git repository.', 3);
    const db = database();
    try {
      const repo = repoRow(db), status = await getWorkingTreeStatus(root);
      if (!command || args.includes('--suggest')) return { code: 0, data: await suggestChecks(root, [...status.staged, ...status.unstaged, ...status.untracked]) };
      const taskArgs = args.slice(1, separator < 0 ? undefined : separator), taskId = option(taskArgs, '--task');
      let task = taskId ? db.prepare('SELECT id FROM tasks WHERE id = ? AND repo_id = ?').get(taskId, repo.id) as { id: string } | undefined
        : db.prepare("SELECT id FROM tasks WHERE repo_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1").get(repo.id) as { id: string } | undefined;
      if (taskId && !task) fail(`Task not found for this repository: ${taskId}`, 3);
      if (!task) task = createTask(db, repo.id, 'Verification');
      const record = await runVerification(root, command);
      if (!db.prepare('SELECT 1 FROM checkpoints WHERE task_id = ? LIMIT 1').get(task.id)) {
        const current = await getWorkingTreeStatus(root), fingerprint = computeWorkingTreeFingerprint(current, await getHeadCommit(root) ?? '', current.branch);
        saveCheckpoint(db, { taskId: task.id, workingTreeFingerprint: fingerprint, objective: '', status: 'active', findings: [], decisions: [], verification: [], nextAction: '' });
      }
      recordVerification(db, task.id, record);
      return { code: record.exitCode, data: record };
    } finally { db.close(); }
  }
  if (group === 'init') {
    await mkdir(paths.config, { recursive: true }); await mkdir(paths.instructions, { recursive: true }); await mkdir(paths.state, { recursive: true }); await mkdir(paths.cache, { recursive: true });
    const config = await loadConfig(); await saveConfig(config);
    const db = database(false); db.close();
    const intentPath = join(paths.instructions, 'intent.md');
    if (!existsSync(intentPath)) await writeFile(intentPath, generateDefaultIntent(), 'utf8');
    return { code: 0, data: { initialized: true, paths } };
  }
  if (group === 'setup') {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
    const selected = (option(args, '--harness', 'claude-code,codex,opencode') ?? '').split(',');
    if (selected.some((value) => !['claude-code', 'codex', 'opencode', 't3'].includes(value))) fail('--harness must be claude-code,codex,opencode,or t3', 2);
    const dryRun = args.includes('--dry-run'), uninstall = args.includes('--uninstall');
    const data = await setupWeft({ home, harnesses: selected as Harness[], dryRun, uninstall });
    if (!dryRun) { const config = await loadConfig(); config.autoOnboard = !uninstall; await saveConfig(config); }
    return { code: 0, data };
  }
  if (group === 'auto') {
    const action = sub;
    if (!['on', 'off', 'status'].includes(action ?? '')) fail('Use `weft auto on|off|status`.', 2);
    const config = await loadConfig();
    if (action !== 'status') { config.autoOnboard = action === 'on'; await saveConfig(config); }
    return { code: 0, data: { autoOnboard: config.autoOnboard } };
  }
  if (group === 'doctor') {
    if (!existsSync(dbFile) && !args.includes('--repair')) fail('Weft is not initialized. Run `weft init` first.', 3);
    const preflight = await repairCorruptDatabase(paths.state, args.includes('--repair'));
    if (preflight.integrity !== 'ok' && !preflight.backup && preflight.integrity !== 'missing') {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
      const integrations = await checkIntegrations(home);
      return { code: 6, data: { node: process.version, database: preflight.integrity, repositories: null, weftOnPath: commandOnPath('weft'), integrations }, warnings: [`SQLite quick_check: ${preflight.integrity}`, 'Run `weft doctor --repair` to move the damaged database aside and create a fresh one.'] };
    }
    const db = database(false);
    try {
      const integrity = db.pragma('quick_check', { simple: true }) as string;
      const warnings = integrity === 'ok' ? [] : [`SQLite quick_check: ${integrity}`];
      const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
      const integrations = await checkIntegrations(home);
      const hooksLog = await readFile(join(paths.state, 'hooks.log'), 'utf8').then(value => value.trim().slice(-500)).catch(() => '');
      const data = { node: process.version, database: integrity, repairedFrom: preflight.backup ?? null, hookLog: hooksLog, repositories: allRepos(db).length, weftOnPath: commandOnPath('weft'), integrations };
      const lines = integrations.map((item) => `${item.id}: ${item.status}${item.detail ? ` (${item.detail})` : ''}${item.fix ? `; fix: ${item.fix}` : ''}`);
      if (compactOutput) return { code: warnings.length ? 6 : 0, data: lines.join('\n'), warnings };
      return { code: warnings.length ? 6 : 0, data, warnings };
    } finally { db.close(); }
  }
  if (group === 'mcp' && sub === 'serve') {
    const root = await getGitRoot(process.cwd());
    if (root) await ensureRepoOnboarded(process.cwd(), { spawnIndex: false });
    const db = database(false);
    const repo = root ? findMcpRepo(db, root) : undefined;
    if (repo) {
      const index = db.prepare('SELECT active_generation FROM repo_index_state WHERE repo_id = ?').get(repo.id) as { active_generation: number | null } | undefined;
      if (!index?.active_generation) {
        const config = await loadConfig();
        if (await indexWithinLimit(repo.rootPath, config.maxTrackedFiles, db, repo.id)) { /* tool calls explain the skipped index */ }
        else await indexRepository(db, repo.id, repo.rootPath);
      }
    }
    // Not inside a repo but above some: serve the child repos as one workspace.
    const children = root ? [] : await onboardWorkspace(db, process.cwd());
    serveMcp(db, repo ? { id: repo.id, rootPath: repo.rootPath } : null, undefined, root ? 'not-registered' : 'not-git', children.length ? createWorkspaceHandler(db, children) : undefined);
    return await new Promise<Result>(() => {});
  }
  if (group === 'mcp' && sub === 'install') {
    const harness = option(rest, '--harness');
    if (!isHarness(harness)) fail('--harness must be claude-code, codex, opencode, or t3', 2);
    const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
    const result = await installMcpConfig(harness, { home, project: harness === 't3' ? undefined : process.cwd(), dryRun: args.includes('--dry-run') });
    return { code: 0, data: result };
  }
  if (group === 'hook') return runHookCommand(sub);
  if (group === 'hooks') {
    const options = { projectRoot: process.cwd(), home: process.env.HOME ?? process.env.USERPROFILE, global: args.includes('--global'), dryRun: args.includes('--dry-run') };
    // Calling node on the real CLI path skips the npm shim (~270ms per hook on Windows); --portable keeps plain `weft`.
    if (sub === 'install') return { code: 0, data: await installClaudeHooks({ ...options, bin: args.includes('--portable') || !process.argv[1] ? 'weft' : `node "${realpathSync(resolve(process.argv[1])).replace(/\\/g, '/')}"` }) };
    if (sub === 'uninstall') return { code: 0, data: await uninstallClaudeHooks(options) };
    fail('Use `weft hooks install|uninstall [--global] [--dry-run]`.', 2);
  }
  if (group === 'onboard') {
    const target = positional(args.slice(1))[0] ?? process.cwd();
    const harnesses = (option(args, '--harness', 'claude-code') ?? 'claude-code').split(',');
    if (harnesses.some((value) => !isHarness(value))) fail('--harness must be claude-code, codex, opencode, or t3 (comma-separated)', 2);
    const registered = await runCommand(['repos', 'register', target]);
    const repo = registered.data as { id: string };
    const indexed = await runCommand(['index', repo.id]);
    const root = await getGitRoot(target); if (!root) fail(`Not a Git repository: ${target}`, 3);
    const instructions = await Promise.all([
      syncClaudeInstructions(root, CLAUDE_CODE_GUIDELINES), syncCodexInstructions(root, CODEX_GUIDELINES),
    ]);
    const installed = await Promise.all(harnesses.map((value) => installMcpConfig(value as Harness, { home: process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(), project: root })));
    return { code: 0, data: { registered: registered.data, indexed: indexed.data, instructions, installed } };
  }
  if (group === 'instructions') {
    const action = sub;
    if (action !== 'sync' && action !== 'check') fail('Use `weft instructions sync` or `check`.', 2);
    const root = await getGitRoot(process.cwd()); if (!root) fail('Current directory is not a Git repository.', 3);
    const dry = args.includes('--dry-run') || action === 'check';
    const checks = await Promise.all([
      action === 'check' ? checkInstructions(join(root, 'CLAUDE.md'), CLAUDE_CODE_GUIDELINES) : syncClaudeInstructions(root, CLAUDE_CODE_GUIDELINES, dry),
      action === 'check' ? checkInstructions(join(root, 'AGENTS.md'), CODEX_GUIDELINES) : syncCodexInstructions(root, CODEX_GUIDELINES, dry),
    ]);
    const drift = action === 'check' ? checks.filter((item) => 'matches' in item && !item.matches).length : checks.filter((item) => 'modified' in item && item.modified).length;
    return { code: drift ? 4 : 0, data: checks, warnings: drift ? [`${drift} instruction file(s) ${action === 'check' ? 'need synchronization' : 'would change'}.`] : [] };
  }
  if (group === 'repos') {
    if (sub === 'list') { const db = database(); try { return { code: 0, data: allRepos(db) }; } finally { db.close(); } }
    if (sub === 'register') {
      const db = database(false);
      try {
        const target = positional(rest)[0] ?? process.cwd(); const gitRoot = await getGitRoot(target); if (!gitRoot) fail(`Not a Git repository: ${target}`, 3);
        const rootPath = await normalizeCanonicalPath(gitRoot); const name = option(rest, '--name', basename(rootPath))!;
        const existing = db.prepare('SELECT id, root_path, display_name FROM repositories WHERE root_path = ?').get(rootPath) as { id: string; root_path: string; display_name: string } | undefined;
        if (existing) return { code: 0, data: existing };
        const conflict = db.prepare('SELECT 1 FROM repositories WHERE display_name = ?').get(name);
        if (conflict) fail(`Repository name already registered: ${name}`, 2);
        const id = randomUUID(); const now = new Date().toISOString();
        db.prepare('INSERT INTO repositories (id, root_path, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(id, rootPath, name, now, now);
        return { code: 0, data: { id, rootPath, name } };
      } finally { db.close(); }
    }
    if (sub === 'unregister') {
      const name = positional(rest)[0]; if (!name) fail('Usage: weft repos unregister <repo>', 2);
      const db = database(); try { const repo = repoRow(db, name); db.prepare('DELETE FROM repositories WHERE id = ?').run(repo.id); return { code: 0, data: { unregistered: repo.display_name } }; } finally { db.close(); }
    }
    if (sub === 'fuzzy') {
      const query = positional(rest).join(' '); if (!query) fail('Usage: weft repos fuzzy <query>', 2);
      const db = database(); try { const rows = allRepos(db); const result = fuzzyFindRepo(query, rows.map(({ name, rootPath, registeredAt }) => ({ name, rootPath, registeredAt }))); return { code: result.match ? 0 : 4, data: result, warnings: result.match ? [] : ['No unique repository match.'] }; } finally { db.close(); }
    }
    if (sub === 'status') {
      const db = database(); try { const repo = repoRow(db, positional(rest)[0]); const git = await getWorkingTreeStatus(repo.root_path); const index = db.prepare('SELECT active_generation FROM repo_index_state WHERE repo_id = ?').get(repo.id); const config = db.prepare('SELECT config_json FROM repositories WHERE id = ?').get(repo.id) as { config_json: string }; const note = (JSON.parse(config.config_json) as { weftOnboardingNote?: string }).weftOnboardingNote; return { code: 0, data: { repo, git, index, ...(note ? { onboardingNote: note } : {}) } }; } finally { db.close(); }
    }
    fail('Use `weft repos register|unregister|list|fuzzy|status`.', 2);
  }
  if (group === 'index') {
    const db = database(); try { const repo = repoRow(db, positional(args.slice(1))[0]); const config = await loadConfig(); const note = await indexWithinLimit(repo.root_path, config.maxTrackedFiles, db, repo.id); return note ? { code: 0, data: { skipped: true, note } } : { code: 0, data: await indexRepository(db, repo.id, repo.root_path, { force: args.includes('--force') }) }; } finally { db.close(); }
  }
  if (group === 'search' || group === 'context') {
    const values = positional(args.slice(1));
    if (!values.length) fail(`Usage: weft ${group} <query> [repo]`, 2);
    const db = database(); try {
      let repoIndex = -1;
      for (let i = values.length - 1; i >= 0; i--) {
        if (db.prepare('SELECT 1 FROM repositories WHERE display_name = ? OR id = ?').get(values[i], values[i])) { repoIndex = i; break; }
      }
      const repoArg = repoIndex < 0 ? undefined : values[repoIndex];
      const query = values.filter((_value, index) => index !== repoIndex).join(' ');
      if (!query) fail(`Usage: weft ${group} <query> [repo]`, 2);
      const repo = repoRow(db, repoArg);
      if (group === 'search') {
        const hits = searchChunks(db, repo.id, query, requireCount(option(args, '--limit'), '--limit', 20));
        return { code: 0, data: compactOutput ? rankCandidates(hits, query) : hits };
      }
      const results = rankCandidates(searchChunks(db, repo.id, query, 100), query);
      const contextHits = compactOutput ? results.filter((hit, index) => results.findIndex(other => other.path === hit.path) === index).slice(0, 2) : results;
      return { code: 0, data: packContext(contextHits, requireCount(option(args, '--budget'), '--budget', 1500), query) };
    } finally { db.close(); }
  }
  if (group === 'task') {
    const db = database(); try {
      if (sub === 'start') {
        const parts = positional(rest); const repos = allRepos(db); const last = parts.at(-1);
        const target = last ? repos.find((repo) => repo.name.toLowerCase() === last.toLowerCase() || repo.id === last || repo.rootPath.toLowerCase() === resolve(last).toLowerCase()) : undefined;
        const title = (target ? parts.slice(0, -1) : parts).join(' ');
        if (!title) fail('Usage: weft task start <title> [repo]', 2);
        return { code: 0, data: createTask(db, repoRow(db, target?.id).id, title) };
      }
      if (sub === 'resume') { const id = positional(rest)[0]; if (!id) fail('Usage: weft task resume <id>', 2); const task = db.prepare('SELECT repo_id FROM tasks WHERE id = ?').get(id) as { repo_id: string } | undefined; if (!task) fail(`Task not found: ${id}`, 3); const repo = repoRow(db, task.repo_id); const git = await getWorkingTreeStatus(repo.root_path); const fingerprint = computeWorkingTreeFingerprint(git, await getHeadCommit(repo.root_path) ?? '', git.branch); return { code: 0, data: resumeTask(db, id, fingerprint) }; }
      if (sub === 'checkpoint') { const id = positional(rest)[0]; if (!id) fail('Usage: weft task checkpoint <id>', 2); const task = db.prepare('SELECT repo_id FROM tasks WHERE id = ?').get(id) as { repo_id: string } | undefined; if (!task) fail(`Task not found: ${id}`, 3); const repo = repoRow(db, task.repo_id); const git = await getWorkingTreeStatus(repo.root_path); const fingerprint = computeWorkingTreeFingerprint(git, await getHeadCommit(repo.root_path) ?? '', git.branch); return { code: 0, data: saveCheckpoint(db, { taskId: id, workingTreeFingerprint: fingerprint, objective: '', status: 'active', findings: [], decisions: [], verification: [], nextAction: '' }) }; }
      fail('Use `weft task start|resume|checkpoint`.', 2);
    } finally { db.close(); }
  }
  if (group === 'checkpoint') {
    const id = sub; if (!id) fail('Usage: weft checkpoint <id>', 2);
    const db = database(); try {
      const task = db.prepare('SELECT repo_id FROM tasks WHERE id = ?').get(id) as { repo_id: string } | undefined;
      if (!task) fail(`Task not found: ${id}`, 3);
      const repo = repoRow(db, task.repo_id); const git = await getWorkingTreeStatus(repo.root_path);
      const fingerprint = computeWorkingTreeFingerprint(git, await getHeadCommit(repo.root_path) ?? '', git.branch);
      return { code: 0, data: saveCheckpoint(db, { taskId: id, workingTreeFingerprint: fingerprint, objective: '', status: 'active', findings: [], decisions: [], verification: [], nextAction: '' }) };
    } finally { db.close(); }
  }
  if (group === 'intent') {
    const path = join(paths.instructions, 'intent.md');
    if (sub === 'show') { if (!existsSync(path)) fail('intent.md is missing. Run `weft init` first.', 3); return { code: 0, data: parseIntent(await readFile(path, 'utf8')) }; }
    if (sub === 'edit') { await mkdir(paths.instructions, { recursive: true }); if (!existsSync(path)) await writeFile(path, generateDefaultIntent(), 'utf8'); const editor = process.env.EDITOR ?? process.env.VISUAL; if (!editor) fail('$EDITOR is not set.', 3); await new Promise<void>((resolvePromise, reject) => { const child = spawn(editor, [path], { stdio: 'inherit' }); child.once('error', reject); child.once('exit', (code: number | null) => code === 0 ? resolvePromise() : reject(new Error(`Editor exited with code ${code}`))); }); return { code: 0, data: { path } }; }
    fail('Use `weft intent show|edit`.', 2);
  }
  if (group === 'health') { const db = database(); try { const repo = repoRow(db, positional(args.slice(1))[0]); const data = await checkRepoHealth(repo.root_path); return { code: findings(data) ? 4 : 0, data, warnings: findings(data) ? ['Health findings were reported.'] : [] }; } finally { db.close(); } }
  if (group === 'portfolio') { const db = database(); try { const repos = allRepos(db).map((repo) => ({ name: repo.name, rootPath: repo.rootPath, registeredAt: repo.registeredAt })); const data = await generatePortfolioSummary(repos); return { code: findings(data.totals) ? 4 : 0, data }; } finally { db.close(); } }
  if (group === 'costs' || group === 'stats' || group === 'cache' || group === 'sessions') {
    const db = database(); try {
      await ingestTranscripts(db);
      if (group === 'stats') {
        const stats = await getStats(db, duration(option(args, '--since')));
        return { code: 0, data: compactOutput
          ? `Sessions: ${stats.sessions}\nTokens: ${stats.input} input, ${stats.output} output, ${stats.cached} cached\nEstimated cost: ${stats.cost == null ? 'unavailable for these models' : `$${(stats.cost / 1_000_000).toFixed(4)}`}\nWeft adoption: ${stats.adoption.percent}% (${stats.adoption.weftCalls} Weft calls vs ${stats.adoption.explorationCalls} Grep/Glob/Read calls)\nReturned tokens: ${stats.toolTokens.returned} (baseline ${stats.toolTokens.baseline})\nPrompt hook: ${stats.promptHook.injections} injections, ${stats.promptHook.returned} tokens (pointing at ${stats.promptHook.baseline} tokens of files)`
          : stats };
      }
      if (group === 'sessions') return { code: 0, data: listSessions(db, requireCount(option(args, '--limit'), '--limit', 50)) };
      const since = duration(option(args, '--since'));
      const by = option(args, '--by') as 'harness' | 'model' | 'repo' | undefined;
      if (by && !['harness', 'model', 'repo'].includes(by)) fail('--by must be harness, model, or repo', 2);
      return { code: 0, data: group === 'cache' ? getCacheDiagnostics(db, { since }) : getCostSummary(db, { since, by }) };
    } finally { db.close(); }
  }
  if (group === 'bench' && sub === 'retrieval') {
    const db = database();
    try {
      const repo = repoRow(db, option(rest, '--repo'));
      await indexRepository(db, repo.id, repo.root_path);
      const queryFile = join(process.cwd(), 'tests', 'golden', 'queries.json');
      if (!existsSync(queryFile)) fail(`Golden query file not found: ${queryFile}`, 3);
      const queries = JSON.parse(await readFile(queryFile, 'utf8')) as Array<{ query: string; expectedTop3: string[] }>;
      const report = await runRetrievalBenchmark(db, repo.id, repo.root_path, queries, join(paths.state, 'benchmarks'));
      return { code: 0, data: report };
    } finally { db.close(); }
  }
  if (group === 'bench' && sub === 'run') {
    const suitePath = resolve(option(rest, '--suite') ?? 'tests/benchmarks/suites/example.json');
    const harness = option(rest, '--harness') ?? process.env.WEFT_BENCH_HARNESS;
    if (!harness) fail('Set --harness "command template containing {prompt}" or WEFT_BENCH_HARNESS.', 2);
    const tasks = await loadSuite(suitePath);
    const selected = option(rest, '--tasks')?.split(',').map((id) => id.trim()).filter(Boolean);
    const filtered = selected ? tasks.filter((task) => selected.includes(task.id)) : tasks;
    if (!filtered.length || (selected && filtered.length !== new Set(selected).size)) fail('No matching tasks for --tasks.', 2);
    const repeat = Number(option(rest, '--repeat', '1'));
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) fail('--repeat must be an integer from 1 to 100.', 2);
    const estimate = filtered.reduce((sum, task) => sum + (task.estimatedTokens ?? 10_000), 0) * repeat * 3;
    const plan = `Plan: ${filtered.length} tasks × 3 conditions × ${repeat} repeats; estimated token ceiling ${estimate.toLocaleString('en-US')}.`;
    if (args.includes('--dry-run')) return { code: 0, data: plan };
    if (!args.includes('--yes')) fail(`${plan} Rerun with --yes to start the live benchmark.`, 5);
    const report = await runLiveSuite(Array.from({ length: repeat }, () => filtered).flat(), harness);
    const successfulResults = Object.fromEntries((['A', 'B', 'C'] as const).map((condition) => [condition, report.results.filter((result) => result.condition === condition && result.success)])) as Record<'A' | 'B' | 'C', typeof report.results>;
    const successfulCosts = Object.fromEntries((['A', 'B', 'C'] as const).map((condition) => [condition, successfulResults[condition].filter((result) => result.costProvenance === 'provider_reported').map((result) => result.costMicros).sort((left, right) => left - right)])) as Record<'A' | 'B' | 'C', number[]>;
    const medianCost = (costs: number[]) => costs.length ? costs.length % 2 ? costs[Math.floor(costs.length / 2)]! : (costs[costs.length / 2 - 1]! + costs[costs.length / 2]!) / 2 : 0;
    const reportedMedian = (condition: 'A' | 'B' | 'C') => successfulCosts[condition].length === successfulResults[condition].length ? medianCost(successfulCosts[condition]) : null;
    const reportedSpread = (condition: 'A' | 'B' | 'C') => successfulCosts[condition].length === successfulResults[condition].length && successfulCosts[condition].length ? Math.sqrt(report.conditionResults[condition].successfulTaskCostVarianceMicros) : null;
    const data = { ...report, plan, usageProvenance: 'Each trial labels provider_reported or estimated usage.', successfulTaskCostMedianMicros: Object.fromEntries((['A', 'B', 'C'] as const).map((condition) => [condition, reportedMedian(condition)])), costPerSuccessfulTaskSpreadMicros: Object.fromEntries((['A', 'B', 'C'] as const).map((condition) => [condition, reportedSpread(condition)])) };
    if (!compactOutput) return { code: 0, data };
    const money = (micros: number | null) => micros === null ? 'n/a' : `$${(micros / 1_000_000).toFixed(4)}`;
    const rows = (['A', 'B', 'C'] as const).map((condition) => { const summary = report.conditionResults[condition]; const tokens = report.results.filter((result) => result.condition === condition).reduce((sum, result) => sum + result.tokensUsed, 0); const spread = reportedSpread(condition); return `| ${condition} | ${(summary.passRate * 100).toFixed(0)}% | ${money(reportedMedian(condition))} | ${money(spread === null ? null : spread)} | ${tokens} |`; });
    return { code: 0, data: ['| Condition | Pass rate | Median cost per successful task | Cost spread (SD) | Tokens |', '|---|---:|---:|---:|---:|', ...rows, '', plan].join('\n') };
  }
  if (group === 'bench') fail('Use `weft bench retrieval [--repo <name>] [--json]` or `weft bench run --suite <file> --harness <template>`.', 2);
  if (group === 'clean') {
    const db = database(); try {
      const scope = option(args, '--scope', 'indexes'); if (!['indexes', 'all'].includes(scope!)) fail('--scope must be indexes or all', 2);
      const rows = db.prepare(`SELECT g.id FROM index_generations g LEFT JOIN repo_index_state s ON s.repo_id = g.repo_id
        WHERE g.id != COALESCE(s.active_generation, -1) AND (g.status != 'ready' OR datetime(g.completed_at) < datetime('now', '-7 days'))
        AND g.id NOT IN (SELECT id FROM index_generations newer WHERE newer.repo_id = g.repo_id AND newer.status = 'ready' AND newer.id != COALESCE(s.active_generation, -1) ORDER BY newer.id DESC LIMIT 1)`).all() as Array<{ id: number }>;
      const oldTelemetry = scope === 'all' ? (db.prepare("SELECT (SELECT COUNT(*) FROM tool_calls WHERE datetime(observed_at) < datetime('now', '-90 days')) + (SELECT COUNT(*) FROM usage_events WHERE datetime(observed_at) < datetime('now', '-90 days')) AS count").get() as { count: number }).count : 0;
      const dryRun = args.includes('--dry-run');
      if (!dryRun && !args.includes('--yes')) fail('Confirmation required; rerun with --yes.', 5);
      if (!dryRun) {
        const del = db.prepare('DELETE FROM index_generations WHERE id = ?');
        db.transaction(() => {
          for (const row of rows) del.run(row.id);
          if (scope === 'all') { db.prepare("DELETE FROM tool_calls WHERE datetime(observed_at) < datetime('now', '-90 days')").run(); db.prepare("DELETE FROM usage_events WHERE datetime(observed_at) < datetime('now', '-90 days')").run(); }
        })();
        db.exec('VACUUM');
      }
      return { code: 0, data: { removed: dryRun ? 0 : rows.length + oldTelemetry, planned: rows.length + oldTelemetry, dryRun } };
    } finally { db.close(); }
  }
  if (group === 'migrate' && sub === 'devpulse') {
    const source = option(args, '--source') ?? process.env.DEVPULSE_CONFIG ?? join(process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(), '.devpulse');
    const sourceDir = basename(source).toLowerCase() === 'config.toml' ? resolve(source, '..') : source;
    if (!existsSync(sourceDir)) fail(`DevPulse source not found: ${sourceDir}`, 3);
    const data = await migrateDevPulse({ sourcePath: source, dryRun: args.includes('--dry-run') });
    return { code: data.warnings.length ? 4 : 0, data, warnings: data.warnings };
  }
  fail(`Unknown command: ${group ?? ''}`, 2);
}

const VALUE_FLAGS = new Set(['--name', '--limit', '--budget', '--scope', '--since', '--source', '--by', '--suite', '--harness', '--repo', '--tasks', '--repeat', '--task']);
export const KNOWN_FLAGS = new Set([...VALUE_FLAGS, '--force', '--repair', '--dry-run', '--keep-data', '--interactive', '--yes', '--global', '--suggest', '--uninstall', '--portable']);

function validateFlags(args: string[]): void {
  const valueFlags = VALUE_FLAGS;
  const known = KNOWN_FLAGS;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') break;
    if (!arg.startsWith('--')) continue;
    if (!known.has(arg)) fail(`Unknown option: ${arg}`, 2);
    if (valueFlags.has(arg) && (!args[i + 1] || args[i + 1]!.startsWith('--'))) fail(`${arg} requires a value`, 2);
  }
}

function findings(value: HealthReport | { unmergedBranches: number; staleBranches: number; todoCount: number; dirtyFilesCount: number }): number {
  const report = value as HealthReport;
  if (Array.isArray(report.unmergedBranches)) return Number(report.unmergedBranches.length + report.staleBranches.length + report.todoCount + report.dirtyFilesCount > 0);
  const totals = value as { unmergedBranches: number; staleBranches: number; todoCount: number; dirtyFilesCount: number };
  return Number(totals.unmergedBranches + totals.staleBranches + totals.todoCount + totals.dirtyFilesCount > 0);
}
