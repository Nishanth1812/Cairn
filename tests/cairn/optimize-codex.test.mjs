// Synthetic-fixture tests for the Codex rollout reader. Every rollout line below is invented
// in the verified upstream shape (openai/codex protocol.rs / models.rs / rollout_payload.rs);
// no real user transcript is ever read. The TypeScript source is compiled to a private temp
// build directory (never the shared dist/) so these tests run without a build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const buildDir = mkdtempSync(join(repoRoot, '.cairn-codex-build-'));
after(() => rmSync(buildDir, { recursive: true, force: true }));

const tscBin = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const compiled = spawnSync(
  process.execPath,
  [
    tscBin,
    '--ignoreConfig',
    join(repoRoot, 'src', 'cairn', 'optimize', 'codexTranscript.ts'),
    '--outDir', buildDir,
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--target', 'ES2022',
    '--esModuleInterop',
    '--skipLibCheck',
    '--noCheck',
    '--declaration', 'false',
    '--sourceMap', 'false',
  ],
  { cwd: repoRoot, encoding: 'utf8' },
);
assert.equal(compiled.status, 0, `tsc failed:\n${compiled.stdout}\n${compiled.stderr}`);
const { CodexTranscript, codexProjectsRoot, listCodexProjects } = await import(
  pathToFileURL(join(buildDir, 'optimize', 'codexTranscript.js')).href
);

const SECRET = 'super-secret-canary-987';
const SESSION_A = '0193e1a2-0000-7000-8000-0000000000aa';
const SESSION_B = '0193e1a2-0000-7000-8000-0000000000bb';
const SESSION_C = '0193e1a2-0000-7000-8000-0000000000cc';
const DEMO_CWD = 'C:\\repos\\demo';
const OTHER_CWD = 'D:\\work\\other';

const sessionMeta = (id, cwd) => JSON.stringify({
  timestamp: '2026-11-01T10:00:00.000Z', type: 'session_meta',
  payload: { session_id: id, id, timestamp: '2026-11-01T10:00:00.000Z', cwd, originator: 'codex-tui', cli_version: '0.0.0-test', source: 'cli', model_provider: 'test-provider' },
});
const turnContext = (timestamp, model) => JSON.stringify({
  timestamp, type: 'turn_context',
  payload: { cwd: DEMO_CWD, approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, model },
});
const tokenCount = (timestamp, total, last, extra = {}) => JSON.stringify({
  timestamp, type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 200000 }, rate_limits: { primary: { used_percent: 93, window_minutes: 10080 }, ...extra } },
});
const usage = (input, cached, write, output, reasoning) => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write,
  output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output,
});
const responseItem = (timestamp, payload) => JSON.stringify({ timestamp, type: 'response_item', payload });
const eventMsg = (timestamp, payload) => JSON.stringify({ timestamp, type: 'event_msg', payload });

