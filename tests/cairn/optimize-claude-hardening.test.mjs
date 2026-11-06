import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// Hardening fixtures for the Claude reader: synthetic transcripts only, never a real session.
// Each test writes one project/session and runs the read-only, consent-gated audit CLI.

const bin = resolve('bin/cairn.mjs');
const optimize = (args, home) => spawnSync(process.execPath, [bin, 'optimize', ...args], {
  encoding: 'utf8',
  env: { ...process.env, HOME: home ?? process.env.HOME, USERPROFILE: home ?? process.env.USERPROFILE },
});

const CANARY = 'super-secret-canary-987';
const APP_TEXT = 'fixture app.ts content (synthetic, never a real file)';

const use = (id, tool, input) => ({ type: 'tool_use', id, name: tool, input });
const result = (id, text, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...extra });
const assistant = (timestamp, model, usage, tools) => ({ type: 'assistant', timestamp, message: { model, ...(usage ? { usage } : {}), content: tools ?? [] } });
const userLine = (timestamp, content) => ({ type: 'user', timestamp, message: { content } });

// An assistant line that also carries a message identity: message.id plus the entry's requestId.
const identifiedAssistant = (timestamp, messageId, requestId, usage, tools) => ({
  type: 'assistant', timestamp, requestId,
  message: { id: messageId, model: 'claude-test-model', usage, content: tools ?? [] },
});

const APP = 'C:\\repos\\demo\\src\\app.ts';

function hardeningLines() {
  return [
    // --- provider usage: one response written twice, a separate request, and anonymous lines ---
    // Same message.id + requestId twice: the second is the cumulative final snapshot
    // (output grew 10 -> 50) and replaces the first instead of adding to it. Its Read tool
    // call must still be observed even though its usage is a duplicate.
    JSON.stringify(identifiedAssistant('2026-11-01T10:00:00Z', 'msg_dup', 'req_1',
      { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 }, [])),
    JSON.stringify(identifiedAssistant('2026-11-01T10:00:01Z', 'msg_dup', 'req_1',
      { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 },
      [use('u_read1', 'Read', { file_path: APP })])),
    // A genuinely separate request that happens to reuse the message id under another requestId.
    JSON.stringify(identifiedAssistant('2026-11-01T10:00:02Z', 'msg_dup', 'req_9',
      { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 10 }, [])),
    // Another separate response.
    JSON.stringify(identifiedAssistant('2026-11-01T10:00:03Z', 'msg_other', 'req_2',
      { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 2000, cache_creation_input_tokens: 200 }, [])),
    // No message/request identity at all: each line is counted, never merged or discarded.
    JSON.stringify(assistant('2026-11-01T10:00:04Z', 'claude-test-model',
      { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 5, cache_creation_input_tokens: 5 }, [])),
    JSON.stringify(assistant('2026-11-01T10:00:05Z', 'claude-test-model',
      { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 5, cache_creation_input_tokens: 5 }, [])),
    // --- reads: three spellings of one file; writes/edits of that file must not add reads ---
    JSON.stringify(assistant('2026-11-01T10:01:00Z', 'claude-test-model', null,
      [use('u_read2', 'Read', { file_path: 'C:/repos/demo/src/./app.ts' })])),
    JSON.stringify(assistant('2026-11-01T10:01:01Z', 'claude-test-model', null,
      [use('u_read3', 'Read', { file_path: 'C:\\REPOS\\DEMO\\SRC\\..\\SRC\\app.ts' })])),
    JSON.stringify(assistant('2026-11-01T10:01:02Z', 'claude-test-model', null, [
      use('u_edit1', 'Edit', { file_path: APP, old_string: 'a', new_string: 'b' }),
      use('u_edit2', 'Edit', { file_path: APP, old_string: 'c', new_string: 'd' }),
      use('u_write1', 'Write', { file_path: APP, content: 'fixture' }),
    ])),
    // --- searches: Glob identity ignores path spelling; a different pattern/tool is separate ---
    JSON.stringify(assistant('2026-11-01T10:02:00Z', 'claude-test-model', null, [
      use('g1', 'Glob', { pattern: '**/*.ts', path: 'C:\\repos\\demo' }),
      use('g2', 'Glob', { pattern: '**/*.ts', path: 'C:/REPOS/demo/' }),
      use('g3', 'Glob', { pattern: '**/*.js', path: 'C:\\repos\\demo' }),
      use('s1', 'Grep', { pattern: '**/*.ts', path: 'C:\\repos\\demo' }),
    ])),
    // --- large outputs: a shell command carrying a password canary, and an ordinary command ---
    JSON.stringify(assistant('2026-11-01T10:03:00Z', 'claude-test-model', null, [
      use('b1', 'Bash', { command: `PASSWORD=${CANARY} npm test` }),
      use('b2', 'Bash', { command: 'npm run build' }),
    ])),
    JSON.stringify(userLine('2026-11-01T10:04:00Z', [
      result('u_read1', APP_TEXT), result('u_read2', APP_TEXT), result('u_read3', APP_TEXT),
      result('u_edit1', 'edited once'), result('u_edit2', 'edited twice'), result('u_write1', 'written'),
      result('g1', 'a.ts'), result('g2', 'a.ts'), result('g3', 'a.js'), result('s1', 'match'),
      result('b1', 'x'.repeat(25000)), result('b2', 'y'.repeat(26000)),
    ])),
  ].join('\n');
}

