import type Database from 'better-sqlite3';

// Tool names as recorded: the Waymark CLI commands, and the native tools the PreToolUse hook sees.
const WEFT_TOOLS = ['search', 'context'];
const NATIVE_TOOLS = ['Read', 'Read-whole', 'Grep', 'Glob', 'Bash-search'];

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
  };
}
