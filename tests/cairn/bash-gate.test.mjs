// Black-box test that Bash searches remain allowed and advisory-only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stateDbPath } from './stateDb.mjs';
import { after, before, test } from 'node:test';

const BIN = resolve('dist/context.js');
const base = resolve('.test-tmp'); // inside the checkout: the system temp dir is a protected path for auto-onboarding
mkdirSync(base, { recursive: true });
const repo = mkdtempSync(join(base, 'repo-'));
const home = mkdtempSync(join(tmpdir(), 'cairn-home-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'r'), LOCALAPPDATA: join(home, 'l'), XDG_CONFIG_HOME: join(home, 'c'), XDG_STATE_HOME: join(home, 's'), XDG_CACHE_HOME: join(home, 'k') };
delete env.CLAUDE_CODE_SESSION_ID; // a live session's id would leak into the CLI's lookup records
const cli = (...args) => JSON.parse(execFileSync('node', ['--no-warnings', BIN, ...args, '--json'], { cwd: repo, env, encoding: 'utf8' })).data;
const cliAs = (sessionId, ...args) => JSON.parse(execFileSync('node', ['--no-warnings', BIN, ...args, '--json'], { cwd: repo, env: { ...env, CLAUDE_CODE_SESSION_ID: sessionId }, encoding: 'utf8' })).data;
const dbPath = () => stateDbPath(home);
// The PreToolUse hook gets the Bash event on stdin, as Claude Code sends it. Returns the decision, or null when the call is allowed silently.
const hook = (event) => {
  const out = execFileSync('node', ['--no-warnings', BIN, 'hook', 'pre-tool-use'], { cwd: event.cwd, env, input: JSON.stringify(event), encoding: 'utf8' });
  return out ? JSON.parse(out).hookSpecificOutput : null;
};
const bash = (sessionId, command, cwd = repo) => hook({ session_id: sessionId, cwd, tool_name: 'Bash', tool_input: { command } });
const read = (sessionId, filePath, ranged = false) => hook({ session_id: sessionId, cwd: repo, tool_name: 'Read', tool_input: ranged ? { file_path: filePath, offset: 1, limit: 20 } : { file_path: filePath } });
const allowed = (output) => output?.permissionDecision !== 'deny';
const rowsFor = (session) => { const db = new Database(dbPath(), { readonly: true }); try { return db.prepare('SELECT tool FROM tool_calls WHERE session = ?').all(session); } finally { db.close(); } };

before(() => {
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'billing.js'), 'export function computeInvoiceTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n');
  cli('init');
  writeFileSync(join(repo, 'src', 'large.js'), 'const row = 1;\n'.repeat(4000)); // over the 32 KB whole-read threshold
  cli('search', 'computeInvoiceTotal'); // indexes and registers the repo; the hook only records against a registered one
});
after(() => { rmSync(repo, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); });

test('broad Bash searches are allowed and receive at most two hints per session', () => {
  const session = 'bash-gate-a';
  const first = bash(session, 'grep -rn computeInvoiceTotal src');
  const second = bash(session, 'rg computeInvoiceTotal');
  const third = bash(session, 'find . -name "*.js"');
  assert.ok(allowed(first) && allowed(second) && allowed(third));
  assert.ok(first.additionalContext && second.additionalContext);
  assert.equal(third, null);
  assert.deepEqual(rowsFor(`${session}-`).map((row) => row.tool), ['Bash-search', 'Bash-search', 'Bash-search', 'hook_advisory', 'hook_advisory']);
});

test('a search after a chained command remains allowed', () => {
  const session = 'bash-gate-b';
  assert.equal(bash(session, 'cd src && grep -n total billing.js'), null);
});

test('a pipe filter on another command is not a search and is not recorded', () => {
  const session = 'bash-gate-c';
  assert.equal(bash(session, 'npm test | grep fail'), null);
  assert.equal(bash(session, 'git log --grep=fix'), null);
  assert.equal(bash(session, 'ls -la'), null);
  assert.deepEqual(rowsFor(`${session}-`), []);
});

test('feedback remains optional and broad searches continue without it', () => {
  const session = 'bash-gate-d';
  cliAs(session, 'search', 'computeInvoiceTotal'); // feedback must cite a query Cairn Context actually ran in this session
  bash(session, 'grep -r a .');
  bash(session, 'grep -r b .');
  const before = bash(session, 'grep -r c .');
  assert.ok(allowed(before));
  cli('feedback', 'search for computeInvoiceTotal returned nothing', '--kind', 'miss', '--session', `${session}-`, '--query', 'computeInvoiceTotal');
  assert.ok(allowed(bash(session, 'grep -r c .')));
});

test('a whole-file read of a large file may receive a rate-limited hint', () => {
  const session = 'read-gate-a';
  const big = join(repo, 'src', 'large.js');
  assert.equal(read(session, big)?.permissionDecision, undefined);
  assert.equal(read(session, big)?.permissionDecision, undefined);
  assert.equal(read(session, big), null);
  assert.deepEqual(rowsFor(`${session}-`).map((row) => row.tool).sort(), ['Read-whole', 'Read-whole', 'Read-whole', 'hook_advisory', 'hook_advisory'].sort());
});

test('a ranged read and a small file are not sweeps', () => {
  const session = 'read-gate-b';
  assert.equal(read(session, join(repo, 'src', 'large.js'), true), null, 'ranged read');
  assert.equal(read(session, join(repo, 'src', 'billing.js')), null, 'small file');
  assert.deepEqual(rowsFor(`${session}-`).map((row) => row.tool).sort(), ['Read', 'Read']);
});

test('an unindexed repo receives no hint and is never indexed by the hook', () => {
  const other = mkdtempSync(join(base, 'unindexed-'));
  mkdirSync(join(other, '.git'));
  const decision = bash('unindexed-gate', 'grep -r needle .', other);
  assert.ok(allowed(decision));
  assert.equal(decision, null);
  rmSync(other, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
});

test('feedback under 20 characters is refused and records nothing', () => {
  const session = 'feedback-short';
  assert.throws(() => cli('feedback', '--session', `${session}-`, '--kind', 'miss', '--query', 'computeInvoiceTotal', 'nope'), (error) => /four words and 20 characters/.test(error.stdout));
  assert.deepEqual(rowsFor(`${session}-`), []);
});

test('a search of a file outside the repo is not a code search and is not recorded', () => {
  const session = 'bash-gate-outside';
  const log = join(home, 'test-run.log');
  assert.equal(bash(session, `grep -c FAILED "${log}"`), null);
  assert.equal(bash(session, `grep -n error ${log} | head -5`), null);
  assert.equal(bash(session, `find ${home} -name "*.log"`), null);
  assert.deepEqual(rowsFor(`${session}-`), []);
  assert.ok(allowed(bash(session, `grep -rn computeInvoiceTotal src ${log}`)), 'a repo path alongside stays allowed');
  assert.ok(allowed(bash(session, 'grep -rn computeInvoiceTotal')), 'no path searches the repo and stays allowed');
});