function writeRollout(home, relative, lines) {
  const file = join(home, '.codex', 'sessions', ...relative.split('/'));
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

async function summarize(home, relative, lines, sessionId = SESSION_A, project = DEMO_CWD) {
  const file = writeRollout(home, relative, lines);
  const transcript = new CodexTranscript(sessionId, file, project, statSync(file).size);
  await transcript.read();
  return { file, summary: transcript.summary() };
}

test('token_count is cumulative: the latest snapshot wins, deltas are not summed, rate-limit re-emits do not double-count', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cairn-codex-'));
  try {
    const { summary } = await summarize(home, `2026/11/01/rollout-2026-11-01T10-00-00-${SESSION_A}.jsonl`, [
      sessionMeta(SESSION_A, DEMO_CWD),
      turnContext('2026-11-01T10:00:01.000Z', 'codex-test-model'),
      tokenCount('2026-11-01T10:00:02.000Z', usage(100, 10, 5, 20, 3), usage(100, 10, 5, 20, 3)),
      tokenCount('2026-11-01T10:01:00.000Z', usage(250, 20, 7, 45, 8), usage(150, 10, 2, 25, 5)),
      // Rate-limit-only re-emit: same cumulative, repeated last delta.
      tokenCount('2026-11-01T10:01:01.000Z', usage(250, 20, 7, 45, 8), usage(150, 10, 2, 25, 5), { secondary: null }),
    ]);
    assert.deepEqual(summary.usage, { inputTokens: 250, outputTokens: 45, cacheReadTokens: 20, cacheCreationTokens: 7, reasoningTokens: 8 });
    assert.deepEqual(summary.usageByModel['codex-test-model'], { inputTokens: 250, outputTokens: 45, cacheReadTokens: 20, cacheCreationTokens: 7, reasoningTokens: 8 });
    assert.equal(summary.startedAt, '2026-11-01T10:00:00.000Z');
    assert.equal(summary.endedAt, '2026-11-01T10:01:01.000Z');
    assert.deepEqual(summary.reads, []);
    assert.deepEqual(summary.searches, []);
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes('used_percent'), 'rate limits must never be reported');
    assert.ok(!serialized.includes('window_minutes'), 'rate limit windows must never be reported');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('session timestamps use the chronological bounds when rollout records arrive out of order', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cairn-codex-time-'));
  try {
    const { summary } = await summarize(home, `2026/11/01/rollout-2026-11-01T10-00-00-${SESSION_A}.jsonl`, [
      JSON.stringify({ timestamp: '2026-11-01T11:00:00.000Z', type: 'unknown' }),
      JSON.stringify({ timestamp: '2026-11-01T09:00:00.000Z', type: 'unknown' }),
      JSON.stringify({ timestamp: '2026-11-01T10:00:00.000Z', type: 'unknown' }),
    ]);
    assert.equal(summary.startedAt, '2026-11-01T09:00:00.000Z');
    assert.equal(summary.endedAt, '2026-11-01T11:00:00.000Z');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('token_usage_record cumulative is used once, and a compaction context-window fill is not provider usage', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cairn-codex-'));
  try {
    const record = JSON.stringify({
      timestamp: '2026-11-01T10:02:00.000Z', type: 'token_usage_record',
      payload: { thread_id: SESSION_B, turn_id: 'turn-1', session_id: SESSION_B, root_turn_id: 'turn-1', response_id: 'r1', usage: usage(40, 4, 1, 9, 2), turn_token_usage: usage(40, 4, 1, 9, 2), thread_token_usage: usage(40, 4, 1, 9, 2) },
    });
    const { summary } = await summarize(home, `2026/11/01/rollout-2026-11-01T10-02-00-${SESSION_B}.jsonl`, [
      sessionMeta(SESSION_B, DEMO_CWD),
      turnContext('2026-11-01T10:01:59.000Z', 'codex-test-model'),
      record,
    ], SESSION_B);
    assert.deepEqual(summary.usage, { inputTokens: 40, outputTokens: 9, cacheReadTokens: 4, cacheCreationTokens: 1, reasoningTokens: 2 });

    const fillOnly = await summarize(home, `2026/11/01/rollout-2026-11-01T10-03-00-${SESSION_C}.jsonl`, [
      sessionMeta(SESSION_C, DEMO_CWD),
      turnContext('2026-11-01T10:02:59.000Z', 'codex-test-model'),
      tokenCount('2026-11-01T10:03:00.000Z',
        { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 200000 },
        { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 200000 }),
    ], SESSION_C);
    assert.equal(fillOnly.summary.usage, null);
    assert.deepEqual(fillOnly.summary.usageByModel, {});
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('paired tool records count once, large outputs are measured, and shell/patch/MCP argument secrets never leak', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cairn-codex-'));
  try {
    const big = 'x'.repeat(25000);
    const { summary } = await summarize(home, `2026/11/01/rollout-2026-11-01T10-04-00-${SESSION_A}.jsonl`, [
      sessionMeta(SESSION_A, DEMO_CWD),
      turnContext('2026-11-01T10:03:59.000Z', 'codex-test-model'),
      responseItem('2026-11-01T10:04:01.000Z', { type: 'function_call', call_id: 'call-shell', name: 'shell', arguments: JSON.stringify({ command: `npm test --token ${SECRET}` }) }),
      eventMsg('2026-11-01T10:04:02.000Z', { type: 'exec_command_begin', call_id: 'call-shell', command: ['npm', 'test', `--token=${SECRET}`], cwd: DEMO_CWD, parsed_cmd: [] }),
      responseItem('2026-11-01T10:04:03.000Z', { type: 'function_call_output', call_id: 'call-shell', name: 'shell', output: big }),
      eventMsg('2026-11-01T10:04:04.000Z', { type: 'exec_command_end', call_id: 'call-shell', command: ['npm', 'test'], aggregated_output: big, exit_code: 0, status: 'completed' }),
      eventMsg('2026-11-01T10:04:05.000Z', { type: 'exec_command_output_delta', call_id: 'call-shell', stream: 'stdout', chunk: big }),
      responseItem('2026-11-01T10:04:06.000Z', { type: 'custom_tool_call', call_id: 'call-patch', name: 'apply_patch', input: `*** Begin Patch\n*** Add File: app.ts\n+${SECRET}\n*** End Patch` }),
      eventMsg('2026-11-01T10:04:07.000Z', { type: 'patch_apply_end', call_id: 'call-patch', stdout: 'patched', stderr: '', success: true, status: 'completed', changes: {} }),
      eventMsg('2026-11-01T10:04:08.000Z', { type: 'mcp_tool_call_begin', call_id: 'call-mcp', invocation: { server: 'demo', tool: 'lookup', arguments: { token: SECRET } } }),
      eventMsg('2026-11-01T10:04:09.000Z', { type: 'mcp_tool_call_end', call_id: 'call-mcp', invocation: { server: 'demo', tool: 'lookup', arguments: { token: SECRET } }, result: { content: [{ type: 'text', text: 'small mcp result' }] } }),
      responseItem('2026-11-01T10:04:10.000Z', { type: 'local_shell_call', call_id: 'call-local', status: 'completed', action: { type: 'exec', command: ['git', 'status', SECRET], env: { TOKEN: SECRET } } }),
      responseItem('2026-11-01T10:04:11.000Z', { type: 'function_call_output', call_id: 'call-local', output: [{ type: 'input_text', text: 'clean' }] }),
    ]);
    assert.equal(summary.toolCalls, 4);
    assert.equal(summary.toolResultChars, 25000 + 'patched'.length + 'small mcp result'.length + 'clean'.length);
    assert.equal(summary.largeOutputCount, 1);
    assert.equal(summary.largeOutputChars, 25000);
    assert.equal(summary.largeOutputs[0].tool, 'shell');
    assert.equal(summary.largeOutputs[0].target, 'npm');
    assert.ok(summary.largeOutputs[0].fingerprint);
    const serialized = JSON.stringify(summary);
    for (const leak of [SECRET, 'Begin Patch']) {
      assert.ok(!serialized.includes(leak), `summary must not contain ${leak}`);
    }
    // The MCP call is counted above; like Claude, its tool identity is only surfaced in
    // large-output rows, so a small MCP result correctly leaves no trace in the summary.
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('malformed and unknown lines are tolerated; sessions without token_count have unknown (null) usage', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cairn-codex-'));
  try {
    const { summary } = await summarize(home, `2026/11/01/rollout-2026-11-01T10-05-00-${SESSION_A}.jsonl`, [
      sessionMeta(SESSION_A, DEMO_CWD),
      'not json at all',
      JSON.stringify({ timestamp: '2026-11-01T10:05:01.000Z', type: 'world_state', payload: { full: true, state: {} } }),
      JSON.stringify({ timestamp: '2026-11-01T10:05:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: null } }),
      '{"type":"event_msg","timestamp":"2026-11-0',
    ]);
    assert.equal(summary.lines, 5);
    assert.equal(summary.malformedLines, 2);
    assert.equal(summary.usage, null);
    assert.equal(summary.toolCalls, 0);
    assert.equal(summary.toolResultChars, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('listCodexProjects groups by session_meta cwd, derives session ids from rollout names, and skips non-rollouts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cairn-codex-'));
  try {
    const fileA = writeRollout(home, `2026/11/01/rollout-2026-11-01T10-00-00-${SESSION_A}.jsonl`, [sessionMeta(SESSION_A, DEMO_CWD)]);
    writeRollout(home, `2026/11/02/rollout-2026-11-02T09-00-00-${SESSION_B}.jsonl`, [sessionMeta(SESSION_B, OTHER_CWD)]);
    writeRollout(home, `2026/11/02/rollout-2026-11-02T09-01-00-${SESSION_C}.jsonl`, ['{corrupted first line']);
    writeRollout(home, `2026/11/02/rollout-2026-11-02T09-02-00-${SESSION_B}.jsonl.zst`, [sessionMeta(SESSION_B, OTHER_CWD)]);
    writeRollout(home, '2026/11/02/not-a-rollout.jsonl', [sessionMeta(SESSION_B, OTHER_CWD)]);
    writeRollout(home, `2026/11/03/rollout-2026-11-03T08-00-00-${SESSION_A}_${SESSION_B}.jsonl`, [sessionMeta(SESSION_A, DEMO_CWD)]);

    const listings = await listCodexProjects(home);
    assert.deepEqual(listings.map((listing) => listing.project), [DEMO_CWD, OTHER_CWD, 'unknown']);
    const demo = listings.find((listing) => listing.project === DEMO_CWD);
    assert.deepEqual(demo.sessions.map((session) => session.sessionId), [SESSION_A, SESSION_A]);
    assert.equal(demo.sessions[0].file, fileA);
    assert.equal(demo.sessions[0].bytes, statSync(fileA).size);
    assert.equal(listings.find((listing) => listing.project === OTHER_CWD).sessions.length, 1);
    assert.equal(listings.find((listing) => listing.project === 'unknown').sessions.length, 1);
    assert.equal(listings.reduce((total, listing) => total + listing.sessions.length, 0), 4);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CODEX_HOME overrides the home-derived root; reading a rollout changes nothing on disk', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cairn-codex-home-'));
  const alt = mkdtempSync(join(tmpdir(), 'cairn-codex-alt-'));
  const previous = process.env.CODEX_HOME;
  try {
    writeRollout(alt, `2026/11/01/rollout-2026-11-01T10-00-00-${SESSION_A}.jsonl`, [sessionMeta(SESSION_A, DEMO_CWD)]);
    process.env.CODEX_HOME = join(alt, '.codex');
    assert.equal(codexProjectsRoot(home), join(alt, '.codex', 'sessions'));
    const listings = await listCodexProjects(home);
    assert.equal(listings.length, 1);
    assert.equal(listings[0].project, DEMO_CWD);

    delete process.env.CODEX_HOME;
    assert.equal(codexProjectsRoot(home), join(home, '.codex', 'sessions'));

    const file = listings[0].sessions[0].file;
    const before = readFileSync(file, 'utf8');
    const transcript = new CodexTranscript(SESSION_A, file, DEMO_CWD, statSync(file).size);
    await transcript.read();
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
    rmSync(alt, { recursive: true, force: true });
  }
});
