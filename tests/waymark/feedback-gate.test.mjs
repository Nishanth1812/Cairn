// Black-box test of the sweep gate and `feedback`: runs the built CLI and its hook against a throwaway git repo and an isolated state directory.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
// The PreToolUse hook gets the tool event on stdin, as Claude Code sends it. Session is "<session_id>-<agent_id>".
const grep = (sessionId, agentId) => {
  const out = execFileSync('node', ['--no-warnings', BIN, 'hook', 'pre-tool-use'], { cwd: repo, env, encoding: 'utf8', input: JSON.stringify({ session_id: sessionId, agent_id: agentId, cwd: repo, tool_name: 'Grep', tool_input: { pattern: 'computeInvoiceTotal' } }) });
  return out ? JSON.parse(out).hookSpecificOutput : undefined;
};
const denied = (output) => output?.permissionDecision === 'deny';

before(() => {
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'billing.js'), 'export function computeInvoiceTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n');
  cli('search', 'computeInvoiceTotal'); // registers and indexes the repo, so the hook treats it as indexed
});
after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

test('the first two sweeps of an agent are denied with its key and the feedback command', () => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const output = grep('gate-test');
    assert.equal(denied(output), true, `attempt ${attempt} should be denied`);
    assert.match(output.permissionDecisionReason, /cairn waymark feedback --session "gate-test-"/);
  }
});

test('a third sweep without feedback is blocked until feedback is filed', () => {
  const output = grep('gate-test');
  assert.equal(denied(output), true);
  assert.match(output.permissionDecisionReason, /Blocked:/);
});

test('feedback needs a kind and a note', () => {
  assert.throws(() => cli('feedback', 'search missed it'), /Command failed/);
  assert.throws(() => cli('feedback', '--kind', 'miss', '--session', 'gate-test-'), /Command failed/);
});

test('feedback is stored and lets that agent go on with Grep', () => {
  cliAs('gate-test', 'search', 'computeInvoiceTotal'); // feedback must cite a query this session actually ran
  const recorded = cli('feedback', 'search missed computeInvoiceTotal, grep needed', '--kind', 'miss', '--session', 'gate-test-', '--query', 'computeInvoiceTotal');
  assert.equal(recorded.kind, 'miss');
  const output = grep('gate-test');
  assert.equal(denied(output), false);
  assert.match(output.additionalContext, /Waymark can search this repo/);
});

test('another agent has its own sweep count and is not affected by the first one', () => {
  const output = grep('gate-test', 'sub1'); // a subagent of the same session: key "gate-test-sub1"
  assert.equal(denied(output), true);
  assert.match(output.permissionDecisionReason, /cairn waymark feedback --session "gate-test-sub1"/);
});
