import type Database from 'better-sqlite3';

// Tool names as recorded: the Waymark CLI commands, and the native tools the PreToolUse hook sees.
const WEFT_TOOLS = ['search', 'context'];
// Only sweeps count against adoption: a ranged Read after a Waymark search is the intended flow, not a miss.
const NATIVE_TOOLS = ['Read-whole', 'Grep', 'Glob', 'Bash-search'];

export function getStats(db: Database.Database, since?: string) {
  const rows = db.prepare('SELECT tool, COUNT(*) AS calls, COALESCE(SUM(returned_tokens),0) AS returned FROM tool_calls WHERE (? IS NULL OR observed_at>=?) GROUP BY tool')
    .all(since ?? null, since ?? null) as { tool: string; calls: number; returned: number }[];
  const byTool = new Map(rows.map((row) => [row.tool, row]));
  const sum = (tools: string[], key: 'calls' | 'returned') => tools.reduce((total, tool) => total + (byTool.get(tool)?.[key] ?? 0), 0);
  const weftCalls = sum(WEFT_TOOLS, 'calls'), nativeCalls = sum(NATIVE_TOOLS, 'calls');
  const hook = byTool.get('hook_prompt');
  return {
    adoption: { percent: weftCalls + nativeCalls ? Math.round(100 * weftCalls / (weftCalls + nativeCalls)) : null, weftCalls, nativeCalls },
    toolTokens: { calls: weftCalls, returned: sum(WEFT_TOOLS, 'returned') },
    promptHook: { injections: hook?.calls ?? 0, returned: hook?.returned ?? 0 },
    quality: qualityStats(db, since),
    byRepo: db.prepare(`SELECT r.display_name AS repo, COUNT(*) AS lookups, COALESCE(SUM(t.returned_tokens), 0) AS returned FROM tool_calls t JOIN repositories r ON r.id = t.repo_id
      WHERE t.tool IN ('search','context') AND (? IS NULL OR t.observed_at>=?) GROUP BY r.id ORDER BY lookups DESC LIMIT 10`).all(since ?? null, since ?? null) as { repo: string; lookups: number; returned: number }[],
  };
}

const SWEEPS = NATIVE_TOOLS.map((tool) => `'${tool}'`).join(',');

/** Did Waymark answer, or did the agent fall back? Everything comes from rows already written; nothing is estimated. */
function qualityStats(db: Database.Database, since?: string) {
  const s = since ?? null;
  // A lookup "fell back" when the same session ran a sweep after it and before its next Waymark lookup.
  const fallback = db.prepare(`SELECT COUNT(*) AS lookups, COALESCE(SUM(EXISTS(
      SELECT 1 FROM tool_calls n WHERE n.session = t.session AND n.tool IN (${SWEEPS}) AND n.id > t.id
        AND n.id < COALESCE((SELECT MIN(w.id) FROM tool_calls w WHERE w.session = t.session AND w.tool IN ('search','context') AND w.id > t.id), 9223372036854775807))), 0) AS fellBack
    FROM tool_calls t WHERE t.tool IN ('search','context') AND t.session IS NOT NULL AND (? IS NULL OR t.observed_at>=?)`).get(s, s) as { lookups: number; fellBack: number };
  const feedback = db.prepare('SELECT kind, COUNT(*) AS n FROM lookup_feedback WHERE (? IS NULL OR observed_at>=?) GROUP BY kind').all(s, s) as { kind: string; n: number }[];
  return {
    followThroughPercent: followThrough(db, s),
    fallbackPercent: fallback.lookups ? Math.round(100 * fallback.fellBack / fallback.lookups) : null,
    feedback: Object.fromEntries(['miss', 'bad_output', 'error'].map((kind) => [kind, feedback.find((r) => r.kind === kind)?.n ?? 0])),
  };
}

/**
 * Of the lookups that returned files, how many were followed (same session, before the next lookup) by a Read of one of them.
 * The closest observable signal that the result was useful; `null` until lookups with recorded paths exist.
 */
function followThrough(db: Database.Database, since: string | null): number | null {
  const rows = db.prepare(`SELECT session, tool, paths FROM tool_calls WHERE session IS NOT NULL AND tool IN ('search','context','Read','Read-whole') AND (paths IS NOT NULL OR tool IN ('search','context'))
    AND (? IS NULL OR observed_at>=?) ORDER BY session, id`).all(since, since) as { session: string; tool: string; paths: string | null }[];
  let eligible = 0, used = 0, session = '', open: Set<string> | null = null, hit = false;
  const close = () => { if (open) { eligible++; if (hit) used++; } open = null; hit = false; };
  for (const row of rows) {
    if (row.session !== session) { close(); session = row.session; }
    const paths = row.paths ? JSON.parse(row.paths) as string[] : [];
    if (row.tool === 'search' || row.tool === 'context') { close(); open = paths.length ? new Set(paths) : null; } // a lookup that returned nothing still ends the previous one
    else if (open && paths.some((path) => open!.has(path))) hit = true;
  }
  close();
  return eligible ? Math.round(100 * used / eligible) : null;
}
