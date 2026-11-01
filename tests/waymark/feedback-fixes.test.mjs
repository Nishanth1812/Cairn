// Black-box tests for fixes that came from agent feedback: workspace folders, constants as definitions, prose ranking,
// exact-match and by-kind lookups, and the line shown for a hit.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const BIN = resolve('dist/waymark.js');
const root = mkdtempSync(join(tmpdir(), 'waymark-ws-')); // outside this checkout, so it is a plain folder rather than part of a repo
const home = mkdtempSync(join(tmpdir(), 'waymark-home-'));
const env = { ...process.env, CLAUDE_CODE_SESSION_ID: undefined, TEMP: join(home, 't'), TMP: join(home, 't'), TMPDIR: join(home, 't'), HOME: home, USERPROFILE: home, APPDATA: join(home, 'r'), LOCALAPPDATA: join(home, 'l'), XDG_CONFIG_HOME: join(home, 'c'), XDG_STATE_HOME: join(home, 's'), XDG_CACHE_HOME: join(home, 'k') };
const run = (cwd, ...args) => spawnSync('node', ['--no-warnings', BIN, ...args], { cwd, env, encoding: 'utf8' });
const json = (cwd, ...args) => JSON.parse(execFileSync('node', ['--no-warnings', BIN, ...args, '--json'], { cwd, env, encoding: 'utf8' })).data;
const repoA = join(root, 'mailer'), repoB = join(root, 'billing');

before(() => {
  mkdirSync(join(home, 't'), { recursive: true }); // the child's temp dir, so the workspace under the real temp dir is not a protected path
  for (const repo of [repoA, repoB]) { mkdirSync(join(repo, 'src'), { recursive: true }); execFileSync('git', ['init', '-q'], { cwd: repo }); }
  writeFileSync(join(repoA, 'src', 'mail.ts'), 'export const certificateIssuedTemplate = `<p>Your certificate was issued</p>`;\n\nexport function renderTemplate(name: string) {\n  return name;\n}\n\nexport class Mailer {\n  send() {\n    return 1;\n  }\n}\n');
  writeFileSync(join(repoA, 'src', 'imports.ts'), "import { certificateIssuedTemplate } from './mail';\nimport { renderTemplate } from './mail';\n");
  writeFileSync(join(repoA, 'README.md'), '# Mailer\n\nThe certificateIssuedTemplate is the email sent when a certificate is issued.\n');
  writeFileSync(join(repoB, 'src', 'bill.ts'), 'export function invoiceTotal() {\n  return 1;\n}\n');
});
after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

test('a folder holding several repos is searched across all of them, with the repo name as a path prefix', () => {
  const out = run(root, 'search', 'invoiceTotal certificateIssuedTemplate');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /billing\/src\/bill\.ts/);
  assert.match(out.stdout, /mailer\/src\/mail\.ts/);
});

test('a top-level constant is a definition, and it outranks a README that mentions it', () => {
  const out = json(repoA, 'search', 'certificateIssuedTemplate');
  assert.equal(out[0].path, 'src/mail.ts');
  assert.ok(out.some((hit) => hit.path === 'README.md')); // still returned, just lower
});

test('a chunk that only imports a name does not outrank its definition', () => {
  const out = json(repoA, 'search', 'renderTemplate');
  assert.equal(out[0].path, 'src/mail.ts');
  assert.ok(out.findIndex((hit) => hit.path === 'src/imports.ts') > 0);
});

test('prose is penalised unless the query asks for it', () => {
  const score = (query) => json(repoA, 'search', query).find((hit) => hit.path === 'README.md').score;
  assert.ok(score('readme certificateIssuedTemplate') > score('certificateIssuedTemplate'));
});

test('--exact lists every line containing the text as file:line, and says when --limit cut the list', () => {
  const all = run(repoA, 'search', 'certificateIssuedTemplate', '--exact');
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /src\/mail\.ts:1 {2}export const certificateIssuedTemplate/);
  assert.match(all.stdout, /src\/imports\.ts:1 /);
  assert.match(all.stdout, /README\.md:3 /);
  assert.match(run(repoA, 'search', 'certificateIssuedTemplate', '--exact', '--limit', '1').stdout, /\.\.\. 2 more matches/);
});

test('--kind lists definitions of that kind, narrowed by the query or all with *', () => {
  assert.match(run(repoA, 'search', 'mail', '--kind', 'class').stdout, /src\/mail\.ts:\d+-\d+ {2}Mailer \(class\)/);
  assert.doesNotMatch(run(repoA, 'search', 'mail', '--kind', 'class').stdout, /renderTemplate/);
  assert.match(run(repoA, 'search', '*', '--kind', 'function').stdout, /renderTemplate \(function\)/);
  assert.notEqual(run(repoA, 'search', '*', '--kind', 'nonsense').status, 0);
});

test('a hit shows the line that matched, not the first line of its chunk', () => {
  const out = run(repoA, 'search', 'Your certificate was issued').stdout;
  assert.match(out, /<p>Your certificate was issued<\/p>/);
});
