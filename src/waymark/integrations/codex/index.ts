import { join } from 'node:path';
import { syncInstructions } from '../instructions.js';

export const CODEX_GUIDELINES = '# Waymark Core Guidelines\n- To explore code, run `cairn waymark context "<query>"` (or `cairn waymark search "<query>"`) in the shell before Grep, Glob, `rg`, `find` or reading whole files (Grep only for an exact string it misses, including in subagents); then Read just the lines you need with offset and limit.\n- Checkpoints are saved automatically; only run `cairn waymark task start <title>` to name a long task.\n- Before Grep, Glob, grep, rg or find in Bash, or a whole-file Read of a large file, search Waymark with `cairn waymark search "<term>"` or `cairn waymark context "<question>"`. If it misses or returns bad output, file it with `cairn waymark feedback --query "<the search you ran>" --kind miss|bad_output|error "<what went wrong>"` (add `--session "<key>"` if you have one), then use Grep, Glob or Bash search for the exact string, or Read the part you need with offset and limit.';

export function syncCodexInstructions(repoRoot: string, managedContent = CODEX_GUIDELINES, dryRun = false) {
  return syncInstructions(join(repoRoot, 'AGENTS.md'), managedContent, dryRun);
}
