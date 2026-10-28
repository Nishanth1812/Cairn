import { join } from 'node:path';
import { syncInstructions } from '../instructions.js';

export const CODEX_GUIDELINES = '# Weft Core Guidelines\n- To explore code, call the `weft_context` / `weft_search` MCP tools (CLI: `weft context "<query>"`) instead of Grep, Glob or reading whole files (Grep only for an exact string Weft misses, including in subagents); use `weft_read` for exact line ranges.\n- Exploring through the shell (no Weft MCP tool in your list)? Run `weft context "<query>"` or `weft search "<query>"` BEFORE `rg`, `grep`, `find` or `cat`.\n- Checkpoints are saved automatically; only run `weft task start <title>` to name a long task.';

export function syncCodexInstructions(repoRoot: string, managedContent = CODEX_GUIDELINES, dryRun = false) {
  return syncInstructions(join(repoRoot, 'AGENTS.md'), managedContent, dryRun);
}
