import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { stateDbPath } from './stateDb.mjs';
import { test } from 'node:test';

const cli = resolve('dist/waymark.js');
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
      assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 13);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reference_sites'").get());
      run('repos', 'list');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 13').get().n, 1);
      db.exec('DROP TABLE reference_index_generations; DROP TABLE reference_sites; DELETE FROM schema_migrations WHERE version = 13;');
    } finally { db.close(); }
    run('repos', 'list');
    const upgraded = new Database(stateDbPath(home), { readonly: true });
    try {
      assert.equal(upgraded.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 13);
      assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reference_index_generations'").get());
    } finally { upgraded.close(); }
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); }
});
