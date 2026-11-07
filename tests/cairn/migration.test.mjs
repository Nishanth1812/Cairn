import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { stateDbPath } from './stateDb.mjs';
import { test } from 'node:test';

const cli = resolve('dist/context.js');
const base = resolve('.test-tmp');
const setup = () => {
  const home = mkdtempSync(join(base, 'migration-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'r'), LOCALAPPDATA: join(home, 'l'), XDG_CONFIG_HOME: join(home, 'c'), XDG_STATE_HOME: join(home, 's'), XDG_CACHE_HOME: join(home, 'k') };
  return { home, env, run: (...args) => execFileSync('node', ['--no-warnings', cli, ...args], { env, encoding: 'utf8' }) };
};

test('reference-sites migration is fresh, upgrades v12, and reruns idempotently', () => {
  const { home, env, run } = setup();
  try {
    run('init');
    const db = new Database(stateDbPath(home));
    try {
      assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 14);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reference_sites'").get());
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='index_directories'").get());
      db.prepare("INSERT INTO repositories (id, root_path, display_name, created_at, last_seen_at) VALUES ('preserved', '/existing', 'existing', 'now', 'now')").run();
      run('repos', 'list');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 13').get().n, 1);
      db.exec('DROP TABLE index_directories; DROP TABLE reference_index_generations; DROP TABLE reference_sites; DELETE FROM schema_migrations WHERE version IN (13, 14);');
    } finally { db.close(); }
    run('repos', 'list');
    const upgraded = new Database(stateDbPath(home), { readonly: true });
    try {
      assert.equal(upgraded.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 14);
      assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reference_index_generations'").get());
      assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='index_directories'").get());
      assert.equal(upgraded.prepare("SELECT COUNT(*) AS n FROM repositories WHERE id = 'preserved'").get().n, 1);
    } finally { upgraded.close(); }
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); }
});
