import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const buildDir = mkdtempSync(join(repoRoot, '.cairn-optimize-compare-build-'));
after(() => rmSync(buildDir, { recursive: true, force: true }));
const compiled = spawnSync(process.execPath, [
  join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '--ignoreConfig',
  join(repoRoot, 'src', 'cairn', 'optimize', 'compare.ts'), '--outDir', buildDir,
  '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022',
  '--esModuleInterop', '--skipLibCheck', '--noCheck', '--declaration', 'false', '--sourceMap', 'false',
], { cwd: repoRoot, encoding: 'utf8' });
assert.equal(compiled.status, 0, `tsc failed:\n${compiled.stdout}\n${compiled.stderr}`);
const { compareReports } = await import(pathToFileURL(join(buildDir, 'compare.js')).href);

function report(overrides = {}) {
  return {
    host: 'codex', scope: { project: 'C:\\repo\\demo' },
    bounds: { projectsPresent: 1, projectsScanned: 1, sessionsScanned: 2, sessionsSkipped: 0, bytesRead: 100, linesRead: 20, malformedLines: 0 },
    usage: { sessionsWithProviderUsage: 2, sessionsWithoutProviderUsage: 0, byModel: { 'model-a': { sessions: 2, inputTokens: 100, outputTokens: 30, cacheReadTokens: 10, cacheCreationTokens: 5, reasoningTokens: 4 } } },
    opportunities: { repeatedReads: [{ reads: 3, identicalRepeats: 2 }], repeatedSearches: [{ calls: 4 }], largeToolOutputs: { count: 2, chars: 40000 } },
    coverage: { id: 'codex', categories: { sessions: { coverage: 'observable' }, usage: { coverage: 'observable' } } },
    ...overrides,
  };
}

test('comparison reports descriptive deltas only for matching host, project, and coverage', () => {
  const current = report({ bounds: { projectsPresent: 1, projectsScanned: 1, sessionsScanned: 3, sessionsSkipped: 0, bytesRead: 120, linesRead: 30, malformedLines: 0 }, opportunities: { repeatedReads: [{ reads: 1, identicalRepeats: 0 }], repeatedSearches: [{ calls: 2 }], largeToolOutputs: { count: 1, chars: 20000 } } });
  const result = compareReports(report(), current, { baselineOutcome: 'not-completed', currentOutcome: 'completed', baselineElapsedMs: 900, currentElapsedMs: 700 });
  assert.equal(result.status, 'comparable');
  assert.equal(result.metrics.sessionsScanned.change, 1);
  assert.equal(result.metrics.largeToolOutputChars.change, -20000);
  assert.equal(result.metrics.repeatedReads.change, -2);
  assert.equal(result.taskOutcome.change, 'completed-after-not-completed');
  assert.equal(result.elapsedMs.change, -200);
  assert.match(result.notes.join(' '), /[Dd]escriptive/);
});

test('incompatible reports never get numeric deltas; partial reports are labeled and task fields stay unknown', () => {
  const mismatch = compareReports(report(), report({ host: 'opencode', coverage: { id: 'opencode', categories: { sessions: { coverage: 'observable' }, usage: { coverage: 'observable' } } } }));
  assert.equal(mismatch.status, 'incomparable');
  assert.equal(mismatch.metrics.outputTokens.change, null);
  assert.equal(mismatch.metrics.outputTokens.baseline, 30);
  assert.equal(mismatch.metrics.outputTokens.current, 30);
  const partial = compareReports(report(), report({ bounds: { projectsPresent: 1, projectsScanned: 1, sessionsScanned: 1, sessionsSkipped: 1, bytesRead: 50, linesRead: 10, malformedLines: 0 } }));
  assert.equal(partial.status, 'partial');
  assert.equal(partial.taskOutcome.baseline, 'unknown');
  assert.equal(partial.taskOutcome.current, 'unknown');
  assert.equal(partial.elapsedMs.change, null);
});

test('Windows paths compare case-insensitively while POSIX paths preserve case', () => {
  const windows = compareReports(report(), report({ scope: { project: 'c:\\REPO\\DEMO' } }));
  assert.equal(windows.status, 'comparable');
  const posix = compareReports(report({ scope: { project: '/repo/Demo' } }), report({ scope: { project: '/repo/demo' } }));
  assert.equal(posix.status, 'incomparable');
  assert.equal(posix.metrics.sessionsScanned.change, null);
});

test('malformed audit reports are rejected instead of treated as zero', () => {
  assert.throws(() => compareReports({ host: 'codex' }, report()), /Baseline is not a valid/i);
});
