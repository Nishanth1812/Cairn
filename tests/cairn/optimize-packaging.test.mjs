import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

test('npm package includes the Optimize bundle and privacy guide', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = spawnSync(npm, ['pack', '--dry-run', '--json'], {
    cwd: resolve('.'), encoding: 'utf8', shell: process.platform === 'win32',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map(({ path }) => path);
  for (const required of ['README.md', 'docs/optimize.md', 'bin/cairn.mjs', 'dist/optimize.js']) {
    assert.ok(files.includes(required), `npm package must include ${required}`);
  }
});
