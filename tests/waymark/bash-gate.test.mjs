// Black-box test of the Bash search gate: grep, rg and find in Bash count as sweeps; pipe filters and other Bash calls are not searches.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const BIN = resolve('dist/waymark.js');
const base = resolve('.test-tmp'); // inside the checkout: the system temp dir is a protected path for auto-onboarding
mkdirSync(base, { recursive: true });
const repo = mkdtempSync(join(base, 'repo-'));
const home = mkdtempSync(join(tmpdir(), 'waymark-home-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'r'), LOCALAPPDATA: join(home, 'l'), XDG_CONFIG_HOME: join(home, 'c'), XDG_STATE_HOME: join(home, 's'), XDG_CACHE_HOME: join(home, 'k') };
delete env.CLAUDE_CODE_SESSION_ID; // a live session's id would leak into the CLI's lookup records
const cli = (...args) => JSON.parse(execFileSync('node', ['--no-warnings', BIN, ...args, '--json'], { cwd: repo, env, encoding: 'utf8' })).data;
const cliAs = (sessionId, ...args) => JSON.parse(execFileSync('node', ['--no-warnings', BIN, ...args, '--json'], { cwd: repo, env: { ...env, CLAUDE_CODE_SESSION_ID: sessionId }, encoding: 'utf8' })).data;
const dbPath = () => join(env.LOCALAPPDATA, 'weft', 'state', 'weft.db');
// The PreToolUse hook gets the Bash event on stdin, as Claude Code sends it. Returns the decision, or null when the call is allowed silently.
const hook = (event) => {
  const out = execFileSync('node', ['--no-warnings', BIN, 'hook', 'pre-tool-use'], { cwd: event.cwd, env, input: JSON.stringify(event), encoding: 'utf8' });
  return out ? JSON.parse(out).hookSpecificOutput : null;
};
const bash = (sessionId, command, cwd = repo) => hook({ session_id: sessionId, cwd, tool_name: 'Bash', tool_input: { command } });
const read = (sessionId, filePath, ranged = false) => hook({ session_id: sessionId, cwd: repo, tool_name: 'Read', tool_input: ranged ? { file_path: filePath, offset: 1, limit: 20 } : { file_path: filePath } });
const denied = (output) => output?.permissionDecision === 'deny';
const rowsFor = (session) => { const db = new Database(dbPath(), { readonly: true }); try { return db.prepare('SELECT tool FROM tool_calls WHERE session = ?').all(session); } finally { db.close(); } };

before(() => {
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'billing.js'), 'export function computeInvoiceTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n');
  cli('init');
  writeFileSync(join(repo, 'src', 'large.js'), 'const row = 1;\n'.repeat(4000)); // over the 32 KB whole-read threshold
  cli('search', 'computeInvoiceTotal'); // indexes and registers the repo; the hook only records against a registered one
});
after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

test('the first two grep, rg or find commands are denied, then a third needs feedback', () => {
  const session = 'bash-gate-a';
  assert.ok(denied(bash(session, 'grep -rn computeInvoiceTotal src')), 'first search');
  assert.ok(denied(bash(session, 'rg computeInvoiceTotal')), 'second search');
  const third = bash(session, 'find . -name "*.js"');
  assert.ok(denied(third), 'third search without feedback');
  assert.match(third.permissionDecisionReason, /Blocked:/);
  assert.deepEqual(rowsFor(`${session}-`).map((row) => row.tool), ['Bash-search', 'Bash-search', 'Bash-search']);
});

test('a search after a chained command is still gated', () => {
  const session = 'bash-gate-b';
  assert.ok(denied(bash(session, 'cd src && grep -n total billing.js')));
});

test('a pipe filter on another command is not a search and is not recorded', () => {
  const session = 'bash-gate-c';
  assert.equal(bash(session, 'npm test | grep fail'), null);
  assert.equal(bash(session, 'git log --grep=fix'), null);
  assert.equal(bash(session, 'ls -la'), null);
  assert.deepEqual(rowsFor(`${session}-`), []);
});

test('filed feedback lets the agent run a search again', () => {
  const session = 'bash-gate-d';
  cliAs(session, 'search', 'computeInvoiceTotal'); // feedback must cite a query Waymark actually ran in this session
  bash(session, 'grep -r a .');
  bash(session, 'grep -r b .');
  assert.ok(denied(bash(session, 'grep -r c .')));
  cli('feedback', 'search for computeInvoiceTotal returned nothing', '--kind', 'miss', '--session', `${session}-`, '--query', 'computeInvoiceTotal');
  assert.equal(denied(bash(session, 'grep -r c .')), false);
});

test('a whole-file read of a large file is gated', () => {
  const session = 'read-gate-a';
  const big = join(repo, 'src', 'large.js');
  assert.ok(denied(read(session, big)), 'first whole read');
  assert.ok(denied(read(session, big)), 'second whole read');
  assert.ok(denied(read(session, big)), 'third whole read without feedback');
  assert.deepEqual(rowsFor(`${session}-`).map((row) => row.tool).sort(), ['Read-whole', 'Read-whole', 'Read-whole']);
});

test('a ranged read and a small file are not sweeps', () => {
  const session = 'read-gate-b';
  assert.equal(denied(read(session, join(repo, 'src', 'large.js'), true)), false, 'ranged read');
  assert.equal(denied(read(session, join(repo, 'src', 'billing.js'))), false, 'small file');
  assert.deepEqual(rowsFor(`${session}-`).map((row) => row.tool).sort(), ['Read', 'Read']);
});

test('a repo Waymark has not indexed is gated too', () => {
  const other = mkdtempSync(join(base, 'unindexed-'));
  mkdirSync(join(other, '.git'));
  const decision = bash('unindexed-gate', 'grep -r needle .', other);
  assert.ok(denied(decision));
  assert.match(decision.permissionDecisionReason, /indexes the repo on first use/);
  rmSync(other, { recursive: true, force: true });
});

test('feedback under 20 characters is refused and records nothing', () => {
  const session = 'feedback-short';
  assert.throws(() => cli('feedback', '--session', `${session}-`, '--kind', 'miss', '--query', 'computeInvoiceTotal', 'nope'), (error) => /four words and 20 characters/.test(error.stdout));
  assert.deepEqual(rowsFor(`${session}-`), []);
});
