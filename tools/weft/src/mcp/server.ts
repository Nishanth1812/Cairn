import type Database from 'better-sqlite3';
import { createInterface } from 'node:readline';
import { realpath, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { logHookFailure } from '../hooks/claude.js';
import { redactSafe } from '../core/security/redactor.js';
import { isSensitivePath } from '../core/security/paths.js';
import { estimateTokens } from '../core/estimate/tokenEstimator.js';
import { searchChunks } from '../context/search.js';
import { packContext } from '../context/packer.js';
import { rankCandidates } from '../context/ranker.js';
import { formatContext, formatSearch } from '../cli/format.js';
import { createTask, saveCheckpoint, resumeTask, latestVerification } from '../memory/taskManager.js';
import { checkRepoHealth } from '../health/healthChecker.js';
import { getWorkingTreeStatus } from '../core/gitstate/gitRunner.js';
import { getHeadCommit } from '../core/gitstate/gitRunner.js';
import { computeWorkingTreeFingerprint } from '../core/fingerprint/hasher.js';
import { indexRepository } from '../indexer/indexer.js';
import { recordToolCall, baselineTokensForChunks } from '../telemetry/toolCalls.js';

export const MCP_TOOLS = [
  { name: 'weft_search', description: 'Search the codebase to find where a function, symbol, file or feature lives. Use instead of Grep/Glob; returns ranked file:line hits.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'weft_context', description: 'Explore code for a question or task: returns the most relevant snippets packed to a token budget. Use first, instead of grepping or reading whole files.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, budget: { type: 'number' } }, required: ['query'] } },
  { name: 'weft_read', description: 'Read an exact line range of a file (cheaper than reading the whole file); use after weft_search/weft_context gives a location.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path', 'startLine', 'endLine'] } },
  { name: 'weft_checkpoint', description: 'Save task continuity state.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, objective: { type: 'string' }, findings: { type: 'array', items: { type: 'string' } }, decisions: { type: 'array', items: { type: 'string' } }, nextAction: { type: 'string' } } } },
  { name: 'weft_resume', description: 'Resume a task checkpoint.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } } } },
  { name: 'weft_health', description: 'Check repository health.', inputSchema: { type: 'object', properties: {} } },
];

type Args = Record<string, unknown>;
export function findMcpRepo(db: Database.Database, gitRoot: string) {
  const key = (path: string) => resolve(path).replace(/\\/g, '/').toLowerCase();
  return (db.prepare('SELECT id, root_path AS rootPath FROM repositories').all() as Array<{ id: string; rootPath: string }>).find((repo) => key(repo.rootPath) === key(gitRoot));
}
function requiredString(args: Args, name: string): string { const value = args[name]; if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`${name} is required`), { code: -32602 }); return value; }
const filesFor = (db: Database.Database, repoId: string, paths: string[]) => paths.length ? db.prepare(`SELECT id AS file_id FROM files WHERE repo_id = ? AND path IN (${paths.map(() => '?').join(',')})`).all(repoId, ...paths) as Array<{ file_id: number }> : [];

