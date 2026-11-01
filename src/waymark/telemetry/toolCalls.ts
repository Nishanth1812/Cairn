import type Database from 'better-sqlite3';

export interface ToolCallInput { repoId: string | null; tool: string; session: string | null; returnedTokens: number; ms: number | null; query?: string; paths?: string[] }

export function recordToolCall(db: Database.Database, call: ToolCallInput): void {
  db.prepare('INSERT INTO tool_calls (repo_id, tool, session, returned_tokens, ms, observed_at, query, paths) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(call.repoId, call.tool, call.session, call.returnedTokens, call.ms, new Date().toISOString(), call.query ?? null, call.paths?.length ? JSON.stringify(call.paths) : null);
}
