// Integration tests for the multi-host audit CLI. Every fixture is synthetic and built in a
// temp directory; no real user transcript or database is ever read.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const bin = resolve('bin/cairn.mjs');
const optimize = (args, home) => spawnSync(process.execPath, [bin, 'optimize', ...args], {
  encoding: 'utf8',
  env: { ...process.env, HOME: home ?? process.env.HOME, USERPROFILE: home ?? process.env.USERPROFILE, SQLITE_USE_URI: '1' },
});
const auditJson = (args, home) => {
  const run = optimize(['audit', '--consent', '--json', ...args], home);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout).data;
};

const SECRET = 'super-secret-hosts-canary-987';
const SESSION_A = '0193e1a2-0000-7000-8000-0000000000aa';
const DEMO_CWD = 'C:\\repos\\demo';

const usage = (input, cached, write, output, reasoning) => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write,
  output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output,
});

function writeClaudeHome() {
  const home = mkdtempSync(join(tmpdir(), 'cairn-hosts-claude-'));
  const projectA = join(home, '.claude', 'projects', 'H--Personal-Projects-demoA');
  const projectB = join(home, '.claude', 'projects', 'Z--Backup-demoA');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-01T10:00:00.000Z', message: { model: 'claude-test-model', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 }, content: [] } }),
  ].join('\n');
  writeFileSync(join(projectA, 's1.jsonl'), lines, 'utf8');
  writeFileSync(join(projectB, 's2.jsonl'), lines, 'utf8');
  return home;
}

function writeCodexHome() {
  const home = mkdtempSync(join(tmpdir(), 'cairn-hosts-codex-'));
  const file = join(home, '.codex', 'sessions', '2026', '11', '01', `rollout-2026-11-01T10-00-00-${SESSION_A}.jsonl`);
  mkdirSync(join(file, '..'), { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: '2026-11-01T10:00:00.000Z', type: 'session_meta', payload: { session_id: SESSION_A, cwd: DEMO_CWD } }),
    JSON.stringify({ timestamp: '2026-11-01T10:00:01.000Z', type: 'turn_context', payload: { model: 'codex-test-model' } }),
    JSON.stringify({ timestamp: '2026-11-01T10:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(250, 20, 7, 45, 8), last_token_usage: usage(250, 20, 7, 45, 8), model_context_window: 200000 }, rate_limits: { primary: { used_percent: 93 } } } }),
    JSON.stringify({ timestamp: '2026-11-01T10:00:03.000Z', type: 'event_msg', payload: { type: 'exec_command_begin', call_id: 'call-shell', command: ['npm', 'test', `--token=${SECRET}`] } }),
    JSON.stringify({ timestamp: '2026-11-01T10:00:04.000Z', type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'call-shell', aggregated_output: 'x'.repeat(25000) } }),
  ].join('\n');
  writeFileSync(file, lines, 'utf8');
  return home;
}

async function writeOpenCodeHome() {
  const home = mkdtempSync(join(tmpdir(), 'cairn-hosts-oc-'));
  const dir = join(home, '.local', 'share', 'opencode');
  mkdirSync(dir, { recursive: true });
  const Database = (await import('better-sqlite3')).default;
  const dbPath = join(dir, 'opencode.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);');
  const t0 = Date.parse('2026-11-01T10:00:00.000Z');
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('ses_fixture', 'proj1', DEMO_CWD, t0, t0 + 60000);
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('msg1', 'ses_fixture', t0 + 1000, JSON.stringify({ role: 'assistant', providerID: 'test-provider', modelID: 'test-model', tokens: { input: 1200, output: 300, reasoning: 40, cache: { read: 500, write: 100 } } }));
  db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt1', 'msg1', 'ses_fixture', t0 + 1000, t0 + 1000, JSON.stringify({ type: 'tool', callID: 'prt1', tool: 'bash', state: { status: 'completed', input: { command: `mytool --token ${SECRET}` }, output: 'x'.repeat(25000) } }));
  db.close();
  return { home, dir, dbPath };
}

