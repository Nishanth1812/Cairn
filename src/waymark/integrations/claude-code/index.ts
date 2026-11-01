import { join } from 'node:path';
import { syncInstructions } from '../instructions.js';

export const CLAUDE_CODE_GUIDELINES = '# Waymark Core Guidelines\n- To explore code, run `cairn waymark context "<query>"` (or `cairn waymark search "<query>"`) in the shell before Grep, Glob, `rg`, `find` or reading whole files (Grep only for an exact string it misses, including in subagents); then Read just the lines you need with offset and limit.\n- Checkpoints are saved automatically; only run `cairn waymark task start <title>` to name a long task.\n- Grep, Glob, grep, rg or find run in Bash, and whole-file Reads of large files are gated per agent: the first two are denied in favour of Waymark. Read a large file with offset and limit where you can. If Waymark misses or returns bad output, file it with `cairn waymark feedback --session "<key>" --query "<the search you ran>" --kind miss|bad_output|error "<what went wrong>"` (the denial shows your key); each feedback unlocks two more lookups, and past that every other tool is blocked until feedback is filed.';

export function syncClaudeInstructions(repoRoot: string, managedContent = CLAUDE_CODE_GUIDELINES, dryRun = false) {
  return syncInstructions(join(repoRoot, 'CLAUDE.md'), managedContent, dryRun);
}

export async function runHookSafely<T>(hook: () => T | Promise<T>, timeoutMs = 450, ceilingMs = 499): Promise<T | undefined> {
  const timeout = Math.min(Math.max(timeoutMs, 1), ceilingMs); // Hooks stay under 500 ms; only tests raise the ceiling.
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeout); });
  // Clear the timer: a live one keeps the hook process running until it fires even after the work is done.
  return Promise.race([Promise.resolve().then(hook), expired]).finally(() => clearTimeout(timer));
}

export { hookSettingsRoot, hookStateDir, installClaudeHooks, runCheckpointHook, runSessionStartHook, uninstallClaudeHooks } from '../../hooks/claude.js';
