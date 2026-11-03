// Black-box test of `search`: runs the built CLI against a throwaway git repo and an isolated state directory.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stateDbPath } from './stateDb.mjs';
import { after, before, test } from 'node:test';

const BIN = resolve('dist/waymark.js');
const base = resolve('.test-tmp'); // inside the checkout: the system temp dir is a protected path for auto-onboarding
mkdirSync(base, { recursive: true });
const repo = mkdtempSync(join(base, 'repo-'));
const home = mkdtempSync(join(base, 'waymark-home-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'r'), LOCALAPPDATA: join(home, 'l'), XDG_CONFIG_HOME: join(home, 'c'), XDG_STATE_HOME: join(home, 's'), XDG_CACHE_HOME: join(home, 'k') };
const search = (query) => JSON.parse(execFileSync('node', ['--no-warnings', BIN, 'search', query, '--json'], { cwd: repo, env, encoding: 'utf8' })).data.map((hit) => hit.path);
const searchOutput = (query) => execFileSync('node', ['--no-warnings', BIN, 'search', query, '--json'], { cwd: repo, env, encoding: 'utf8' });
// Windows state layout (config/paths.ts) under the isolated LOCALAPPDATA.
const builtAt = () => {
  const db = new Database(stateDbPath(home), { readonly: true, fileMustExist: true });
  try { return Date.parse(db.prepare('SELECT g.completed_at AS at FROM repo_index_state s JOIN index_generations g ON g.id = s.active_generation').get().at); } finally { db.close(); }
};

before(() => {
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'billing.js'), 'export function computeInvoiceTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n');
  writeFileSync(join(repo, 'src', 'report.js'), 'import { computeInvoiceTotal } from "./billing.js";\nexport const monthly = (items) => computeInvoiceTotal(items) * 12; // computeInvoiceTotal computeInvoiceTotal\n');
  writeFileSync(join(repo, 'src', 'private.js'), 'const key = "-----BEGIN PRIVATE KEY-----MIIE-secret-fixture-should-never-escape-----END PRIVATE KEY-----"; export const genericPemProbe = key.length;\n');
});
after(() => { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

test('an unregistered git repo is registered and indexed on first search, and the definition ranks first', () => {
  assert.equal(search('computeInvoiceTotal')[0], 'src/billing.js');
});

test('PKCS#8 private keys are redacted before search output', () => {
  const output = searchOutput('genericPemProbe');
  assert.match(output, /REDACTED_SECRET:pem-private-key/);
  assert.doesNotMatch(output, /MIIE-secret-fixture-should-never-escape/);
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

test('a search after a directory change with no content change re-stamps the index build time', () => {
  // The directory mtime moves but no file changed: the search must find the index still current and record that.
  mkdirSync(join(repo, 'src', 'probe'));
  rmdirSync(join(repo, 'src', 'probe'));
  search('computeInvoiceTotal');
  assert.ok(builtAt() >= Math.floor(statSync(join(repo, 'src')).mtimeMs));
});

test('words inside a camelCase name match, and so do their stems', () => {
  assert.ok(search('invoice').includes('src/billing.js'));
  assert.ok(search('computing totals').includes('src/billing.js'));
});

test('a small --budget cuts the list and says how many were left out', () => {
  const text = execFileSync('node', ['--no-warnings', BIN, 'search', '--exact', 'computeInvoiceTotal', '--budget', '10'], { cwd: repo, env, encoding: 'utf8' });
  assert.match(text, /\.\.\. \d+ more matches \(raise --limit or --budget\)/);
  assert.equal(text.split('\n').filter((line) => line.startsWith('src/')).length, 1);
});

test('a weak multi-word search points at --exact and --kind; a strong one stays quiet', () => {
  const text = (query) => execFileSync('node', ['--no-warnings', BIN, 'search', query], { cwd: repo, env, encoding: 'utf8' });
  assert.match(text('invoice zzNeverWritten qqNowhere'), /No result contains every word/);
  assert.doesNotMatch(text('computeInvoiceTotal'), /No result contains every word/);
});

test('text search omits comment headers and blank rows between hits', () => {
  writeFileSync(join(repo, 'src', 'commented.js'), '// sharedSignal documentation header\nexport const sharedSignal = 1;\n');
  const text = execFileSync('node', ['--no-warnings', BIN, 'search', 'sharedSignal'], { cwd: repo, env, encoding: 'utf8' });
  assert.match(text, /export const sharedSignal/);
  assert.doesNotMatch(text, /\/\/ sharedSignal/);
  assert.doesNotMatch(text, /\n\n/);
});

test('context shows a window around the match when the only hit is bigger than the budget', () => {
  const padding = Array.from({ length: 400 }, (_, i) => `  const filler${i} = ${i}; // padding that makes this function far larger than the budget`).join('\n');
  writeFileSync(join(repo, 'src', 'long.js'), `export function longRunningJob() {\n${padding}\n  const zzNeedleInside = 1;\n${padding}\n}\n`);
  const text = execFileSync('node', ['--no-warnings', BIN, 'context', 'zzNeedleInside', '--budget', '400'], { cwd: repo, env, encoding: 'utf8' });
  assert.match(text, /zzNeedleInside/);
  assert.ok(text.length < 400 * 6, `expected a clipped window, got ${text.length} chars`);
});

test('context merges adjacent excerpts from the same file into one range', () => {
  writeFileSync(join(repo, 'src', 'adjacent.js'), 'export function alphaNeedle() { return sharedSignal; }\nexport function betaNeedle() { return sharedSignal; }\n');
  const text = execFileSync('node', ['--no-warnings', BIN, 'context', 'sharedSignal', '--limit', '10'], { cwd: repo, env, encoding: 'utf8' });
  assert.match(text, /alphaNeedle/);
  assert.match(text, /betaNeedle/);
  assert.equal((text.match(/src\/adjacent\.js:/g) ?? []).length, 1);
});

test('large symbol chunks stay within 60 lines and retain their symbol name', () => {
  const body = Array.from({ length: 120 }, (_, i) => `  const filler${i} = ${i};`).join('\n');
  writeFileSync(join(repo, 'src', 'large.js'), `export function longSymbol() {\n${body}\n  return zzLargeSymbolNeedle;\n}\n`);
  const rows = JSON.parse(execFileSync('node', ['--no-warnings', BIN, 'search', 'zzLargeSymbolNeedle', '--json'], { cwd: repo, env, encoding: 'utf8' })).data;
  const hit = rows.find((row) => row.path === 'src/large.js');
  assert.ok(hit);
  assert.ok(hit.endLine - hit.startLine + 1 <= 60);
  assert.ok(hit.symbols.includes('longSymbol'));
});

test('search --refs lists the indexed caller of a symbol', () => {
  const rows = JSON.parse(execFileSync('node', ['--no-warnings', BIN, 'search', '--refs', 'computeInvoiceTotal', '--json'], { cwd: repo, env, encoding: 'utf8' })).data;
  assert.deepEqual(rows.map((row) => row.referenceKind), ['import', 'call']);
  assert.equal(rows[1].name, 'monthly');
});

test('search --refs lists imports, re-exports, calls, and module-level sites by line', () => {
  writeFileSync(join(repo, 'src', 'impact-target.js'), 'export function impactTarget() {}\n');
  writeFileSync(join(repo, 'src', 'impact-sites.js'), [
    "import { impactTarget } from './impact-target.js';",
    "export { impactTarget } from './impact-target.js';",
    "export * from './impact-target.js';",
    'const topLevel = impactTarget();',
    'export function inner() { return impactTarget(); }',
    '// impactTarget() is only documentation',
    'const text = "impactTarget()";',
  ].join('\n') + '\n');
  const rows = JSON.parse(execFileSync('node', ['--no-warnings', BIN, 'search', '--refs', 'impactTarget', '--json'], { cwd: repo, env, encoding: 'utf8' })).data;
  assert.deepEqual(rows.map(({ path, line, referenceKind, groupName }) => ({ path, line, referenceKind, groupName })), [
    { path: 'src/impact-sites.js', line: 1, referenceKind: 'import', groupName: 'module level' },
    { path: 'src/impact-sites.js', line: 2, referenceKind: 're-export', groupName: 'module level' },
    { path: 'src/impact-sites.js', line: 3, referenceKind: 're-export', groupName: 'module level' },
    { path: 'src/impact-sites.js', line: 5, referenceKind: 'call', groupName: 'inner' },
    { path: 'src/impact-sites.js', line: 4, referenceKind: 'call', groupName: 'topLevel' },
  ]);
  const output = execFileSync('node', ['--no-warnings', BIN, 'search', '--refs', 'impactTarget'], { cwd: repo, env, encoding: 'utf8' });
  assert.match(output, /src\/impact-sites\.js/);
  assert.match(output, /src\/impact-sites\.js:3.*re-export/);
});

test('search --refs recognizes type imports and named or wildcard type re-exports', () => {
  writeFileSync(join(repo, 'src', 'impact-types.ts'), 'export interface ImpactType {}\n');
  writeFileSync(join(repo, 'src', 'impact-type-sites.ts'), [
    "import type { ImpactType } from './impact-types.js';",
    "export type { ImpactType } from './impact-types.js';",
    "export type * from './impact-types.js';",
  ].join('\n') + '\n');
  const rows = JSON.parse(execFileSync('node', ['--no-warnings', BIN, 'search', '--refs', 'ImpactType', '--json'], { cwd: repo, env, encoding: 'utf8' })).data;
  assert.deepEqual(rows.map(({ line, referenceKind }) => ({ line, referenceKind })), [
    { line: 1, referenceKind: 'import' },
    { line: 2, referenceKind: 're-export' },
    { line: 3, referenceKind: 're-export' },
  ]);
});

test('search --refs reports how many sites --limit and --budget omit', () => {
  const limited = execFileSync('node', ['--no-warnings', BIN, 'search', '--refs', 'impactTarget', '--limit', '2'], { cwd: repo, env, encoding: 'utf8' });
  assert.match(limited, /\.\.\. 3 more reference sites/);
  const budget = execFileSync('node', ['--no-warnings', BIN, 'search', '--refs', 'impactTarget', '--budget', '1'], { cwd: repo, env, encoding: 'utf8' });
  assert.match(budget, /\.\.\. 4 more reference sites/);
  const json = JSON.parse(execFileSync('node', ['--no-warnings', BIN, 'search', '--refs', 'impactTarget', '--limit', '2', '--json'], { cwd: repo, env, encoding: 'utf8' }));
  assert.deepEqual(json.warnings, ['3 more results omitted (raise --limit or --budget)']);
});

test('ranked search and --kind report items omitted by --limit', () => {
  const ranked = execFileSync('node', ['--no-warnings', BIN, 'search', 'invoice', '--limit', '1'], { cwd: repo, env, encoding: 'utf8' });
  assert.match(ranked, /\.\.\. \d+ more results/);
  const kind = execFileSync('node', ['--no-warnings', BIN, 'search', '--kind', 'function', '*', '--limit', '1'], { cwd: repo, env, encoding: 'utf8' });
  assert.match(kind, /\.\.\. \d+ more/);
  const budget = execFileSync('node', ['--no-warnings', BIN, 'search', 'invoice', '--budget', '1'], { cwd: repo, env, encoding: 'utf8' });
  assert.match(budget, /\.\.\. \d+ more results/);
});

test('--version reports the version in package.json', () => {
  const expected = JSON.parse(readFileSync('package.json', 'utf8')).version;
  assert.ok(execFileSync('node', ['--no-warnings', BIN, '--version'], { env, encoding: 'utf8' }).includes(expected));
});

test('a read-only database reports a permissions fix instead of disk cleanup advice', () => {
  const dbPath = stateDbPath(home), mode = statSync(dbPath).mode & 0o777;
  try {
    chmodSync(dbPath, 0o444);
    const result = spawnSync('node', ['--no-warnings', BIN, 'search', 'computeInvoiceTotal', '--json'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, false);
    assert.match(response.errors[0], /not writable.*permissions/i);
    assert.doesNotMatch(response.errors[0], /free disk space|clean --scope indexes/i);
  } finally { chmodSync(dbPath, mode); }
});
