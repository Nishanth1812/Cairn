import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

const v1 = `
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL);
CREATE TABLE repositories (
  id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE repo_config_overrides (
  repo_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE index_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('building', 'ready', 'failed')),
  started_at TEXT NOT NULL, completed_at TEXT, UNIQUE(repo_id, fingerprint)
);
CREATE TABLE repo_index_state (
  repo_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  active_generation INTEGER REFERENCES index_generations(id), schema_version INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  generation_id INTEGER NOT NULL REFERENCES index_generations(id) ON DELETE CASCADE, path TEXT NOT NULL,
  content_hash TEXT NOT NULL, mtime_ms INTEGER NOT NULL, size_bytes INTEGER NOT NULL, language TEXT, parser_id TEXT,
  indexed_at TEXT NOT NULL, UNIQUE(generation_id, path)
);
CREATE INDEX idx_files_lookup ON files(repo_id, path);
CREATE TABLE symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
  parent_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE
);
CREATE INDEX idx_symbols_name ON symbols(name);
CREATE TABLE edges (
  source_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE, target_text TEXT, kind TEXT NOT NULL,
  confidence REAL NOT NULL, PRIMARY KEY(source_symbol_id, target_symbol_id, target_text, kind)
);
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, content_hash TEXT NOT NULL,
  safe_text TEXT NOT NULL, token_estimate INTEGER NOT NULL, UNIQUE(file_id, ordinal)
);
CREATE VIRTUAL TABLE chunk_fts USING fts5(
  safe_text, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunk_fts(rowid, safe_text) VALUES (new.id, new.safe_text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, safe_text) VALUES('delete', old.id, old.safe_text);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, safe_text) VALUES('delete', old.id, old.safe_text);
  INSERT INTO chunk_fts(rowid, safe_text) VALUES (new.id, new.safe_text);
END;
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'blocked', 'complete')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, schema_version INTEGER NOT NULL,
  revision TEXT, working_tree_fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, repo_id TEXT REFERENCES repositories(id) ON DELETE SET NULL, harness TEXT NOT NULL,
  model TEXT, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, source TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('provider_reported', 'harness_reported', 'local_parsed', 'estimated')),
  observed_at TEXT NOT NULL, model TEXT, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
  cached_input_tokens INTEGER, cache_write_tokens INTEGER, cost_micros INTEGER, pricing_snapshot_id TEXT,
  confidence REAL, raw_metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE cache_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL, cache_kind TEXT NOT NULL, hit_tokens INTEGER, miss_tokens INTEGER,
  provenance TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE migration_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE,
  imported_at TEXT NOT NULL, target_table TEXT NOT NULL, target_id TEXT NOT NULL
);
`;

const v2 = `
CREATE TABLE transcript_files (path TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL);
CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  tool TEXT NOT NULL, returned_tokens INTEGER NOT NULL, baseline_tokens INTEGER, ms INTEGER, observed_at TEXT NOT NULL);
CREATE INDEX idx_tool_calls_repo_date ON tool_calls(repo_id, observed_at);
CREATE TABLE session_tool_calls (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, tool TEXT NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY(session_id, tool));
`;
// Search looks up each hit's symbols by file; without this every lookup scanned the whole symbols table.
const v3 = `
CREATE INDEX idx_symbols_file ON symbols(file_id);
`;
const migrations = [{ version: 1, sql: v1 }, { version: 2, sql: v2 }, { version: 3, sql: v3 }];
const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');

export function migrate(db: Database.Database, now: () => string = () => new Date().toISOString()): number[] {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const applied = exists
    ? db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as { version: number; checksum: string }[]
    : [];
  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  const latestVersion = Math.max(...known.keys());
  const newer = applied.find((row) => row.version > latestVersion);
  if (newer) throw new Error(`Database schema version ${newer.version} is newer than this Weft supports (${latestVersion}); update Weft before using this database.`);
  for (const row of applied) {
    const migration = known.get(row.version);
    if (!migration) {
      throw new Error(`Database contains unknown migration version ${row.version}; this Weft version cannot safely use it.`);
    }
    if (checksum(migration.sql) !== row.checksum) {
      throw new Error(`Migration checksum mismatch for version ${row.version}`);
    }
  }
  const versions = new Set(applied.map(({ version }) => version));
  const ran: number[] = [];
  for (const migration of migrations) {
    if (versions.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)')
        .run(migration.version, now(), checksum(migration.sql));
    }).immediate();
    ran.push(migration.version);
  }
  return ran;
}
