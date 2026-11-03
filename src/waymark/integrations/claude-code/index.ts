import { join } from 'node:path';
import { syncInstructions } from '../instructions.js';

export const CLAUDE_CODE_GUIDELINES = '# Waymark Core Guidelines\n- For code questions, you can run `cairn waymark context "<question>"` or `cairn waymark search "<term>"` first (ranked, token-budgeted); for exact text use `cairn waymark search --exact "<text>"`. Grep/Read remain fine for exact strings and known paths.\n- Checkpoints are saved automatically; only run `cairn waymark task start <title>` to name a long task.';

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
