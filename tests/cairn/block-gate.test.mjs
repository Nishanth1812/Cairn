// Black-box test that no accumulated lookup state can block a tool.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// The PreToolUse hook gets the tool event on stdin, as Claude Code sends it. Returns the decision, or null when the call is allowed silently.
const hook = (event) => {
  const out = execFileSync('node', ['--no-warnings', BIN, 'hook', 'pre-tool-use'], { cwd: event.cwd, env, input: JSON.stringify(event), encoding: 'utf8' });
  return out ? JSON.parse(out).hookSpecificOutput : null;
};
const bash = (sessionId, command) => hook({ session_id: sessionId, cwd: repo, tool_name: 'Bash', tool_input: { command } });
const edit = (sessionId) => hook({ session_id: sessionId, cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'src', 'billing.js') } });
const read = (sessionId, filePath) => hook({ session_id: sessionId, cwd: repo, tool_name: 'Read', tool_input: { file_path: filePath } });
const denied = (output) => output?.permissionDecision === 'deny';

test('uninstall preserves user instruction text surrounding its managed block', () => {
  const dir = join(home, '.codex');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'AGENTS.md');
  const prefix = 'User instructions\n';
  const suffix = '\nUser notes  \n\n';
  writeFileSync(path, `${prefix}<!-- BEGIN WEFT MANAGED BLOCK -->\nmanaged\n<!-- END WEFT MANAGED BLOCK -->${suffix}`);
  cli('setup', '--harness', 'codex', '--uninstall');
  assert.equal(readFileSync(path, 'utf8'), prefix + suffix);
});

before(() => {
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'billing.js'), 'export function computeInvoiceTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n');
  cli('search', 'computeInvoiceTotal'); // registers and indexes the repo, so the hook treats it as indexed
});
after(() => { rmSync(repo, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); });

test('repeated sweeps never block unrelated tools', () => {
  const session = 'block-a';
  for (let attempt = 0; attempt < 30; attempt++) assert.equal(denied(bash(session, 'grep -rn needle .')), false);
  assert.equal(denied(edit(session)), false);
});

test('Waymark and chained Bash commands remain allowed', () => {
  const session = 'block-b';
  assert.equal(denied(bash(session, 'cairn context search "computeInvoiceTotal"')), false);
  assert.equal(denied(bash(session, 'cairn context search "x" && echo done')), false);
});

test('feedback must cite a query Waymark ran in this session', () => {
  cliAs('block-other', 'search', 'computeInvoiceTotal'); // the query ran in another session
  assert.throws(
    () => cli('feedback', 'the search missed the invoice code', '--kind', 'miss', '--session', 'block-c-', '--query', 'computeInvoiceTotal'),
    (error) => /No Cairn Context search or context with that query ran in this session/.test(error.stdout),
  );
});

test('feedback that cites a query run in this session is stored without unlocking anything', () => {
  const session = 'block-d';
  for (let attempt = 0; attempt < 4; attempt++) assert.equal(denied(bash(session, 'grep -rn needle .')), false);
  assert.equal(denied(edit(session)), false);
  cliAs(session, 'search', 'computeInvoiceTotal');
  cli('feedback', 'search missed the invoice code entirely', '--kind', 'miss', '--session', `${session}-`, '--query', 'computeInvoiceTotal');
  assert.equal(denied(edit(session)), false, 'still allowed');
});

test('image reads are not lookups and do not spend the allowance', () => {
  const session = 'block-e';
  for (let attempt = 0; attempt < 5; attempt++) assert.equal(denied(read(session, join(repo, 'src', 'diagram.png'))), false);
});

test('a Waymark search from a subfolder of the repo works', () => {
  const out = JSON.parse(execFileSync('node', ['--no-warnings', BIN, 'search', 'computeInvoiceTotal', '--json'], { cwd: join(repo, 'src'), env, encoding: 'utf8' }));
  assert.equal(out.ok, true);
});

test('default setup installs instructions only and doctor accepts the no-hook install', () => {
  execFileSync('node', ['--no-warnings', BIN, 'setup', '--harness', 'claude-code', '--dry-run'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(existsSync(join(home, '.claude')), false);
  execFileSync('node', ['--no-warnings', BIN, 'setup', '--harness', 'claude-code'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), false);
  const instructions = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.match(instructions, /Grep\/Read remain fine/);
  assert.match(instructions, /Answer from the Cairn result/);
  assert.doesNotMatch(instructions, /denied|blocked until feedback/i);
  const doctor = JSON.parse(execFileSync('node', ['--no-warnings', BIN, 'doctor', '--json'], { cwd: repo, env, encoding: 'utf8' })).data;
  assert.equal(doctor.integrations.find((item) => item.id === 'claude-code hooks').status, 'installed');
});

test('--hooks installs four lifecycle hooks and doctor accepts them', () => {
  execFileSync('node', ['--no-warnings', BIN, 'setup', '--harness', 'claude-code', '--hooks'], { cwd: repo, env, encoding: 'utf8' });
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['PreCompact', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort());
  const doctor = JSON.parse(execFileSync('node', ['--no-warnings', BIN, 'doctor', '--json'], { cwd: repo, env, encoding: 'utf8' })).data;
  assert.equal(doctor.integrations.find((item) => item.id === 'claude-code hooks').status, 'installed');
});

test('default re-run removes old Cairn hooks, preserves foreign hooks, and dry-run writes nothing', () => {
  const settingsPath = join(home, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.hooks.PreToolUse = [{ matcher: 'Bash|Grep|Glob|Read', hooks: [{ type: 'command', command: 'cairn waymark hook pre-tool-use # weft-hook' }, { type: 'command', command: 'other-tool # foreign' }] }];
  settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: 'other-tool # foreign' }] });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  const before = readFileSync(settingsPath, 'utf8');
  execFileSync('node', ['--no-warnings', BIN, 'setup', '--harness', 'claude-code', '--dry-run'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(readFileSync(settingsPath, 'utf8'), before);
  execFileSync('node', ['--no-warnings', BIN, 'setup', '--harness', 'claude-code'], { cwd: repo, env, encoding: 'utf8' });
  let cleaned = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(cleaned.hooks.PreToolUse[0].hooks.map((hook) => hook.command), ['other-tool # foreign']);
  assert.deepEqual(cleaned.hooks.SessionStart[0].hooks.map((hook) => hook.command), ['other-tool # foreign']);
  assert.deepEqual(Object.keys(cleaned.hooks).sort(), ['PreToolUse', 'SessionStart']);
  execFileSync('node', ['--no-warnings', BIN, 'setup', '--harness', 'claude-code', '--tool-hints'], { cwd: repo, env, encoding: 'utf8' });
  cleaned = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(Object.keys(cleaned.hooks).sort(), ['PreCompact', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort());
  assert.equal(cleaned.hooks.PreToolUse.find((entry) => entry.hooks.some((hook) => hook.command.includes('# weft-hook'))).matcher, 'Bash|Grep|Glob|Read');
  assert.ok(cleaned.hooks.PreToolUse[0].hooks.some((hook) => hook.command === 'other-tool # foreign'));
});