function writeHome() {
  const home = mkdtempSync(join(tmpdir(), 'cairn-optimize-hardening-'));
  const project = join(home, '.claude', 'projects', 'H--Personal-Projects-hardening');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'hardening.jsonl'), hardeningLines(), 'utf8');
  return home;
}

function audit(home) {
  const run = optimize(['audit', '--consent', '--json', '--home', home]);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!run.stdout.includes(CANARY), 'audit output must never contain the password canary');
  assert.ok(!run.stderr.includes(CANARY), 'audit stderr must never contain the password canary');
  return JSON.parse(run.stdout).data;
}

test('counts each message+request usage identity once, keeps the cumulative final snapshot, and keeps separate and anonymous requests', () => {
  const home = writeHome();
  try {
    const report = audit(home);
    // msg_dup/req_1 final snapshot (100/50/1000/100) + msg_dup/req_9 (10/1/10/10)
    // + msg_other/req_2 (200/20/2000/200) + two anonymous lines (5/5/5/5 each).
    assert.deepEqual(report.usage.byModel['claude-test-model'],
      { sessions: 1, inputTokens: 320, outputTokens: 81, cacheReadTokens: 3020, cacheCreationTokens: 320 });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('counts only Reads as reads, and merges path spellings (case, separators, dot segments) into one file', () => {
  const home = writeHome();
  try {
    const report = audit(home);
    const read = report.opportunities.repeatedReads.find((row) => row.path.endsWith('app.ts'));
    assert.ok(read, 'expected one repeated-read row for app.ts');
    assert.equal(read.reads, 3); // the three Read spellings; the two Edits and the Write add none
    assert.equal(read.versions, 1);
    assert.equal(read.identicalRepeats, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Glob search identity merges path spellings without merging other patterns or tools', () => {
  const home = writeHome();
  try {
    const report = audit(home);
    const glob = report.opportunities.repeatedSearches.find((row) => row.tool === 'Glob' && row.pattern === '**/*.ts');
    assert.ok(glob, 'expected one repeated Glob row for **/*.ts');
    assert.equal(glob.calls, 2);
    assert.ok(!report.opportunities.repeatedSearches.some((row) => row.pattern === '**/*.js' || row.tool === 'Grep'),
      'single Glob **/*.js and single Grep must not appear as repeats');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('reports shell commands by executable only, dropping arguments that could hold secrets', () => {
  const home = writeHome();
  try {
    const report = audit(home);
    const big = report.opportunities.largeToolOutputs;
    assert.equal(big.count, 2);
    assert.equal(big.chars, 51_000);
    // Both shells (`npm run build` and the one prefixed with a password assignment) are
    // labeled by executable only; arguments never reach the report.
    assert.deepEqual(big.samples.map((sample) => sample.target), ['npm', 'npm']);
    for (const sample of big.samples) assert.ok(!sample.target.includes(CANARY));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
