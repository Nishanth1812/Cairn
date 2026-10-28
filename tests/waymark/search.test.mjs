// Black-box test of `search`: runs the built CLI against a throwaway git repo and an isolated state directory.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const BIN = resolve('dist/waymark.js');
const base = resolve('.test-tmp'); // inside the checkout: the system temp dir is a protected path for auto-onboarding
mkdirSync(base, { recursive: true });
const repo = mkdtempSync(join(base, 'repo-'));
const home = mkdtempSync(join(tmpdir(), 'waymark-home-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'r'), LOCALAPPDATA: join(home, 'l'), XDG_CONFIG_HOME: join(home, 'c'), XDG_STATE_HOME: join(home, 's'), XDG_CACHE_HOME: join(home, 'k') };
const search = (query) => JSON.parse(execFileSync('node', ['--no-warnings', BIN, 'search', query, '--json'], { cwd: repo, env, encoding: 'utf8' })).data.map((hit) => hit.path);

before(() => {
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'billing.js'), 'export function computeInvoiceTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n');
  writeFileSync(join(repo, 'src', 'report.js'), 'import { computeInvoiceTotal } from "./billing.js";\nexport const monthly = (items) => computeInvoiceTotal(items) * 12; // computeInvoiceTotal computeInvoiceTotal\n');
});
after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

test('an unregistered git repo is registered and indexed on first search, and the definition ranks first', () => {
  assert.equal(search('computeInvoiceTotal')[0], 'src/billing.js');
});

test('an edited file is searchable immediately', () => {
  writeFileSync(join(repo, 'src', 'billing.js'), 'export function computeInvoiceTotal(items) {\n  return items.length;\n}\nexport const zzEditedProbe = 1;\n');
  assert.deepEqual(search('zzEditedProbe'), ['src/billing.js']);
});

test('a new file is searchable immediately', () => {
  writeFileSync(join(repo, 'src', 'extra.js'), 'export const zzNewFileProbe = 2;\n');
  assert.deepEqual(search('zzNewFileProbe'), ['src/extra.js']);
});

test('a deleted file stops matching', () => {
  unlinkSync(join(repo, 'src', 'extra.js'));
  assert.deepEqual(search('zzNewFileProbe'), []);
});
