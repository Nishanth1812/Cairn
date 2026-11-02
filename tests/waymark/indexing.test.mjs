import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { stateDbPath } from './stateDb.mjs';

const exec = promisify(execFile);
const base = resolve('.test-tmp');
const cli = resolve('dist/waymark.js');

test('concurrent first lookups return a bounded indexing notice and share one index', async () => {
  const repo = mkdtempSync(join(base, 'indexing-repo-'));
  const home = mkdtempSync(join(base, 'indexing-home-'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'r'),
    LOCALAPPDATA: join(home, 'l'),
    XDG_CONFIG_HOME: join(home, 'c'),
    XDG_STATE_HOME: join(home, 's'),
    XDG_CACHE_HOME: join(home, 'k'),
    CAIRN_INDEX_WAIT_MS: '1',
  };
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    mkdirSync(join(repo, 'src'));
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(repo, 'src', `module-${i}.js`), `export function indexedNeedle${i}() { return ${i}; }\n`);
    }
    execFileSync('node', ['--no-warnings', cli, 'init'], { env, encoding: 'utf8' });
    const started = Date.now();
    const results = await Promise.all([1, 2].map(() => exec('node', ['--no-warnings', cli, 'search', 'indexedNeedle', '--json'], { cwd: repo, env, encoding: 'utf8', windowsHide: true })));
    assert.ok(Date.now() - started < 5_000, 'first lookup must not wait for the full index');
    for (const result of results) {
      const response = JSON.parse(result.stdout);
      assert.equal(response.ok, true);
      assert.match(JSON.stringify(response.data), /Indexing .* in the background/i);
      assert.match(JSON.stringify(response.data), /use grep for now or retry/i);
    }

    const dbPath = stateDbPath(home);
    const deadline = Date.now() + 30_000;
    let generations = 0;
    while (Date.now() < deadline) {
      const db = new Database(dbPath, { readonly: true });
      try {
        generations = db.prepare("SELECT COUNT(*) AS n FROM index_generations WHERE status = 'ready'").get().n;
        if (generations) break;
      } finally { db.close(); }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(generations, 1, 'concurrent lookups must share one completed index');
    const indexed = execFileSync('node', ['--no-warnings', cli, 'search', 'indexedNeedle299', '--json'], { cwd: repo, env, encoding: 'utf8' });
    assert.match(indexed, /module-299\.js/, 'rebuilt FTS content must be searchable');
    const db = new Database(dbPath, { readonly: true });
    let backgroundLock;
    try {
      const repoId = db.prepare('SELECT id FROM repositories LIMIT 1').get().id;
      backgroundLock = `${dbPath}.${createHash('sha1').update(repoId).digest('hex')}.background.lock`;
    } finally { db.close(); }
    const pid = JSON.parse(readFileSync(backgroundLock, 'utf8')).pid;
    for (let tries = 0; tries < 100; tries++) {
      const running = process.platform === 'win32'
        ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).includes(`"${pid}"`)
        : (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
      if (!running) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});


