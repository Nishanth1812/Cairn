import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { stateDbPath } from './stateDb.mjs';

const exec = promisify(execFile);
const base = resolve('.test-tmp');
const cli = resolve('dist/waymark.js');

test('a plain UserPromptSubmit prompt skips hook state and database work', () => {
  const home = mkdtempSync(join(base, 'prompt-hook-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'r'), LOCALAPPDATA: join(home, 'l'), XDG_CONFIG_HOME: join(home, 'c'), XDG_STATE_HOME: join(home, 's'), XDG_CACHE_HOME: join(home, 'k') };
  try {
    const output = execFileSync('node', ['--no-warnings', cli, 'hook', 'user-prompt-submit'], { cwd: process.cwd(), env, encoding: 'utf8', input: JSON.stringify({ prompt: 'Hello, thanks for your help.' }) });
    assert.equal(output, '');
    assert.equal(existsSync(stateDbPath(home)), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

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
    let workerRunning = true;
    for (let tries = 0; tries < 100; tries++) {
      workerRunning = process.platform === 'win32'
        ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).includes(`"${pid}"`)
        : (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
      if (!workerRunning) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(workerRunning, false, 'the detached index worker must exit after releasing the writer lock');
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('parallel first lookups and a hook register and index one fresh repository', async () => {
  const repo = mkdtempSync(join(base, 'parallel-first-repo-'));
  const home = mkdtempSync(join(base, 'parallel-first-home-'));
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
    mkdirSync(join(repo, 'lib'));
    for (let i = 0; i < 300; i++) writeFileSync(join(repo, 'src', `module-${i}.js`), `export function parallelNeedle${i}() { return ${i}; }\n`);
    writeFileSync(join(repo, 'lib', 'entry.js'), 'export function parallelHookNeedle() { return 1; }\n');
    execFileSync('git', ['add', 'src', 'lib'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
    execFileSync('node', ['--no-warnings', cli, 'init'], { env, encoding: 'utf8' });

    const lookups = Array.from({ length: 8 }, (_, index) => exec('node', ['--no-warnings', cli, 'search', 'parallelNeedle', '--json'], {
      cwd: join(repo, index % 2 ? 'lib' : 'src'), env, encoding: 'utf8', windowsHide: true,
    }));
    const hook = exec('node', ['--no-warnings', cli, 'hook', 'user-prompt-submit'], {
      cwd: repo, env, encoding: 'utf8', windowsHide: true, input: JSON.stringify({ prompt: 'parallelHookNeedle', cwd: repo }),
    });
    const settled = await Promise.allSettled([...lookups, hook]);
    for (const outcome of settled) {
      assert.equal(outcome.status, 'fulfilled', outcome.status === 'rejected' ? `${outcome.reason.stderr ?? ''}${outcome.reason.stdout ?? ''}${outcome.reason.message}` : '');
    }
    for (const outcome of settled.slice(0, 8)) assert.equal(JSON.parse(outcome.value.stdout).ok, true);
    assert.doesNotMatch(settled[8].value.stderr, /SqliteError|SQLITE_|database or disk is full|stack/i);

    const dbPath = stateDbPath(home);
    const deadline = Date.now() + 30_000;
    let db;
    while (Date.now() < deadline) {
      db = new Database(dbPath, { readonly: true });
      const active = db.prepare('SELECT COUNT(*) AS n FROM repo_index_state').get().n;
      if (active) break;
      db.close();
      db = undefined;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(db, 'background indexing must finish');
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM repositories').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM index_generations WHERE status = \'ready\'').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM index_generations WHERE status = \'building\'').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM repo_index_state').get().n, 1);
      assert.equal(db.prepare("SELECT g.status FROM repo_index_state s JOIN index_generations g ON g.id = s.active_generation").get().status, 'ready');
      assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    } finally { db.close(); }

    writeFileSync(join(repo, 'lib', 'entry.js'), 'export function parallelHookNeedle() { return 2; }\n');
    const refreshes = await Promise.all(Array.from({ length: 6 }, () => exec('node', ['--no-warnings', cli, 'search', 'parallelHookNeedle', '--json'], {
      cwd: repo, env, encoding: 'utf8', windowsHide: true,
    })));
    for (const result of refreshes) {
      const response = JSON.parse(result.stdout);
      assert.equal(response.ok, true);
      assert.match(JSON.stringify(response.data), /lib[/\\]entry\.js/);
    }
    const check = new Database(dbPath, { readonly: true });
    try {
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM index_generations WHERE status = \'ready\'').get().n, 1);
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM index_generations WHERE status = \'building\'').get().n, 0);
      assert.equal(check.pragma('quick_check', { simple: true }), 'ok');
    } finally { check.close(); }
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('a ready lookup bounds lock waiting and labels results from the last generation as possibly stale', () => {
  const repo = mkdtempSync(join(base, 'index-wait-repo-'));
  const home = mkdtempSync(join(base, 'index-wait-home-'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'r'),
    LOCALAPPDATA: join(home, 'l'),
    XDG_CONFIG_HOME: join(home, 'c'),
    XDG_STATE_HOME: join(home, 's'),
    XDG_CACHE_HOME: join(home, 'k'),
    CAIRN_INDEX_WAIT_MS: '5000',
  };
  let lockPath;
  try {
    execFileSync('git', ['init', '--quiet', '--separate-git-dir', join(home, 'repo-git')], { cwd: repo });
    mkdirSync(join(repo, 'src'));
    const source = join(repo, 'src', 'entry.js');
    writeFileSync(source, 'export function readyGenerationNeedle() { return 1; }\n');
    execFileSync('git', ['add', 'src'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
    const initial = JSON.parse(execFileSync('node', ['--no-warnings', cli, 'search', 'readyGenerationNeedle', '--json'], { cwd: repo, env, encoding: 'utf8' }));
    assert.match(JSON.stringify(initial.data), /entry\.js/);

    const dbPath = stateDbPath(home);
    const db = new Database(dbPath, { readonly: true });
    let repoId;
    try { repoId = db.prepare('SELECT id FROM repositories LIMIT 1').get().id; }
    finally { db.close(); }
    lockPath = `${dbPath}.${createHash('sha1').update(repoId).digest('hex')}.index.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'held-by-test' }));
    writeFileSync(source, 'export function changedOnDisk() { return 2; }\n');

    const started = Date.now();
    const stale = JSON.parse(execFileSync('node', ['--no-warnings', cli, 'search', 'readyGenerationNeedle', '--json'], { cwd: repo, env: { ...env, CAIRN_INDEX_WAIT_MS: '100' }, encoding: 'utf8' }));
    assert.ok(Date.now() - started < 3_000, 'lookup must respect the configured lock wait');
    assert.match(JSON.stringify(stale.data), /entry\.js/, 'serve the last ready generation when refresh cannot acquire its lock');
    assert.match(JSON.stringify(stale.warnings), /last ready generation and may be stale/i);
  } finally {
    if (lockPath) rmSync(lockPath, { force: true });
    rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('warm refreshes detect modified, untracked, deleted, and branch-switched files', () => {
  const repo = mkdtempSync(join(base, 'refresh-fast-path-repo-'));
  const home = mkdtempSync(join(base, 'refresh-fast-path-home-'));
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
  const search = (query) => JSON.parse(execFileSync('node', ['--no-warnings', cli, 'search', query, '--json'], { cwd: repo, env, encoding: 'utf8' }));
  try {
    execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: repo });
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'entry.js'), 'export function initialRefreshNeedle() { return 1; }\n');
    execFileSync('git', ['add', 'src'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'main'], { cwd: repo });
    assert.match(JSON.stringify(search('initialRefreshNeedle').data), /entry\.js/);

    writeFileSync(join(repo, 'src', 'entry.js'), 'export function modifiedRefreshNeedle() { return 2; }\n');
    assert.match(JSON.stringify(search('modifiedRefreshNeedle').data), /entry\.js/);
    writeFileSync(join(repo, 'src', 'untracked.js'), 'export function untrackedRefreshNeedle() { return 3; }\n');
    assert.match(JSON.stringify(search('untrackedRefreshNeedle').data), /untracked\.js/);
    rmSync(join(repo, 'src', 'entry.js'));
    assert.doesNotMatch(JSON.stringify(search('modifiedRefreshNeedle').data), /entry\.js/);
    execFileSync('git', ['checkout', '--', 'src/entry.js'], { cwd: repo });
    rmSync(join(repo, 'src', 'untracked.js'));

    execFileSync('git', ['checkout', '-b', 'other'], { cwd: repo });
    writeFileSync(join(repo, 'src', 'branch.js'), 'export function branchRefreshNeedle() { return 4; }\n');
    execFileSync('git', ['add', 'src'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'other'], { cwd: repo });
    assert.match(JSON.stringify(search('branchRefreshNeedle').data), /branch\.js/);
    execFileSync('git', ['checkout', '--quiet', 'main'], { cwd: repo });
    assert.doesNotMatch(JSON.stringify(search('branchRefreshNeedle').data), /branch\.js/);
    assert.match(JSON.stringify(search('initialRefreshNeedle').data), /entry\.js/);
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('reference sites stay current after edits, file changes, and branch switches', () => {
  const repo = mkdtempSync(join(base, 'reference-refresh-repo-'));
  const home = mkdtempSync(join(base, 'reference-refresh-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'r'), LOCALAPPDATA: join(home, 'l'), XDG_CONFIG_HOME: join(home, 'c'), XDG_STATE_HOME: join(home, 's'), XDG_CACHE_HOME: join(home, 'k') };
  const refs = (symbol) => JSON.parse(execFileSync('node', ['--no-warnings', cli, 'search', '--refs', symbol, '--json'], { cwd: repo, env, encoding: 'utf8' })).data;
  const commit = (message) => {
    execFileSync('git', ['add', 'src'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', message], { cwd: repo });
  };
  try {
    execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: repo });
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'target.js'), 'export function referenceLifecycleNeedle() {}\n');
    writeFileSync(join(repo, 'src', 'caller.js'), 'import { referenceLifecycleNeedle } from "./target.js";\nexport function caller() { return referenceLifecycleNeedle(); }\n');
    commit('main');
    assert.deepEqual(refs('referenceLifecycleNeedle').map(({ path, referenceKind }) => [path, referenceKind]), [['src/caller.js', 'import'], ['src/caller.js', 'call']]);

    writeFileSync(join(repo, 'src', 'target.js'), 'export function referenceEditedNeedle() {}\n');
    writeFileSync(join(repo, 'src', 'caller.js'), 'import { referenceEditedNeedle } from "./target.js";\nexport function caller() { return referenceEditedNeedle(); }\n');
    commit('edit references');
    assert.deepEqual(refs('referenceLifecycleNeedle'), []);
    assert.deepEqual(refs('referenceEditedNeedle').map(({ path }) => path), ['src/caller.js', 'src/caller.js']);

    writeFileSync(join(repo, 'src', 'extra.js'), 'import { referenceEditedNeedle } from "./target.js";\nexport const added = referenceEditedNeedle();\n');
    assert.ok(refs('referenceEditedNeedle').some(({ path }) => path === 'src/extra.js'));
    rmSync(join(repo, 'src', 'extra.js'));
    assert.ok(refs('referenceEditedNeedle').every(({ path }) => path !== 'src/extra.js'));

    execFileSync('git', ['checkout', '-b', 'other'], { cwd: repo });
    writeFileSync(join(repo, 'src', 'branch-target.js'), 'export function branchReferenceNeedle() {}\n');
    writeFileSync(join(repo, 'src', 'branch-caller.js'), 'export function branchCaller() { return branchReferenceNeedle(); }\n');
    commit('branch');
    assert.ok(refs('branchReferenceNeedle').some(({ path }) => path === 'src/branch-caller.js'));
    execFileSync('git', ['checkout', '--quiet', 'main'], { cwd: repo });
    assert.deepEqual(refs('branchReferenceNeedle'), []);
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
test('constraint errors mentioning disk space stay distinct and failed index writes preserve the active generation', () => {
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
    assert.doesNotMatch(message, /state directory|free:|estimated needed|clean --scope indexes/i);

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
    const telemetryResult = execFileSync('node', ['--no-warnings', cli, 'search', 'retryDiskProbe', '--json'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(JSON.parse(telemetryResult).ok, true, 'a trigger constraint should not be reported as disk full or interrupt lookup telemetry');

    const hook = execFileSync('node', ['--no-warnings', cli, 'hook', 'user-prompt-submit'], {
      cwd: repo, env, encoding: 'utf8', input: JSON.stringify({ prompt: 'retryDiskProbe', cwd: repo }),
    });
    assert.doesNotMatch(hook, /SqliteError|SQLITE_FULL|database or disk is full|stack/i);
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});


