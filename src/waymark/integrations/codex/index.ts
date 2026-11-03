import { join } from 'node:path';
import { syncInstructions } from '../instructions.js';

export const CODEX_GUIDELINES = '# Waymark Core Guidelines\n- For code questions, you can run `cairn waymark context "<question>"` or `cairn waymark search "<term>"` first (ranked, token-budgeted); for exact text use `cairn waymark search --exact "<text>"`. Grep/Read remain fine for exact strings and known paths.\n- Checkpoints are saved automatically; only run `cairn waymark task start <title>` to name a long task.';

export function syncCodexInstructions(repoRoot: string, managedContent = CODEX_GUIDELINES, dryRun = false) {
  return syncInstructions(join(repoRoot, 'AGENTS.md'), managedContent, dryRun);
}
