import { join } from 'node:path';
import { syncInstructions } from '../instructions.js';

export { runHookSafely } from './safeHook.js';

export const CLAUDE_CODE_GUIDELINES = '# Waymark Core Guidelines\n- For code questions, you can run `cairn waymark context "<question>"` or `cairn waymark search "<term>"` first (ranked, token-budgeted); for exact text use `cairn waymark search --exact "<text>"`. Grep/Read remain fine for exact strings and known paths.\n- Checkpoints are saved automatically; only run `cairn waymark task start <title>` to name a long task.';

export function syncClaudeInstructions(repoRoot: string, managedContent = CLAUDE_CODE_GUIDELINES, dryRun = false) {
  return syncInstructions(join(repoRoot, 'CLAUDE.md'), managedContent, dryRun);
}

export { hookSettingsRoot, hookStateDir, installClaudeHooks, runCheckpointHook, runSessionStartHook, uninstallClaudeHooks } from '../../hooks/claude.js';
