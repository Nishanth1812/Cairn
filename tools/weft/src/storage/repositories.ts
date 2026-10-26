import type Database from 'better-sqlite3';

export interface RepositoryRow {
  id: string; root_path: string; display_name: string; created_at: string; last_seen_at: string; config_json: string;
}
export interface IndexGenerationRow {
  id: number; repo_id: string; fingerprint: string; status: 'building' | 'ready' | 'failed'; started_at: string; completed_at: string | null;
}
export interface FileRow {
  id: number; repo_id: string; generation_id: number; path: string; content_hash: string; mtime_ms: number;
  size_bytes: number; language: string | null; parser_id: string | null; indexed_at: string;
}
export interface SymbolRow {
  id: number; file_id: number; name: string; kind: string; start_line: number; end_line: number; parent_id: number | null;
}
export interface ChunkRow {
  id: number; file_id: number; ordinal: number; start_line: number; end_line: number; content_hash: string;
  safe_text: string; token_estimate: number;
}
export interface TaskRow {
  id: string; repo_id: string; title: string; status: 'active' | 'blocked' | 'complete'; created_at: string; updated_at: string;
}
export interface CheckpointRow {
  id: string; task_id: string; schema_version: number; revision: string | null; working_tree_fingerprint: string;
  payload_json: string; created_at: string;
}

type Repository<Row, Key extends keyof Row, Insert = Omit<Row, Key>> = {
  insert(value: Insert): Row[Key];
  get(id: Row[Key]): Row | undefined;
  list(): Row[];
  update(id: Row[Key], value: Partial<Omit<Row, Key>>): void;
  delete(id: Row[Key]): void;
};

function repository<Row extends object, Key extends keyof Row, Insert = Omit<Row, Key>>(
  db: Database.Database, table: string, key: Key, columns: readonly (keyof Row)[],
): Repository<Row, Key, Insert> {
  const keyName = String(key);
  const insertStatements = new Map<string, Database.Statement>();
  const updateStatements = new Map<string, Database.Statement>();
  const insert = (value: Insert): Row[Key] => {
    const fields = columns.filter((column) => column in (value as object));
    const names = fields.map(String);
    const cacheKey = names.join(',');
    let statement = insertStatements.get(cacheKey);
    if (!statement) {
      statement = db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`);
      insertStatements.set(cacheKey, statement);
    }
    const result = statement.run(...fields.map((field) => (value as Record<string, unknown>)[String(field)]));
    return (keyName in (value as unknown as object) ? (value as unknown as Record<string, unknown>)[keyName] : result.lastInsertRowid) as Row[Key];
  };
  const getStatement = db.prepare(`SELECT * FROM ${table} WHERE ${keyName} = ?`);
  const listStatement = db.prepare(`SELECT * FROM ${table}`);
  const deleteStatement = db.prepare(`DELETE FROM ${table} WHERE ${keyName} = ?`);
  return {
    insert,
    get: (id) => getStatement.get(id) as Row | undefined,
    list: () => listStatement.all() as Row[],
    update: (id, value) => {
      const fields = columns.filter((column) => column !== key && column in value);
      if (!fields.length) return;
      const names = fields.map(String);
      const cacheKey = names.join(',');
      let statement = updateStatements.get(cacheKey);
      if (!statement) {
        statement = db.prepare(`UPDATE ${table} SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE ${keyName} = ?`);
        updateStatements.set(cacheKey, statement);
      }
      statement.run(...fields.map((field) => (value as Record<string, unknown>)[String(field)]), id);
    },
    delete: (id) => { deleteStatement.run(id); },
  };
}

export function createRepositories(db: Database.Database) {
  return {
    repositories: repository<RepositoryRow, 'id', Omit<RepositoryRow, 'id' | 'config_json'> & { config_json?: string }>(db, 'repositories', 'id', ['id', 'root_path', 'display_name', 'created_at', 'last_seen_at', 'config_json']),
    indexGenerations: repository<IndexGenerationRow, 'id', Omit<IndexGenerationRow, 'id' | 'completed_at'> & { completed_at?: string | null }>(db, 'index_generations', 'id', ['id', 'repo_id', 'fingerprint', 'status', 'started_at', 'completed_at']),
    files: repository<FileRow, 'id', Omit<FileRow, 'id' | 'language' | 'parser_id'> & { language?: string | null; parser_id?: string | null }>(db, 'files', 'id', ['id', 'repo_id', 'generation_id', 'path', 'content_hash', 'mtime_ms', 'size_bytes', 'language', 'parser_id', 'indexed_at']),
    symbols: repository<SymbolRow, 'id', Omit<SymbolRow, 'id' | 'parent_id'> & { parent_id?: number | null }>(db, 'symbols', 'id', ['id', 'file_id', 'name', 'kind', 'start_line', 'end_line', 'parent_id']),
    chunks: repository<ChunkRow, 'id'>(db, 'chunks', 'id', ['id', 'file_id', 'ordinal', 'start_line', 'end_line', 'content_hash', 'safe_text', 'token_estimate']),
    tasks: repository<TaskRow, 'id'>(db, 'tasks', 'id', ['id', 'repo_id', 'title', 'status', 'created_at', 'updated_at']),
    checkpoints: repository<CheckpointRow, 'id', Omit<CheckpointRow, 'id' | 'revision'> & { revision?: string | null }>(db, 'checkpoints', 'id', ['id', 'task_id', 'schema_version', 'revision', 'working_tree_fingerprint', 'payload_json', 'created_at']),
  };
}
