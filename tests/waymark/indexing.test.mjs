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
    execFileSync('git', ['init', '--quiet', '--separate-git-dir', join(home, 'repo-git')], { cwd: repo });
    mkdirSync(join(repo, 'src'));
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(repo, 'src', `module-${i}.js`), `export function indexedNeedle${i}() { return ${i}; }\n`);
    }
    execFileSync('git', ['add', 'src'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
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

test('a failed full-disk index preserves the active generation and can be retried', () => {
  const repo = mkdtempSync(join(base, 'index-full-repo-'));
  const home = mkdtempSync(join(base, 'index-full-home-'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'r'),
    LOCALAPPDATA: join(home, 'l'),
    XDG_CONFIG_HOME: join(home, 'c'),
    XDG_STATE_HOME: join(home, 's'),
    XDG_CACHE_HOME: join(home, 'k'),
  };
  try {
    execFileSync('git', ['init', '--quiet', '--separate-git-dir', join(home, 'repo-git')], { cwd: repo });
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'entry.js'), 'export function firstDiskProbe() { return 1; }\n');
    execFileSync('git', ['add', 'src'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
    execFileSync('node', ['--no-warnings', cli, 'init'], { env, encoding: 'utf8' });
    execFileSync('node', ['--no-warnings', cli, 'search', 'firstDiskProbe', '--json'], { cwd: repo, env, encoding: 'utf8' });

    const dbPath = stateDbPath(home);
    const db = new Database(dbPath);
    let repoId;
    let activeGeneration;
    try {
      repoId = db.prepare('SELECT id FROM repositories LIMIT 1').get().id;
      activeGeneration = db.prepare('SELECT active_generation FROM repo_index_state WHERE repo_id = ?').get(repoId).active_generation;
      db.exec("CREATE TRIGGER simulate_disk_full BEFORE INSERT ON files BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
    } finally { db.close(); }

    writeFileSync(join(repo, 'src', 'entry.js'), 'export function firstDiskProbe() { return 2; }\nexport function retryDiskProbe() { return 3; }\n');
    execFileSync('git', ['add', 'src'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'update'], { cwd: repo, stdio: 'ignore' });
    let failure;
    try { execFileSync('node', ['--no-warnings', cli, 'index', repoId, '--force'], { cwd: repo, env, encoding: 'utf8' }); }
    catch (error) { failure = error; }
    assert.ok(failure, 'indexing must fail when SQLite reports a full disk');
    assert.notEqual(failure.status, 0);
    const message = String(failure.stderr);
    assert.match(message, /state directory/i);
    assert.match(message, /free.*needed/i);
    assert.match(message, /clean --scope indexes --yes/);
    assert.match(message, /maxTrackedFiles/);

    const check = new Database(dbPath);
    try {
      assert.equal(check.prepare('SELECT active_generation FROM repo_index_state WHERE repo_id = ?').get(repoId).active_generation, activeGeneration);
      assert.equal(check.prepare("SELECT COUNT(*) AS n FROM index_generations WHERE repo_id = ? AND status = 'building'").get(repoId).n, 0);
      const chunkColumns = check.pragma('table_info(chunks)').map(({ name }) => name);
      assert.ok(chunkColumns.includes('safe_text'));
      assert.ok(chunkColumns.includes('search_extra'));
      assert.ok(!chunkColumns.some((name) => ['search_text', 'path_text', 'symbol_text'].includes(name)));
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM file_search_meta').get().n, check.prepare('SELECT COUNT(*) AS n FROM files').get().n);
      check.exec('DROP TRIGGER simulate_disk_full');
    } finally { check.close(); }

    execFileSync('node', ['--no-warnings', cli, 'index', repoId, '--force'], { cwd: repo, env, encoding: 'utf8' });
    const retried = JSON.parse(execFileSync('node', ['--no-warnings', cli, 'search', 'retryDiskProbe', '--json'], { cwd: repo, env, encoding: 'utf8' }));
    assert.equal(retried.ok, true);
    assert.match(JSON.stringify(retried.data), /entry\.js/);

    const telemetry = new Database(dbPath);
    try { telemetry.exec("CREATE TRIGGER simulate_telemetry_full BEFORE INSERT ON tool_calls BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END"); }
    finally { telemetry.close(); }
    let telemetryFailure;
    try { execFileSync('node', ['--no-warnings', cli, 'search', 'retryDiskProbe', '--json'], { cwd: repo, env, encoding: 'utf8' }); }
    catch (error) { telemetryFailure = error; }
    assert.ok(telemetryFailure);
    assert.notEqual(telemetryFailure.status, 0);
    assert.match(String(telemetryFailure.stdout), /state directory.*free.*needed/i);
    assert.match(String(telemetryFailure.stdout), /clean --scope indexes --yes/);

    const hook = execFileSync('node', ['--no-warnings', cli, 'hook', 'user-prompt-submit'], {
      cwd: repo, env, encoding: 'utf8', input: JSON.stringify({ prompt: 'retryDiskProbe', cwd: repo }),
    });
    assert.doesNotMatch(hook, /SqliteError|SQLITE_FULL|database or disk is full|stack/i);
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});


