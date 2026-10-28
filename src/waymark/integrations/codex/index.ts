import { join } from 'node:path';
import { syncInstructions } from '../instructions.js';

export const CODEX_GUIDELINES = '# Waymark Core Guidelines\n- To explore code, run `cairn waymark context "<query>"` (or `cairn waymark search "<query>"`) in the shell before Grep, Glob, `rg`, `find` or reading whole files (Grep only for an exact string it misses, including in subagents); then Read just the lines you need with offset and limit.\n- Checkpoints are saved automatically; only run `cairn waymark task start <title>` to name a long task.';

export function syncCodexInstructions(repoRoot: string, managedContent = CODEX_GUIDELINES, dryRun = false) {
  return syncInstructions(join(repoRoot, 'AGENTS.md'), managedContent, dryRun);
}
