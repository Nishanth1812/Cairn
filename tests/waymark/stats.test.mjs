// Black-box test of adoption: runs the built CLI and its hook against a throwaway git repo and an isolated state directory.
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
const cli = (...args) => JSON.parse(execFileSync('node', ['--no-warnings', BIN, ...args, '--json'], { cwd: repo, env, encoding: 'utf8' })).data;
// The PreToolUse hook gets the tool event on stdin, as Claude Code sends it.
const preToolUse = (tool, toolInput) => execFileSync('node', ['--no-warnings', BIN, 'hook', 'pre-tool-use'], { cwd: repo, env, encoding: 'utf8', input: JSON.stringify({ session_id: 'adoption-test', cwd: repo, tool_name: tool, tool_input: toolInput }) });
const stats = () => cli('stats').adoption;

before(() => {
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'billing.js'), 'export function computeInvoiceTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n');
});
after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

test('a fresh state has no lookups and no adoption', () => {
  cli('init');
  assert.deepEqual(stats(), { percent: null, weftCalls: 0, nativeCalls: 0 });
});

test('the baseline column is gone from the tool_calls table', () => {
  cli('search', 'computeInvoiceTotal');
  const db = new Database(join(home, 'l', 'weft', 'state', 'weft.db'), { readonly: true, fileMustExist: true });
  try { assert.equal(db.prepare('PRAGMA table_info(tool_calls)').all().some((column) => column.name === 'baseline_tokens'), false); } finally { db.close(); }
});

test('search calls count as Waymark lookups, native reads count as native', () => {
  cli('search', 'computeInvoiceTotal');
  assert.deepEqual(stats(), { percent: 100, weftCalls: 2, nativeCalls: 0 });
  preToolUse('Grep', { pattern: 'computeInvoiceTotal' }); // trial denies the first sweep; the call still counts
  preToolUse('Read', { file_path: join(repo, 'src', 'billing.js'), offset: 1, limit: 3 }); // ranged read, still a native lookup
  assert.deepEqual(stats(), { percent: 50, weftCalls: 2, nativeCalls: 2 });
});
