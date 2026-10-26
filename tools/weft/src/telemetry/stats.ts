import type Database from 'better-sqlite3';

export async function getStats(db: Database.Database, since?: string) {
  const usage = db.prepare(`SELECT COUNT(DISTINCT s.id) AS sessions, COALESCE(SUM(u.input_tokens),0) AS input,
    COALESCE(SUM(u.output_tokens),0) AS output, COALESCE(SUM(u.cached_input_tokens),0) AS cached,
    COALESCE(SUM(u.cache_write_tokens),0) AS cacheWrite, SUM(u.cost_micros) AS cost
    FROM sessions s LEFT JOIN usage_events u ON u.session_id=s.id WHERE (? IS NULL OR s.started_at>=?)`)
    .get(since ?? null, since ?? null) as { sessions: number; input: number; output: number; cached: number; cacheWrite: number; cost: number };
  const adoption = db.prepare(`SELECT COUNT(*) AS sessions,
    SUM(CASE WHEN EXISTS (SELECT 1 FROM session_tool_calls t WHERE t.session_id=s.id AND lower(t.tool) LIKE '%weft_%') THEN 1 ELSE 0 END) AS adopted,
    COALESCE(SUM((SELECT SUM(calls) FROM session_tool_calls t WHERE t.session_id=s.id AND lower(t.tool) LIKE '%weft_%')),0) AS weftCalls,
    COALESCE(SUM((SELECT SUM(calls) FROM session_tool_calls t WHERE t.session_id=s.id AND t.tool IN ('Grep','Glob','Read'))),0) AS exploreCalls
    FROM sessions s WHERE (? IS NULL OR s.started_at>=?)`).get(since ?? null, since ?? null) as { sessions: number; adopted: number; weftCalls: number; exploreCalls: number };
  const toolCalls = (hook: boolean) => db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(returned_tokens),0) AS returned, COALESCE(SUM(baseline_tokens),0) AS baseline FROM tool_calls WHERE tool ${hook ? '=' : '!='} 'hook_prompt' AND (? IS NULL OR observed_at>=?)`)
    .get(since ?? null, since ?? null) as { calls: number; returned: number; baseline: number };
  const saved = toolCalls(false);
  const hook = toolCalls(true);
  return { ...usage, cost: usage.cost == null ? null : Number(usage.cost), adoption: { percent: adoption.sessions ? Math.round(adoption.adopted * 100 / adoption.sessions) : 0, sessionsUsingWeft: adoption.adopted, weftCalls: adoption.weftCalls, explorationCalls: adoption.exploreCalls }, toolTokens: saved, promptHook: { injections: hook.calls, returned: hook.returned, baseline: hook.baseline } };
}
