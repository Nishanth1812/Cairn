// Black-box test of the block: once an agent has spent its lookup allowance, every tool is refused until it files feedback that cites a search it ran.
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
// The PreToolUse hook gets the tool event on stdin, as Claude Code sends it. Returns the decision, or null when the call is allowed silently.
const hook = (event) => {
  const out = execFileSync('node', ['--no-warnings', BIN, 'hook', 'pre-tool-use'], { cwd: event.cwd, env, input: JSON.stringify(event), encoding: 'utf8' });
  return out ? JSON.parse(out).hookSpecificOutput : null;
};
const bash = (sessionId, command) => hook({ session_id: sessionId, cwd: repo, tool_name: 'Bash', tool_input: { command } });
const edit = (sessionId) => hook({ session_id: sessionId, cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'src', 'billing.js') } });
const read = (sessionId, filePath) => hook({ session_id: sessionId, cwd: repo, tool_name: 'Read', tool_input: { file_path: filePath } });
const denied = (output) => output?.permissionDecision === 'deny';
const spendAllowance = (session) => { for (let attempt = 0; attempt < 3; attempt++) bash(session, 'grep -rn needle .'); };
const rowsFor = (session) => { const db = new Database(dbPath(), { readonly: true }); try { return db.prepare('SELECT tool FROM tool_calls WHERE session = ?').all(session); } finally { db.close(); } };

before(() => {
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'billing.js'), 'export function computeInvoiceTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n');
  cli('search', 'computeInvoiceTotal'); // registers and indexes the repo, so the hook treats it as indexed
});
after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

test('once the allowance is spent, every tool is blocked until feedback is filed', () => {
  const session = 'block-a';
  spendAllowance(session);
  const blocked = edit(session);
  assert.ok(denied(blocked), 'Edit should be blocked');
  assert.match(blocked.permissionDecisionReason, /every tool is blocked/);
});

test('Waymark commands stay open while blocked; chaining one with another command does not', () => {
  const session = 'block-b';
  spendAllowance(session);
  assert.equal(bash(session, 'cairn waymark search "computeInvoiceTotal"'), null);
  assert.ok(denied(bash(session, 'cairn waymark search "x" && echo done')));
});

test('feedback must cite a query Waymark ran in this session', () => {
  cliAs('block-other', 'search', 'computeInvoiceTotal'); // the query ran in another session
  assert.throws(
    () => cli('feedback', 'the search missed the invoice code', '--kind', 'miss', '--session', 'block-c-', '--query', 'computeInvoiceTotal'),
    (error) => /No Waymark search or context with that query ran in this session/.test(error.stdout),
  );
});

test('feedback that cites a query run in this session unlocks the blocked agent', () => {
  const session = 'block-d';
  spendAllowance(session);
  assert.ok(denied(edit(session)), 'blocked before feedback');
  cliAs(session, 'search', 'computeInvoiceTotal');
  cli('feedback', 'search missed the invoice code entirely', '--kind', 'miss', '--session', `${session}-`, '--query', 'computeInvoiceTotal');
  assert.equal(denied(edit(session)), false, 'allowed after feedback');
});

test('image reads are not lookups and do not spend the allowance', () => {
  const session = 'block-e';
  for (let attempt = 0; attempt < 5; attempt++) assert.equal(denied(read(session, join(repo, 'src', 'diagram.png'))), false);
  assert.deepEqual(rowsFor(`${session}-`), []);
});

test('a Waymark search from a subfolder of the repo works', () => {
  const out = JSON.parse(execFileSync('node', ['--no-warnings', BIN, 'search', 'computeInvoiceTotal', '--json'], { cwd: join(repo, 'src'), env, encoding: 'utf8' }));
  assert.equal(out.ok, true);
});
