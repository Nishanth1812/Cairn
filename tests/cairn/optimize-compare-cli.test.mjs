import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const buildDir = mkdtempSync(join(repoRoot, '.cairn-optimize-compare-cli-build-'));
after(() => rmSync(buildDir, { recursive: true, force: true }));
const compiled = spawnSync(process.execPath, [
  join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '--ignoreConfig',
  join(repoRoot, 'src', 'cairn', 'cli', 'optimizeCommand.ts'), '--outDir', buildDir,
  '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022',
  '--esModuleInterop', '--skipLibCheck', '--noCheck', '--declaration', 'false', '--sourceMap', 'false',
], { cwd: repoRoot, encoding: 'utf8' });
assert.equal(compiled.status, 0, `tsc failed:\n${compiled.stdout}\n${compiled.stderr}`);
const entry = join(buildDir, 'cli', 'optimizeCommand.js');

const makeReport = (host, tokenCount) => ({
  host, scope: { project: 'C:\\repo\\demo' },
  bounds: { projectsPresent: 1, projectsScanned: 1, sessionsScanned: 1, sessionsSkipped: 0, bytesRead: 10, linesRead: 2, malformedLines: 0 },
  usage: { sessionsWithProviderUsage: 1, sessionsWithoutProviderUsage: 0, byModel: { model: { sessions: 1, inputTokens: tokenCount, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 } } },
  opportunities: { repeatedReads: [], repeatedSearches: [], largeToolOutputs: { count: 0, chars: 0 } },
  coverage: { id: host, categories: { sessions: { coverage: 'observable' }, 'provider usage': { coverage: 'observable' } } },
});

const invoke = (args, cwd) => spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8' });

test('compare reads two explicit reports without host consent and keeps cross-host results side by side', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-compare-cli-'));
  try {
    const baseline = join(dir, 'baseline.json');
    const current = join(dir, 'current.json');
    writeFileSync(baseline, JSON.stringify({ schema_version: 1, data: makeReport('codex', 100) }));
    writeFileSync(current, JSON.stringify(makeReport('opencode', 50)));
    const result = invoke(['compare', '--baseline', baseline, '--current', current, '--current-outcome', 'completed', '--json'], dir);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout).data;
    assert.equal(report.status, 'incomparable');
    assert.equal(report.metrics.inputTokens.baseline, 100);
    assert.equal(report.metrics.inputTokens.current, 50);
    assert.equal(report.metrics.inputTokens.change, null);
    assert.equal(report.taskOutcome.baseline, 'unknown');
    assert.equal(report.taskOutcome.current, 'completed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('compare reports malformed input in the standard JSON error envelope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-compare-error-'));
  try {
  const result = invoke(['compare', '--baseline', 'missing.json', '--current', 'other.json', '--json'], dir);
  assert.equal(result.status, 3);
  assert.match(result.stdout, /^\s*\{/u, `stdout was ${JSON.stringify(result.stdout)}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, 'missing_resource');
  assert.equal(envelope.ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