export function createMcpHandler(db: Database.Database, repo: { id: string; rootPath: string } | null, options: { index?: typeof indexRepository; noRepoReason?: 'not-git' | 'not-registered' } = {}) {
  let lastFingerprint: string | undefined, indexing: Promise<unknown> | undefined, refreshing: Promise<boolean> | undefined, refreshPending = false;
  const index = options.index ?? indexRepository;
  const refresh = (): Promise<boolean> => {
    if (!repo) return Promise.resolve(false);
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const [git, head] = await Promise.all([getWorkingTreeStatus(repo.rootPath), getHeadCommit(repo.rootPath)]);
      const changedFiles = [...git.staged, ...git.unstaged, ...git.untracked].sort();
      const changes = await Promise.all(changedFiles.map(async path => {
        try { const file = await stat(resolve(repo.rootPath, path)); return `${path}:${file.size}:${file.mtimeMs}`; }
        catch { return `${path}:deleted`; }
      }));
      const fingerprint = `${computeWorkingTreeFingerprint(git, head ?? '', git.branch)}:${changes.join('|')}`;
      if (fingerprint === lastFingerprint) return Boolean(indexing);
      if (indexing) { refreshPending = true; return true; }
      lastFingerprint = fingerprint;
      const started = Date.now();
      indexing = index(db, repo.id, repo.rootPath).catch(error => { lastFingerprint = undefined; throw error; }).finally(() => {
        indexing = undefined;
        if (refreshPending) { refreshPending = false; lastFingerprint = undefined; void refresh(); }
      });
      const outcome = await Promise.race([indexing.then(() => 'done'), new Promise<'slow'>(resolve => setTimeout(() => resolve('slow'), 1500))]);
      return outcome === 'slow' || Date.now() - started > 1500;
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
  return async (method: string, params: Args = {}): Promise<unknown> => {
    if (method === 'initialize') {
      void refresh().catch(() => undefined); // Warm the index now so the first tool call does not pay for it.
      const requested = params.protocolVersion;
      const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
      return { protocolVersion: typeof requested === 'string' && supported.includes(requested) ? requested : '2025-11-25', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'weft', version: '0.1.0' } };
    }
    if (method === 'ping') return {};
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) return undefined;
    if (method === 'tools/list') return { tools: MCP_TOOLS };
    if (method === 'resources/list' || method === 'resources/templates/list' || method === 'prompts/list') return { [method === 'prompts/list' ? 'prompts' : method === 'resources/list' ? 'resources' : 'resourceTemplates']: [] };
    if (method !== 'tools/call') throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw Object.assign(new Error('Invalid params'), { code: -32602 });
    const name = requiredString(params, 'name');
    const args = (params.arguments ?? {}) as Args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw Object.assign(new Error('arguments must be an object'), { code: -32602 });
    if (!MCP_TOOLS.some(tool => tool.name === name)) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    if (!repo) return { content: [{ type: 'text', text: options.noRepoReason === 'not-registered' ? 'Weft has not indexed this repository yet; it will register on the next session start. Use Grep/Glob/Read for now.' : 'This folder is not a Git repository, so Weft cannot index it. Use Grep/Glob/Read instead.' }], isError: false };
    const started = Date.now(); let text = ''; let baseline: number | null = null; let note = '';
    try {
      if (['weft_search', 'weft_context'].includes(name)) note = await refresh() ? '\nindex refreshing' : '';
      let value: unknown;
      if (name === 'weft_search') {
        const query = requiredString(args, 'query'); const limit = Number(args.limit ?? 10);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('limit must be 1–100'), { code: -32602 });
        const rows = searchChunks(db, repo.id, query, limit); baseline = baselineTokensForChunks(db, repo.id, filesFor(db, repo.id, rows.map(row => row.path)));
        value = formatSearch(rows);
      } else if (name === 'weft_context') {
        const query = requiredString(args, 'query'); const budget = Number(args.budget ?? 1500);
        if (!Number.isSafeInteger(budget) || budget < 1 || budget > 100_000) throw Object.assign(new Error('budget must be 1–100000'), { code: -32602 });
        const items = packContext(rankCandidates(searchChunks(db, repo.id, query, 100), query), budget, query).items;
        baseline = baselineTokensForChunks(db, repo.id, filesFor(db, repo.id, items.map(row => row.path)));
        value = formatContext(items);
      } else if (name === 'weft_read') {
        const path = requiredString(args, 'path'); const start = Number(args.startLine); const end = Number(args.endLine);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 1000) throw new Error('Invalid line range');
        const root = await realpath(repo.rootPath), target = resolve(root, path), rel = relative(root, target);
        if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) throw new Error('Path must be inside the repository');
        if (isSensitivePath(rel.replace(/\\/g, '/'))) throw new Error('Sensitive paths cannot be read');
        const canonicalTarget = await realpath(target), canonicalRel = relative(root, canonicalTarget);
        if (!canonicalRel || canonicalRel === '..' || canonicalRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(canonicalRel)) throw new Error('Path must be inside the repository');
        if (isSensitivePath(canonicalRel.replace(/\\/g, '/'))) throw new Error('Sensitive paths cannot be read');
        const content = await readFile(canonicalTarget, 'utf8'); const lines = content.split(/\r?\n/).slice(start - 1, end);
        text = lines.map((line, i) => `${start + i}: ${line}`).join('\n');
        baseline = estimateTokens(content);
      } else if (name === 'weft_checkpoint' || name === 'weft_resume') {
        const git = await getWorkingTreeStatus(repo.rootPath), head = await getHeadCommit(repo.rootPath) ?? '';
        const fingerprint = computeWorkingTreeFingerprint(git, head, git.branch);
        let taskId = typeof args.taskId === 'string' && args.taskId ? args.taskId : undefined;
        if (!taskId) {
          const task = db.prepare("SELECT id FROM tasks WHERE repo_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1").get(repo.id) as { id: string } | undefined;
          taskId = task?.id ?? createTask(db, repo.id, 'MCP session').id;
        }
        const task = db.prepare('SELECT id, repo_id FROM tasks WHERE id = ?').get(taskId) as { id: string; repo_id: string } | undefined;
        if (!task || task.repo_id !== repo.id) throw new Error(`Task not found: ${taskId}`);
        const changedFiles = [...git.staged, ...git.unstaged, ...git.untracked];
        if (name === 'weft_resume') {
          const resumed = resumeTask(db, taskId, fingerprint);
          value = [JSON.stringify(resumed), resumed.verificationText].filter(Boolean).join('\n');
        } else {
          const findings = Array.isArray(args.findings) ? args.findings.filter((v): v is string => typeof v === 'string').map(text => ({ text, evidence: [] })) : [];
          const decisions = Array.isArray(args.decisions) ? args.decisions.filter((v): v is string => typeof v === 'string') : [];
          decisions.push(redactSafe(JSON.stringify({ changedFiles })));
          const verification = latestVerification(db, taskId);
          value = saveCheckpoint(db, { taskId, workingTreeFingerprint: fingerprint, revision: head, objective: typeof args.objective === 'string' ? args.objective : '', status: 'active', findings, decisions, verification: [], verificationRecords: verification ? [verification] : [], nextAction: typeof args.nextAction === 'string' ? args.nextAction : '' });
        }
      } else if (name === 'weft_health') value = await checkRepoHealth(repo.rootPath);
      else throw new Error(`Unknown tool: ${name}`);
      if (!text) text = typeof value === 'string' ? value : JSON.stringify(value);
      text = redactSafe(text + note);
      try { recordToolCall(db, { repoId: repo.id, tool: name, returnedTokens: estimateTokens(text), baselineTokens: baseline, ms: Date.now() - started }); } catch { /* Telemetry must not interrupt tools. */ }
      return { content: [{ type: 'text', text }], isError: false };
    } catch (error) {
      try { recordToolCall(db, { repoId: repo.id, tool: name, returnedTokens: 0, baselineTokens: baseline, ms: Date.now() - started }); } catch { /* Telemetry must not interrupt tools. */ }
      if (Number((error as { code?: number }).code) === -32602) throw error;
      return { content: [{ type: 'text', text: redactSafe(error instanceof Error ? error.message : String(error)) }], isError: true };
    }
  };
}

