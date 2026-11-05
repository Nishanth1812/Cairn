import { join } from 'node:path';
import { syncInstructions } from '../instructions.js';

export const CODEX_GUIDELINES = '# Cairn Context Core Guidelines\n- For code questions, you can run `cairn context "<question>"` or `cairn context search "<term>"` first (ranked, token-budgeted); for exact text use `cairn context search --exact "<text>"`. Grep/Read remain fine for exact strings and known paths.\n- Answer from the Cairn result; read a file only when it lacks a line you need (use offset/limit).\n- To find what calls or uses a symbol across files, run `cairn context search --refs <symbol>` (grouped by file and enclosing function).\n- Checkpoints are saved automatically; only run `cairn context task start <title>` to name a long task.';

export function syncCodexInstructions(repoRoot: string, managedContent = CODEX_GUIDELINES, dryRun = false) {
  return syncInstructions(join(repoRoot, 'AGENTS.md'), managedContent, dryRun);
}
