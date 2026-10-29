import type Database from 'better-sqlite3';

export function getStats(db: Database.Database, since?: string) {
  const toolCalls = (hook: boolean) => db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(returned_tokens),0) AS returned, COALESCE(SUM(baseline_tokens),0) AS baseline FROM tool_calls WHERE tool ${hook ? '=' : '!='} 'hook_prompt' AND (? IS NULL OR observed_at>=?)`)
    .get(since ?? null, since ?? null) as { calls: number; returned: number; baseline: number };
  const saved = toolCalls(false);
  const hook = toolCalls(true);
  return { toolTokens: saved, promptHook: { injections: hook.calls, returned: hook.returned, baseline: hook.baseline } };
}
