import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { estimateTokens } from '../core/estimate/tokenEstimator.js';
import { syncClaudeInstructions, CLAUDE_CODE_GUIDELINES } from '../integrations/claude-code/index.js';
import { syncCodexInstructions, CODEX_GUIDELINES } from '../integrations/codex/index.js';
import { installMcpConfig } from '../integrations/mcpConfig.js';
import { installClaudeHooks, uninstallClaudeHooks } from '../hooks/claude.js';
import { openDatabase } from '../storage/db.js';
import { migrate } from '../storage/migrator.js';
import { indexRepository } from '../indexer/indexer.js';
import { runBenchmark } from './runner.js';
import type { TaskDefinition, TrialCondition } from './types.js';

async function removeWeftSetup(repo: string): Promise<void> {
  await uninstallClaudeHooks({ projectRoot: repo });
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const path = join(repo, name);
    let content: string;
    try { content = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    content = content.replace(/(?:\r?\n)?<!-- BEGIN WEFT MANAGED BLOCK -->[\s\S]*?<!-- END WEFT MANAGED BLOCK -->(?:\r?\n)?/g, '\n');
    if (content.trim()) await writeFile(path, content, 'utf8'); else await rm(path, { force: true });
  }
  const configPath = join(repo, '.mcp.json');
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { mcpServers?: Record<string, unknown> };
    const hadWeft = Boolean(config.mcpServers && 'weft' in config.mcpServers);
    if (!hadWeft) return;
    delete config.mcpServers!.weft;
    if (!Object.keys(config.mcpServers!).length) delete config.mcpServers;
    if (Object.keys(config).length) await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    else await rm(configPath, { force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export interface SuitePatch { path: string; from: string; to: string }
export type SuiteTask = TaskDefinition & { prompt: string; setup?: SuitePatch[]; solution?: SuitePatch[]; estimatedTokens?: number };
// POSIX single quotes stop the shell expanding backticks, $(...) and $VAR in prompt text; cmd.exe has no equivalent, so double quotes with escaped quotes.
export function shellQuote(value: string, platform = process.platform): string {
  return platform === 'win32' ? `"${value.replace(/"/g, '\\"')}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}
// A placeholder already wrapped in quotes in the template ("{prompt}") is replaced whole, so it is never quoted twice.
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/(["']?)\{(prompt|repoPath)\}\1/g, (_match, _quote, name: string) => shellQuote(values[name] ?? ''));
}
const RETRY_WAITS_MS = process.env.WEFT_BENCH_RETRY_WAITS_MS ? process.env.WEFT_BENCH_RETRY_WAITS_MS.split(',').map(Number) : [30_000, 120_000, 300_000];
function execute(command: string, cwd: string, env = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}
function usage(output: string): { tokens?: number; costMicros?: number } {
  // opencode --format json streams one event per line; each step_finish carries that step's tokens and cost.
  const steps = output.split(/\r?\n/).flatMap((line) => { try { const event = JSON.parse(line) as { type?: string; part?: { cost?: number; tokens?: { input?: number; output?: number; reasoning?: number } } }; return event.type === 'step_finish' && event.part ? [event.part] : []; } catch { return []; } });
  if (steps.length) {
    const tokens = steps.reduce((sum, step) => sum + (step.tokens?.input ?? 0) + (step.tokens?.output ?? 0) + (step.tokens?.reasoning ?? 0), 0);
    return { ...(tokens > 0 ? { tokens } : {}), costMicros: Math.round(steps.reduce((sum, step) => sum + (step.cost ?? 0), 0) * 1_000_000) };
  }
  try {
    const json = JSON.parse(output) as Record<string, unknown>;
    const usage = (json.usage && typeof json.usage === 'object' ? json.usage : json) as Record<string, unknown>;
    // Claude reports cached input separately and the cost as total_cost_usd.
    const tokens = Number(usage.total_tokens ?? usage.totalTokens ?? (Number(usage.input_tokens ?? usage.inputTokens ?? 0) + Number(usage.output_tokens ?? usage.outputTokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0)));
    const cost = Number(usage.cost_usd ?? usage.costUsd ?? json.cost_usd ?? json.costUsd ?? json.total_cost_usd);
    return { ...(Number.isFinite(tokens) && tokens > 0 ? { tokens } : {}), ...(Number.isFinite(cost) && cost >= 0 ? { costMicros: Math.round(cost * 1_000_000) } : {}) };
  } catch { return {}; }
}
export async function applySuitePatches(repo: string, patches: SuitePatch[] = []): Promise<void> {
  for (const patch of patches) {
    const path = resolve(repo, patch.path);
    if (!path.startsWith(`${resolve(repo)}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`Suite patch escapes repo: ${patch.path}`);
    const content = await readFile(path, 'utf8');
    if (!content.includes(patch.from)) throw new Error(`Suite patch did not match ${patch.path}`);
    await writeFile(path, content.replace(patch.from, patch.to), 'utf8');
  }
}
export async function runLiveSuite(tasks: SuiteTask[], harnessTemplate: string, conditions: TrialCondition[] = ['A', 'B', 'C']) {
  if (!harnessTemplate.includes('{prompt}')) throw new Error('Harness template must include {prompt}.');
  return runBenchmark(tasks.map((task) => ({ ...task, run: async (condition) => {
    const work = await mkdtemp(join(tmpdir(), 'weft-bench-'));
    const repo = join(work, basename(resolve(task.repoPath)));
    const started = Date.now();
    const opencode = /\bopencode\b/.test(harnessTemplate);
    try {
      await cp(resolve(task.repoPath), repo, { recursive: true, filter: (source) => !/[\\/](?:\.git|node_modules|dist|coverage)(?:[\\/]|$)/.test(source) });
      await applySuitePatches(repo, task.setup);
      await removeWeftSetup(repo);
      if (condition !== 'A') await syncClaudeInstructions(repo, CLAUDE_CODE_GUIDELINES);
      if (condition !== 'A' && opencode) await syncCodexInstructions(repo, CODEX_GUIDELINES); // opencode reads AGENTS.md, not CLAUDE.md
      // Harnesses pass --strict-mcp-config --mcp-config .mcp.json, so A and B get an explicitly empty server list.
      if (condition !== 'C') await writeFile(join(repo, '.mcp.json'), '{"mcpServers":{}}\n', 'utf8');
      if (condition === 'C') {
        await installMcpConfig('claude-code', { home: work, project: repo });
        const localAppData = join(work, 'weft-local');
        const state = process.platform === 'win32' ? join(localAppData, 'Weft', 'state') : join(work, 'weft-state', 'Weft');
        await mkdir(state, { recursive: true });
        const db = openDatabase(state);
        try {
          migrate(db);
          db.prepare('INSERT INTO repositories (id, root_path, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run('bench', repo, 'bench', 'now', 'now');
          await indexRepository(db, 'bench', repo, { force: true });
        } finally { db.close(); }
        const cli = resolve(process.argv[1] ?? 'dist/cli/index.js');
        const hookBin = process.platform === 'win32'
          ? `set WEFT_STATE_DIR="${state}"&& "${process.execPath}" "${cli}"`
          : `WEFT_STATE_DIR="${state}" "${process.execPath}" "${cli}"`;
        await installClaudeHooks({ projectRoot: repo, home: work, bin: hookBin });
        const configPath = join(repo, '.mcp.json');
        const config = JSON.parse(await readFile(configPath, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
        config.mcpServers.weft = { command: process.execPath, args: [resolve(process.argv[1] ?? 'dist/cli/index.js'), 'mcp', 'serve'], env: process.platform === 'win32' ? { LOCALAPPDATA: localAppData } : { XDG_STATE_HOME: join(work, 'weft-state') } };
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        if (opencode) await writeFile(join(repo, 'opencode.json'), JSON.stringify({ mcp: { weft: { type: 'local', command: [process.execPath, resolve(process.argv[1] ?? 'dist/cli/index.js'), 'mcp', 'serve'], environment: config.mcpServers.weft!.env, enabled: true } } }, null, 2), 'utf8');
      }
      const prompt = task.prompt.replaceAll('{condition}', condition).replaceAll('{repoPath}', repo);
      const command = fillTemplate(harnessTemplate, { prompt, repoPath: repo });
      // A harness that cannot start (rate or usage limit, network) says nothing about the task: back off and retry before recording a failure.
      // A private config dir keeps the user's global opencode MCP servers and AGENTS.md out of every condition.
      const env = { ...process.env, XDG_CONFIG_HOME: join(work, 'xdg') };
      let harness = await execute(command, repo, env);
      for (const wait of RETRY_WAITS_MS) {
        if (harness.code === 0) break;
        await new Promise((done) => setTimeout(done, wait));
        harness = await execute(command, repo, env);
      }
      const parsed = usage(harness.stdout);
      const test = harness.code === 0 ? await execute(task.testCommand, repo) : { code: 1, stdout: '', stderr: harness.stderr };
      const success = harness.code === 0 && test.code === 0;
      const tokensUsed = parsed.tokens ?? estimateTokens(prompt + harness.stdout);
      return { success, durationMs: Date.now() - started, tokensUsed, costMicros: parsed.costMicros ?? 0, tokenProvenance: parsed.tokens !== undefined ? 'provider_reported' as const : 'estimated' as const, costProvenance: parsed.costMicros !== undefined ? 'provider_reported' as const : 'estimated' as const, ...(!success ? { error: harness.stderr || (harness.code !== 0 ? harness.stdout.slice(0, 300) : '') || test.stderr || `Harness or test command failed (${harness.code}/${test.code}).`, ...(harness.code !== 0 ? { infrastructure: true } : {}) } : {}) };
    } finally { await rm(work, { recursive: true, force: true }); }
  } })), conditions);
}
export async function loadSuite(path: string): Promise<SuiteTask[]> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const tasks = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? (parsed as { tasks?: unknown }).tasks : undefined;
  const validPatch = (patch: unknown): patch is SuitePatch => Boolean(patch && typeof patch === 'object' && typeof (patch as SuitePatch).path === 'string' && typeof (patch as SuitePatch).from === 'string' && typeof (patch as SuitePatch).to === 'string');
  const validTask = (task: unknown): task is SuiteTask => Boolean(task && typeof task === 'object' && typeof (task as SuiteTask).id === 'string' && typeof (task as SuiteTask).title === 'string' && ['bugfix', 'feature', 'refactor', 'comprehension'].includes((task as SuiteTask).category) && typeof (task as SuiteTask).repoPath === 'string' && typeof (task as SuiteTask).prompt === 'string' && typeof (task as SuiteTask).testCommand === 'string' && ((task as SuiteTask).setup === undefined || (Array.isArray((task as SuiteTask).setup) && (task as SuiteTask).setup!.every(validPatch))) && ((task as SuiteTask).solution === undefined || (Array.isArray((task as SuiteTask).solution) && (task as SuiteTask).solution!.every(validPatch))) && ((task as SuiteTask).estimatedTokens === undefined || (Number.isInteger((task as SuiteTask).estimatedTokens) && (task as SuiteTask).estimatedTokens! > 0)));
  if (!Array.isArray(tasks) || !tasks.length || tasks.some((task) => !validTask(task)) || new Set(tasks.map((task) => (task as SuiteTask).id)).size !== tasks.length) throw new Error('Suite tasks must have unique ids and valid task, setup, and solution fields.');
  return (tasks as SuiteTask[]).map((task) => ({ ...task, setup: task.setup ?? [], solution: task.solution ?? [] }));
}
