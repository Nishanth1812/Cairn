import type Database from 'better-sqlite3';

export interface ToolCallInput { repoId: string | null; tool: string; session: string | null; returnedTokens: number; ms: number | null; query?: string }

export function recordToolCall(db: Database.Database, call: ToolCallInput): void {
  db.prepare('INSERT INTO tool_calls (repo_id, tool, session, returned_tokens, ms, observed_at, query) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(call.repoId, call.tool, call.session, call.returnedTokens, call.ms, new Date().toISOString(), call.query ?? null);
}
