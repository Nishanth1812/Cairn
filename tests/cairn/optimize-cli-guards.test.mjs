import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const buildDir = mkdtempSync(join(repoRoot, '.cairn-optimize-cli-build-'));
after(() => rmSync(buildDir, { recursive: true, force: true }));

const compiled = spawnSync(process.execPath, [
  join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '--ignoreConfig',
  join(repoRoot, 'src', 'cairn', 'cli', 'optimizeCommand.ts'), '--outDir', buildDir,
  '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022',
  '--esModuleInterop', '--skipLibCheck', '--noCheck', '--declaration', 'false', '--sourceMap', 'false',
], { cwd: repoRoot, encoding: 'utf8' });
assert.equal(compiled.status, 0, `tsc failed:\n${compiled.stdout}\n${compiled.stderr}`);
const { runOptimize } = await import(pathToFileURL(join(buildDir, 'cli', 'optimizeCommand.js')).href);

async function invoke(args) {
  let stdout = '';
  let stderr = '';
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  try { return { code: await runOptimize(args), get stdout() { return stdout; }, get stderr() { return stderr; } }; }
  finally { process.stdout.write = writeOut; process.stderr.write = writeErr; }
}

test('coverage and audit reject unknown options and stray positionals before reading host data', async () => {
  for (const args of [
    ['coverage', '--project', 'secret'],
    ['coverage', '--typo'],
    ['audit', '--consent', '--projct', 'demo'],
    ['audit', '--consent', 'surprise'],
    ['audit', '--sessions', 'help', '--consent'],
  ]) {
    const result = await invoke([...args, '--json']);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(JSON.parse(result.stdout).status, 'invalid_arguments');
  }
});

test('audit help is available without consent or scanning', async () => {
  const result = await invoke(['audit', '--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: cairn optimize/);
});
