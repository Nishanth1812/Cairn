import { join } from 'node:path';
import { syncInstructions } from '../instructions.js';

export { runHookSafely } from './safeHook.js';

export const CLAUDE_CODE_GUIDELINES = '# Cairn Context Core Guidelines\n- For code questions that span files or need orientation, run `cairn context "<question>"` for ranked, token-budgeted context.\n- For an exact text or identifier match, run `cairn context search "<term>" --exact`; to find a symbol\'s usages across files, run `cairn context search "<symbol>" --refs`.\n- Do not use Cairn Context for small files, line ranges you already know, or pure git diff review; Grep/Read remain fine for those cases.\n- Answer from the Cairn result; read only missing lines from files with a narrow range.\n- To audit assistant-session retrieval waste, run `cairn optimize audit --consent --project .`; review the report before making changes.';

export function syncClaudeInstructions(repoRoot: string, managedContent = CLAUDE_CODE_GUIDELINES, dryRun = false) {
  return syncInstructions(join(repoRoot, 'CLAUDE.md'), managedContent, dryRun);
}

export { hookSettingsRoot, hookStateDir, installClaudeHooks, runCheckpointHook, runSessionStartHook, uninstallClaudeHooks } from '../../hooks/claude.js';
