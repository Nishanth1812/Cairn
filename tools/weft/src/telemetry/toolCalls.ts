import type Database from 'better-sqlite3';

export interface ToolCallInput { repoId: string | null; tool: string; returnedTokens: number; baselineTokens: number | null; ms: number | null }

export function recordToolCall(db: Database.Database, call: ToolCallInput): void {
  db.prepare('INSERT INTO tool_calls (repo_id, tool, returned_tokens, baseline_tokens, ms, observed_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(call.repoId, call.tool, call.returnedTokens, call.baselineTokens, call.ms, new Date().toISOString());
}

// Pass chunk rows containing file_id; baseline uses indexed whole-file sizes when available.
export function baselineTokensForChunks(db: Database.Database, repoId: string, chunkRows: Array<{ file_id: number }>): number | null {
  const ids = [...new Set(chunkRows.map((row) => row.file_id))];
  if (!ids.length) return null;
  const rows = db.prepare(`SELECT size_bytes FROM files WHERE repo_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
    .all(repoId, ...ids) as Array<{ size_bytes: number }>;
  return rows.length ? rows.reduce((total, row) => total + Math.ceil(row.size_bytes / 4 * 1.1), 0) : null;
}
