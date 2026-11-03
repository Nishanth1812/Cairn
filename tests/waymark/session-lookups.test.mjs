// Black-box test: a CLI lookup is recorded against the Claude Code session that ran it, in the hook's key format.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stateDbPath } from './stateDb.mjs';
import { after, before, test } from 'node:test';

const BIN = resolve('dist/waymark.js');
const base = resolve('.test-tmp'); // inside the checkout: the system temp dir is a protected path for auto-onboarding
mkdirSync(base, { recursive: true });
const repo = mkdtempSync(join(base, 'repo-'));
const home = mkdtempSync(join(tmpdir(), 'waymark-home-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'r'), LOCALAPPDATA: join(home, 'l'), XDG_CONFIG_HOME: join(home, 'c'), XDG_STATE_HOME: join(home, 's'), XDG_CACHE_HOME: join(home, 'k') };
const cli = (...args) => execFileSync('node', ['--no-warnings', BIN, ...args, '--json'], { cwd: repo, env: { ...env, CLAUDE_CODE_SESSION_ID: 'lookup-test' }, encoding: 'utf8' });
const preToolUse = () => execFileSync('node', ['--no-warnings', BIN, 'hook', 'pre-tool-use'], { cwd: repo, env, input: JSON.stringify({ session_id: 'lookup-test', cwd: repo, tool_name: 'Grep', tool_input: { pattern: 'computeInvoiceTotal' } }), encoding: 'utf8' });
const dbPath = () => stateDbPath(home);

before(() => {
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'billing.js'), 'export function computeInvoiceTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n');
  cli('init');
  cli('search', 'computeInvoiceTotal');
});
after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

test('a search run inside a Claude Code session is recorded under that session key', () => {
  const db = new Database(dbPath(), { readonly: true });
  try {
    const rows = db.prepare("SELECT tool, session FROM tool_calls WHERE tool = 'search'").all();
    assert.ok(rows.length >= 1, 'search should be recorded');
    assert.ok(rows.every((row) => row.session === 'lookup-test-'), `session keys: ${rows.map((row) => row.session)}`);
  } finally { db.close(); }
});

test('PreToolUse remains allowed and tracks its advisory under the same session key', () => {
  const output = preToolUse();
  assert.equal(output ? JSON.parse(output).hookSpecificOutput.permissionDecision : undefined, undefined);
  const db = new Database(dbPath(), { readonly: true });
  try {
    const row = db.prepare("SELECT session FROM tool_calls WHERE tool = 'hook_advisory'").get();
    assert.equal(row.session, 'lookup-test-');
  } finally { db.close(); }
});
