// Black-box test of adoption: runs the built CLI and its hook against a throwaway git repo and an isolated state directory.
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
const env = { ...process.env, CLAUDE_CODE_SESSION_ID: undefined, HOME: home, USERPROFILE: home, APPDATA: join(home, 'r'), LOCALAPPDATA: join(home, 'l'), XDG_CONFIG_HOME: join(home, 'c'), XDG_STATE_HOME: join(home, 's'), XDG_CACHE_HOME: join(home, 'k') };
const cli = (...args) => JSON.parse(execFileSync('node', ['--no-warnings', BIN, ...args, '--json'], { cwd: repo, env, encoding: 'utf8' })).data;
// The PreToolUse hook gets the tool event on stdin, as Claude Code sends it.
const preToolUse = (tool, toolInput) => execFileSync('node', ['--no-warnings', BIN, 'hook', 'pre-tool-use'], { cwd: repo, env, encoding: 'utf8', input: JSON.stringify({ session_id: 'adoption-test', cwd: repo, tool_name: tool, tool_input: toolInput }) });
const stats = () => cli('stats').adoption;

before(() => {
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'billing.js'), 'export function computeInvoiceTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n');
});
after(() => { rmSync(repo, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); });

test('a fresh state has no lookups and no adoption', () => {
  cli('init');
  assert.deepEqual(stats(), { percent: null, weftCalls: 0, nativeCalls: null, nativeCallsObserved: false });
});

test('the baseline column is gone from the tool_calls table', () => {
  cli('search', 'computeInvoiceTotal');
  const db = new Database(stateDbPath(home), { readonly: true, fileMustExist: true });
  try { assert.equal(db.prepare('PRAGMA table_info(tool_calls)').all().some((column) => column.name === 'baseline_tokens'), false); } finally { db.close(); }
});

test('search calls count as Waymark lookups, native sweeps count as native, ranged reads count as neither', () => {
  cli('search', 'computeInvoiceTotal');
  assert.deepEqual(stats(), { percent: null, weftCalls: 2, nativeCalls: null, nativeCallsObserved: false });
  preToolUse('Grep', { pattern: 'computeInvoiceTotal' }); // advisory output does not change native-call accounting
  preToolUse('Read', { file_path: join(repo, 'src', 'billing.js'), offset: 1, limit: 3 }); // ranged read after a search: not a miss
  assert.deepEqual(stats(), { percent: 67, weftCalls: 2, nativeCalls: 1, nativeCallsObserved: true });
});

test('a lookup followed by a sweep in the same session counts as a fallback; filed feedback is counted', () => {
  const inSession = { ...env, CLAUDE_CODE_SESSION_ID: 'adoption-test' }; // same session key the hook records under
  const run = (...args) => execFileSync('node', ['--no-warnings', BIN, ...args], { cwd: repo, env: inSession, encoding: 'utf8' });
  run('search', 'computeInvoiceTotal'); // answered: the next call is another lookup, not a sweep
  run('search', 'computeInvoiceTotal');
  preToolUse('Grep', { pattern: 'computeInvoiceTotal' }); // fell back after the second lookup
  const { quality } = cli('stats');
  assert.equal(quality.fallbackPercent, 50); // 1 of the 2 session lookups; earlier tests ran with no session
  run('feedback', '--session', 'adoption-test-', '--query', 'computeInvoiceTotal', '--kind', 'miss', 'search returned nothing for the function name');
  assert.equal(cli('stats').quality.feedback.miss, 1);
});

test('reading a file a lookup returned counts as following through; feedback list shows what was filed', () => {
  const inSession = { ...env, CLAUDE_CODE_SESSION_ID: 'adoption-test' };
  execFileSync('node', ['--no-warnings', BIN, 'search', 'computeInvoiceTotal'], { cwd: repo, env: inSession, encoding: 'utf8' });
  preToolUse('Read', { file_path: join(repo, 'src', 'billing.js'), offset: 1, limit: 3 }); // a file that search returned
  // Three lookups in this session so far; only the last was followed by a read of a returned file.
  assert.equal(cli('stats').quality.followThroughPercent, 33);
  const listed = execFileSync('node', ['--no-warnings', BIN, 'feedback', 'list'], { cwd: repo, env, encoding: 'utf8' });
  assert.match(listed, /miss .*\n {2}query: computeInvoiceTotal\n {2}search returned nothing for the function name/);
});
