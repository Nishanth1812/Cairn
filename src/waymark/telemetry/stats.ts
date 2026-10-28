import type Database from 'better-sqlite3';
import { odometerRows } from './analytics.js';

const micros = (usd: number) => Math.round(usd * 1_000_000);

export async function getStats(db: Database.Database, since?: string) {
  const rows = await odometerRows(since);
  const sessions = new Set(rows.map((row) => row.session));
  const usage = {
    sessions: sessions.size,
    input: rows.reduce((sum, row) => sum + row.input, 0),
    output: rows.reduce((sum, row) => sum + row.output, 0),
    cached: rows.reduce((sum, row) => sum + row.cacheRead, 0),
    cacheWrite: rows.reduce((sum, row) => sum + row.cacheWrite, 0),
    cost: rows.length ? rows.reduce((sum, row) => sum + micros(row.costUsd), 0) : null,
  };
  const has = (row: { tools?: unknown }, pattern: RegExp) => pattern.test(String(row.tools ?? ''));
  const WAYMARK = /(?:^|,)cairn-waymark(?:,|$)/, SEARCH = /(?:^|,)(Grep|Glob|Read|shell-search)(?:,|$)/;
  const adoptedSessions = new Set(rows.filter((row) => has(row, WAYMARK)).map((row) => row.session));
  const byAgent: Record<string, { waymark: number; search: number }> = {};
  for (const row of rows) {
    const entry = (byAgent[row.tool] ??= { waymark: 0, search: 0 });
    if (has(row, WAYMARK)) entry.waymark++;
    if (has(row, SEARCH)) entry.search++;
  }
  const adoption = {
    percent: usage.sessions ? Math.round(adoptedSessions.size * 100 / usage.sessions) : 0,
    sessionsUsingWaymark: adoptedSessions.size,
    waymarkCalls: rows.filter((row) => has(row, WAYMARK)).length,
    explorationCalls: rows.filter((row) => has(row, SEARCH)).length,
    byAgent,
  };
  const toolCalls = (hook: boolean) => db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(returned_tokens),0) AS returned, COALESCE(SUM(baseline_tokens),0) AS baseline FROM tool_calls WHERE tool ${hook ? '=' : '!='} 'hook_prompt' AND (? IS NULL OR observed_at>=?)`)
    .get(since ?? null, since ?? null) as { calls: number; returned: number; baseline: number };
  const saved = toolCalls(false);
  const hook = toolCalls(true);
  return { ...usage, cost: usage.cost == null ? null : usage.cost, adoption, toolTokens: saved, promptHook: { injections: hook.calls, returned: hook.returned, baseline: hook.baseline } };
}
