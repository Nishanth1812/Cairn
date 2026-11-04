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
// Baseline tokens were an estimate of what a shell search would have cost; adoption now counts real calls, so the column goes.
const v4 = `
ALTER TABLE tool_calls DROP COLUMN baseline_tokens;
`;
// Per-agent call counts drive the sweep gate; feedback is how an agent reports a Waymark miss or bad output.
const v5 = `
ALTER TABLE tool_calls ADD COLUMN session TEXT;
CREATE INDEX idx_tool_calls_session ON tool_calls(session, tool);
CREATE TABLE lookup_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  session TEXT, kind TEXT NOT NULL CHECK(kind IN ('miss', 'bad_output', 'error')), query TEXT, note TEXT NOT NULL, observed_at TEXT NOT NULL
);
CREATE INDEX idx_lookup_feedback_session ON lookup_feedback(session);
`;
// The query behind each Waymark lookup, so feedback can be checked against a search that actually ran.
const v6 = `
ALTER TABLE tool_calls ADD COLUMN query TEXT;
`;
// The files each lookup returned (search/context) or read (Read), so stats can tell whether an agent used what Waymark found.
const v7 = `
ALTER TABLE tool_calls ADD COLUMN paths TEXT;
`;
// The full-text index now reads search_text (code plus the words inside camelCase names) and stems words, so "indexing" finds "index".
// Existing rows keep plain text until their repo is re-indexed.
const v8 = `
ALTER TABLE chunks ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
DROP TRIGGER chunks_ai; DROP TRIGGER chunks_ad; DROP TRIGGER chunks_au;
DROP TABLE chunk_fts;
UPDATE chunks SET search_text = safe_text;
CREATE VIRTUAL TABLE chunk_fts USING fts5(
  search_text, content='chunks', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunk_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, search_text) VALUES('delete', old.id, old.search_text);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, search_text) VALUES('delete', old.id, old.search_text);
  INSERT INTO chunk_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild');
`;
const v9 = `
ALTER TABLE chunks ADD COLUMN path_text TEXT NOT NULL DEFAULT '';
ALTER TABLE chunks ADD COLUMN symbol_text TEXT NOT NULL DEFAULT '';
UPDATE chunks SET path_text = (SELECT path FROM files WHERE files.id = chunks.file_id);
UPDATE chunks SET symbol_text = COALESCE((SELECT group_concat(name, ' ') FROM symbols WHERE symbols.file_id = chunks.file_id), '');
DROP TRIGGER chunks_ai; DROP TRIGGER chunks_ad; DROP TRIGGER chunks_au;
DROP TABLE chunk_fts;
CREATE VIRTUAL TABLE chunk_fts USING fts5(
  path_text, symbol_text, search_text, content='chunks', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunk_fts(rowid, path_text, symbol_text, search_text) VALUES (new.id, new.path_text, new.symbol_text, new.search_text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, path_text, symbol_text, search_text) VALUES('delete', old.id, old.path_text, old.symbol_text, old.search_text);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, path_text, symbol_text, search_text) VALUES('delete', old.id, old.path_text, old.symbol_text, old.search_text);
  INSERT INTO chunk_fts(rowid, path_text, symbol_text, search_text) VALUES (new.id, new.path_text, new.symbol_text, new.search_text);
END;
INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild');
`;
const v10 = `
CREATE INDEX idx_edges_target_symbol ON edges(target_symbol_id);
`;
// The FTS source view stores file search text once per file; FTS keeps only postings and reads chunk text on demand.
const v11 = `
DROP TRIGGER chunks_ai; DROP TRIGGER chunks_ad; DROP TRIGGER chunks_au;
DROP TABLE chunk_fts;
CREATE TABLE file_search_meta (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  path_text TEXT NOT NULL, symbol_text TEXT NOT NULL
);
INSERT INTO file_search_meta(file_id, path_text, symbol_text)
  SELECT file_id, MAX(path_text), MAX(symbol_text) FROM chunks GROUP BY file_id;
ALTER TABLE chunks ADD COLUMN search_extra TEXT NOT NULL DEFAULT '';
UPDATE chunks SET search_extra = substr(search_text, length(safe_text) + 2)
  WHERE substr(search_text, 1, length(safe_text) + 1) = safe_text || char(10);
ALTER TABLE chunks DROP COLUMN search_text;
ALTER TABLE chunks DROP COLUMN path_text;
ALTER TABLE chunks DROP COLUMN symbol_text;
CREATE VIEW chunk_fts_content AS
  SELECT c.id, m.path_text, m.symbol_text,
    c.safe_text || CASE WHEN c.search_extra = '' THEN '' ELSE char(10) || c.search_extra END AS search_text
  FROM chunks c JOIN file_search_meta m ON m.file_id = c.file_id;
CREATE VIRTUAL TABLE chunk_fts USING fts5(
  path_text, symbol_text, search_text, content='chunk_fts_content', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
);
INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild');
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunk_fts(rowid, path_text, symbol_text, search_text)
    SELECT new.id, m.path_text, m.symbol_text, new.safe_text || CASE WHEN new.search_extra = '' THEN '' ELSE char(10) || new.search_extra END
    FROM file_search_meta m WHERE m.file_id = new.file_id;
END;
CREATE TRIGGER files_bd BEFORE DELETE ON files BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, path_text, symbol_text, search_text)
    SELECT 'delete', c.id, m.path_text, m.symbol_text, c.safe_text || CASE WHEN c.search_extra = '' THEN '' ELSE char(10) || c.search_extra END
    FROM chunks c JOIN file_search_meta m ON m.file_id = c.file_id WHERE c.file_id = old.id;
  DELETE FROM file_search_meta WHERE file_id = old.id;
END;
`;
const v12 = `ALTER TABLE repo_index_state ADD COLUMN git_head TEXT;`;
const v13 = `
CREATE TABLE reference_sites (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, identifier TEXT NOT NULL, line INTEGER NOT NULL,
  group_name TEXT NOT NULL, symbol_kind TEXT NOT NULL, reference_kind TEXT NOT NULL CHECK(reference_kind IN ('call', 'import', 're-export', 'module-level')),
  specifier TEXT, PRIMARY KEY(file_id, line, identifier, reference_kind)
);
CREATE INDEX idx_reference_sites_lookup ON reference_sites(identifier, file_id);
CREATE TABLE reference_index_generations (
  generation_id INTEGER PRIMARY KEY REFERENCES index_generations(id) ON DELETE CASCADE
);
`;
const migrations = [{ version: 1, sql: v1 }, { version: 2, sql: v2 }, { version: 3, sql: v3 }, { version: 4, sql: v4 }, { version: 5, sql: v5 }, { version: 6, sql: v6 }, { version: 7, sql: v7 }, { version: 8, sql: v8 }, { version: 9, sql: v9 }, { version: 10, sql: v10 }, { version: 11, sql: v11 }, { version: 12, sql: v12 }, { version: 13, sql: v13 }];
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
  if (ran.includes(11)) {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
  }
  return ran;
}