export function serveMcp(db: Database.Database, repo: { id: string; rootPath: string } | null, streams = { input: process.stdin, output: process.stdout }, noRepoReason?: 'not-git' | 'not-registered', handler?: ReturnType<typeof createMcpHandler>): void {
  const handle = handler ?? createMcpHandler(db, repo, { noRepoReason }); const lines = createInterface({ input: streams.input });
  let closed = false;
  const autoCheckpoint = async () => {
    if (closed || !repo) return; closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const task = db.prepare("SELECT id FROM tasks WHERE repo_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1").get(repo.id) as { id: string } | undefined;
      if (!task) return;
      await Promise.race([getWorkingTreeStatus(repo.rootPath).then(async git => {
        const head = await getHeadCommit(repo.rootPath) ?? '', fingerprint = computeWorkingTreeFingerprint(git, head, git.branch);
        const prev = db.prepare('SELECT working_tree_fingerprint AS fingerprint FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(task.id) as { fingerprint: string } | undefined;
        if (prev?.fingerprint === fingerprint) return;
        saveCheckpoint(db, { taskId: task.id, workingTreeFingerprint: fingerprint, revision: head, objective: '', status: 'active', findings: [], decisions: [JSON.stringify({ changedFiles: [...git.staged, ...git.unstaged, ...git.untracked] })], verification: [], nextAction: '' });
      }), new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); })]);
    } catch (error) { if (db.name !== ':memory:') await logHookFailure(dirname(db.name), error); } // Shutdown must not fail or wait on checkpointing.
    finally { if (timer) clearTimeout(timer); }
  };
  lines.once('close', autoCheckpoint);
  process.once('SIGINT', () => { void autoCheckpoint().finally(() => process.kill(process.pid, 'SIGINT')); });
  process.once('SIGTERM', () => { void autoCheckpoint().finally(() => process.kill(process.pid, 'SIGTERM')); });
  let queue = Promise.resolve();
  const respond = (message: unknown) => streams.output.write(`${JSON.stringify(message)}\n`);
  const processMessage = async (message: unknown): Promise<void> => {
    if (Array.isArray(message)) { if (!message.length) { respond({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }); return; } await Promise.all(message.map(processMessage)); return; }
    if (!message || typeof message !== 'object') { respond({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }); return; }
    const request = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const hasId = Object.hasOwn(request, 'id');
    const id = request.id;
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (hasId && id !== null && typeof id !== 'string' && typeof id !== 'number') || (request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)))) {
      if (hasId) respond({ jsonrpc: '2.0', id: id === null || typeof id === 'string' || typeof id === 'number' ? id : null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    if (!hasId) { try { await handle(request.method, request.params as Args); } catch { /* Notifications never receive a response. */ } return; }
    try {
      const result = await handle(request.method, request.params as Args);
      respond({ jsonrpc: '2.0', id, result: result ?? {} });
    } catch (error) {
      respond({ jsonrpc: '2.0', id, error: { code: Number((error as { code?: number }).code) || -32603, message: redactSafe(error instanceof Error ? error.message : String(error)) } });
    }
  };
  lines.on('line', (line) => {
    if (Buffer.byteLength(line, 'utf8') > 16 * 1024 * 1024) { respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Message too large' } }); return; }
    let message: unknown;
    try { message = JSON.parse(line); } catch { respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    queue = queue.then(() => processMessage(message)).catch(() => undefined);
  });
}
