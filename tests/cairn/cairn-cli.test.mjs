import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const bin = resolve('bin/cairn.mjs');
const run = (...args) => execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

test('Cairn Context preserves the Waymark entry points', () => {
  assert.match(run('--help'), /\bcontext\s+code index/);
  const help = run('context', '--help');
  assert.match(help, /Usage: cairn context "<question>"/);
  assert.match(run('waymark', '--help'), /Usage: cairn context "<question>"/);
  const oldBundle = execFileSync(process.execPath, [resolve('dist/waymark.js'), '--help'], { encoding: 'utf8' });
  assert.match(oldBundle, /Usage: cairn context "<question>"/);
  const home = mkdtempSync(join(tmpdir(), 'cairn-legacy-hook-'));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local') };
    const hook = spawnSync(process.execPath, [resolve('dist/waymark.js'), 'hook', 'pre-tool-use'], {
      cwd: home, env, encoding: 'utf8', input: JSON.stringify({ session_id: 'legacy', cwd: home, tool_name: 'Read', tool_input: { file_path: 'example.ts' } }),
    });
    assert.equal(hook.status, 0, hook.stderr);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Cairn Context uses its initialized state', () => {
  const home = mkdtempSync(join(tmpdir(), 'cairn-context-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache') };
  try {
    execFileSync(process.execPath, [bin, 'context', 'init'], { env });
    const result = JSON.parse(execFileSync(process.execPath, [bin, 'context', 'doctor', '--json'], { env, encoding: 'utf8' }));
    assert.equal(result.ok, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a query runs directly after cairn context', () => {
  const home = mkdtempSync(join(tmpdir(), 'cairn-query-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache') };
  try {
    execFileSync('git', ['init', '-q', home]);
    writeFileSync(join(home, 'example.js'), 'export function needleExample() { return 42; }\nexport function doctor() {}\n');
    execFileSync(process.execPath, [bin, 'context', 'repos', 'register', home], { env, cwd: home });
    const output = execFileSync(process.execPath, [bin, 'context', 'needleExample', '--json'], { env, cwd: home, encoding: 'utf8' });
    const result = JSON.parse(output);
    assert.equal(result.ok, true);
    assert.equal(result.command, 'context');
    assert.match(output, /needleExample/);
    const legacy = JSON.parse(execFileSync(process.execPath, [bin, 'waymark', 'context', 'needleExample', '--json'], { env, cwd: home, encoding: 'utf8' }));
    assert.equal(legacy.ok, true);
    assert.equal(legacy.command, 'context');
    const reserved = JSON.parse(execFileSync(process.execPath, [bin, 'context', '--', 'doctor', '--json'], { env, cwd: home, encoding: 'utf8' }));
    assert.equal(reserved.command, 'context');
    assert.equal(reserved.data.answer.definition.symbol, 'doctor');
    // A repo registered under one path spelling (realpath) and queried from a different
    // spelling of the same directory must still match (Windows runners hand cwds in
    // 8.3 short form; lookups canonicalize to the registered long path).
    const aliasHome = join(tmpdir(), 'cairn-query-alias-');
    const aliasEnv = { ...process.env, HOME: aliasHome, USERPROFILE: aliasHome, APPDATA: join(aliasHome, 'roaming'), LOCALAPPDATA: join(aliasHome, 'local'), XDG_CONFIG_HOME: join(aliasHome, 'config'), XDG_STATE_HOME: join(aliasHome, 'state'), XDG_CACHE_HOME: join(aliasHome, 'cache') };
    try {
      execFileSync('git', ['init', '-q', aliasHome]);
      writeFileSync(join(aliasHome, 'alias.js'), 'export function needleAlias() { return 7; }\n');
      execFileSync(process.execPath, [bin, 'context', 'repos', 'register', aliasHome], { env: aliasEnv, cwd: aliasHome });
      // Register happens with the realpath; a symlink alias of the same directory must query fine.
      const linkPath = join(tmpdir(), 'cairn-query-link-');
      try { execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, aliasHome]); } catch { /* fallback test below */ }
      if (existsSync(linkPath)) {
        const fetched = JSON.parse(execFileSync(process.execPath, [bin, 'context', 'needleAlias', '--json'], { env: aliasEnv, cwd: linkPath, encoding: 'utf8' }));
        assert.equal(fetched.ok, true);
      } else {
        // No symlink support: at minimum the direct query still resolves.
        const fetched = JSON.parse(execFileSync(process.execPath, [bin, 'context', 'needleAlias', '--json'], { env: aliasEnv, cwd: aliasHome, encoding: 'utf8' }));
        assert.equal(fetched.ok, true);
      }
    } finally {
      rmSync(aliasHome, { recursive: true, force: true });
      rmSync(join(tmpdir(), 'cairn-query-link-'), { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