test('--host codex audits rollouts end to end and leaks no arguments, rate limits or content', () => {
  const home = writeCodexHome();
  try {
    const report = auditJson(['--host', 'codex', '--home', home], home);
    assert.equal(report.host, 'codex');
    assert.equal(report.bounds.sessionsScanned, 1);
    assert.equal(report.bounds.projectsPresent, 1);
    assert.deepEqual(report.usage.byModel['codex-test-model'],
      { sessions: 1, inputTokens: 250, outputTokens: 45, cacheReadTokens: 20, cacheCreationTokens: 7, reasoningTokens: 8 });
    assert.deepEqual(report.opportunities.repeatedReads, []);
    assert.equal(report.opportunities.largeToolOutputs.count, 1);
    assert.equal(report.opportunities.largeToolOutputs.samples[0].target, 'npm'); // executable only
    assert.equal(report.coverage.id, 'codex');
    const serialized = JSON.stringify(report);
    for (const leak of [SECRET, 'used_percent', 'xxxxxxxxxxxxxxxxxxxxxxxx']) {
      assert.ok(!serialized.includes(leak), `report must not contain ${leak}`);
    }
    assert.match(report.limitations.join('\n'), /Compressed rollouts/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('--host opencode audits the database read-only and creates no sidecars', async () => {
  const { home, dir, dbPath } = await writeOpenCodeHome();
  const listingBefore = readdirSync(dir).sort();
  const statBefore = statSync(dbPath);
  try {
    const report = auditJson(['--host', 'opencode', '--home', home], home);
    assert.equal(report.host, 'opencode');
    assert.equal(report.bounds.sessionsScanned, 1);
    assert.equal(report.bounds.projectsPresent, 1);
    assert.deepEqual(report.usage.byModel['test-provider/test-model'],
      { sessions: 1, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 500, cacheCreationTokens: 100, reasoningTokens: 40 });
    assert.equal(report.opportunities.largeToolOutputs.count, 1);
    assert.equal(report.opportunities.largeToolOutputs.samples[0].target, 'mytool');
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(SECRET), 'report must not contain the canary');
    assert.ok(!serialized.includes('mytool --token'), 'report must not contain raw command text');
    assert.match(report.limitations.join('\n'), /never converts/);
    // Read-only: nothing changed next to the source database.
    assert.deepEqual(readdirSync(dir).sort(), listingBefore);
    assert.equal(statSync(dbPath).mtimeMs, statBefore.mtimeMs);
    assert.ok(!existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`) && !existsSync(`${dbPath}-journal`));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('default host stays Claude Code, and host-scoped project focus works for all three', async () => {
  const claudeHome = writeClaudeHome();
  try {
    const report = auditJson(['--home', claudeHome], claudeHome);
    assert.equal(report.host, 'claude-code');
    assert.equal(report.bounds.projectsScanned, 2);
    const focused = auditJson(['--host', 'claude-code', '--home', claudeHome, '--project', 'H--Personal-Projects-demoA'], claudeHome);
    assert.equal(focused.bounds.projectsScanned, 1);
    assert.equal(focused.scope.project, 'H--Personal-Projects-demoA');
  } finally { rmSync(claudeHome, { recursive: true, force: true }); }

  const codexHome = writeCodexHome();
  try {
    const focused = auditJson(['--host', 'codex', '--home', codexHome, '--project', DEMO_CWD], codexHome);
    assert.equal(focused.bounds.projectsScanned, 1);
  } finally { rmSync(codexHome, { recursive: true, force: true }); }
});

test('invalid host, ambiguous project and misspelled flags fail closed instead of widening the scan', () => {
  const home = writeClaudeHome();
  try {
    const badHost = optimize(['audit', '--consent', '--host', 'gemini', '--home', home], home);
    assert.equal(badHost.status, 2);
    assert.match(badHost.stderr, /not a known host/);

    const ambiguous = optimize(['audit', '--consent', '--home', home, '--project', 'demoA'], home);
    assert.equal(ambiguous.status, 3);
    assert.match(ambiguous.stderr, /ambiguous/);
    assert.match(ambiguous.stderr, /H--Personal-Projects-demoA/);

    const typo = optimize(['audit', '--consent', '--projct', 'demoA', '--home', home], home);
    assert.equal(typo.status, 2);
    assert.match(typo.stderr, /Unknown flag "--projct"/);

    // The literal fallback bucket is never a project you can audit.
    const codexHome = writeCodexHome();
    try {
      const unknown = optimize(['audit', '--consent', '--host', 'codex', '--home', codexHome, '--project', 'unknown'], codexHome);
      assert.equal(unknown.status, 3);
      assert.match(unknown.stderr, /not a real Codex project/);
    } finally { rmSync(codexHome, { recursive: true, force: true }); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('consent names the exact data location for each host; missing data errors carry a JSON envelope', () => {
  const claudeHome = writeClaudeHome();
  try {
    for (const [host, pattern] of [['claude-code', /\.claude[\\/]+projects/], ['codex', /\.codex[\\/]+sessions/], ['opencode', /opencode\.db/]]) {
      const refused = optimize(['audit', '--host', host, '--home', claudeHome], claudeHome);
      assert.equal(refused.status, 3, `${host} must require consent`);
      assert.match(refused.stderr, /requires consent/);
      assert.match(refused.stderr, pattern, `${host} consent text must name its data location`);
    }
  } finally { rmSync(claudeHome, { recursive: true, force: true }); }

  const empty = mkdtempSync(join(tmpdir(), 'cairn-hosts-empty-'));
  try {
    mkdirSync(join(empty, '.codex'), { recursive: true });
    const run = optimize(['audit', '--consent', '--json', '--host', 'codex', '--home', empty], empty);
    assert.equal(run.status, 3);
    const envelope = JSON.parse(run.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.status, 'missing_resource');
    assert.ok(envelope.errors.length > 0);
    assert.match(envelope.errors[0], /No Codex local data found/);
    assert.match(run.stderr, /No Codex local data found/);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});
