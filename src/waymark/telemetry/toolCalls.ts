import type Database from 'better-sqlite3';

export interface ToolCallInput { repoId: string | null; tool: string; returnedTokens: number; baselineTokens: number | null; ms: number | null }

export function recordToolCall(db: Database.Database, call: ToolCallInput): void {
  db.prepare('INSERT INTO tool_calls (repo_id, tool, returned_tokens, baseline_tokens, ms, observed_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(call.repoId, call.tool, call.returnedTokens, call.baselineTokens, call.ms, new Date().toISOString());
}

