// Black-box tests for fixes that came from agent feedback: workspace folders, constants as definitions, prose ranking.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const BIN = resolve('dist/waymark.js');
const base = resolve('.test-tmp'); // inside the checkout: the system temp dir is a protected path for auto-onboarding
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'waymark-ws-')); // outside this checkout, so it is a plain folder rather than part of a repo
const home = mkdtempSync(join(tmpdir(), 'waymark-home-'));
const env = { ...process.env, CLAUDE_CODE_SESSION_ID: undefined, TEMP: join(home, 't'), TMP: join(home, 't'), TMPDIR: join(home, 't'), HOME: home, USERPROFILE: home, APPDATA: join(home, 'r'), LOCALAPPDATA: join(home, 'l'), XDG_CONFIG_HOME: join(home, 'c'), XDG_STATE_HOME: join(home, 's'), XDG_CACHE_HOME: join(home, 'k') };
const run = (cwd, ...args) => spawnSync('node', ['--no-warnings', BIN, ...args], { cwd, env, encoding: 'utf8' });
const repoA = join(root, 'mailer'), repoB = join(root, 'billing');
const execOpts = { cwd: repoA, env, encoding: 'utf8' };

before(() => {
  mkdirSync(join(home, 't'), { recursive: true }); // the child's temp dir, so the workspace under the real temp dir is not a protected path
  for (const repo of [repoA, repoB]) { mkdirSync(join(repo, '.git'), { recursive: true }); mkdirSync(join(repo, 'src')); }
  writeFileSync(join(repoA, 'src', 'mail.ts'), 'export const certificateIssuedTemplate = `<p>Your certificate was issued</p>`;\n\nexport function renderTemplate(name: string) {\n  return name;\n}\n');
  writeFileSync(join(repoA, 'README.md'), '# Mailer\n\nThe certificateIssuedTemplate is the email sent when a certificate is issued.\n');
  writeFileSync(join(repoB, 'src', 'bill.ts'), 'export function invoiceTotal() {\n  return 1;\n}\n');
});
after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

test('a folder holding several repos lists them and registers them, so the retry with a name works', () => {
  const first = run(root, 'search', 'invoiceTotal');
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /holds 2 repos: billing, mailer/);
  const retry = run(root, 'search', 'invoiceTotal', 'billing');
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /bill\.ts/);
});

test('a top-level constant is a definition, and it outranks a README that mentions it', () => {
  const out = JSON.parse(execFileSync('node', ['--no-warnings', BIN, 'search', 'certificateIssuedTemplate', '--json'], execOpts)).data;
  assert.equal(out[0].path, 'src/mail.ts');
  assert.ok(out.some((hit) => hit.path === 'README.md')); // still returned, just lower
});

test('prose ranks normally when the query asks for it', () => {
  const out = JSON.parse(execFileSync('node', ['--no-warnings', BIN, 'search', 'readme mailer', '--json'], execOpts)).data;
  assert.equal(out[0].path, 'README.md');
});
