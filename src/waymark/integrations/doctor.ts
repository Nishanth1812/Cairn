import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { CLAUDE_CODE_GUIDELINES } from './claude-code/index.js';
import { CODEX_GUIDELINES } from './codex/index.js';
import { checkInstructions } from './instructions.js';

export type IntegrationCheck = { id: string; status: 'installed' | 'missing' | 'stale'; detail?: string; fix?: string };

function commandOnPath(command: string): boolean {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  return (process.env.PATH ?? '').split(delimiter).some((dir) => extensions.some((extension) => existsSync(join(dir, `${command}${extension}`))));
}

async function jsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; return undefined; }
}

function hookCommand(settings: Record<string, unknown> | undefined): string | undefined {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return undefined;
  for (const entries of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const nested = entry && typeof entry === 'object' ? (entry as { hooks?: unknown }).hooks : undefined;
      if (!Array.isArray(nested)) continue;
      for (const hook of nested) {
        const command = hook && typeof hook === 'object' ? (hook as { command?: unknown }).command : undefined;
        if (typeof command === 'string' && command.includes('# weft-')) return command;
      }
    }
  }
  return undefined;
}

function hookStatus(command: string | undefined): 'missing' | 'installed' | 'stale' {
  if (!command) return 'missing';
  const direct = /^\s*node(?:\.exe)?\s+"([^"]+)"/i.exec(command)?.[1];
  if (direct) return existsSync(direct) ? 'installed' : 'stale';
  const executable = /^\s*([^\s]+)/.exec(command)?.[1];
  return executable && commandOnPath(executable) ? 'installed' : 'stale';
}

export async function checkIntegrations(home: string): Promise<IntegrationCheck[]> {
  const claude = await jsonFile(join(home, '.claude', 'settings.json'));
  const hookFix = 'cairn waymark setup --harness claude-code';
  const claudeHookStatus = hookStatus(hookCommand(claude));
  const instructionChecks = await Promise.all([
    checkInstructions(join(home, '.claude', 'CLAUDE.md'), CLAUDE_CODE_GUIDELINES),
    checkInstructions(join(home, '.codex', 'AGENTS.md'), CODEX_GUIDELINES),
    checkInstructions(join(home, '.config', 'opencode', 'AGENTS.md'), CODEX_GUIDELINES),
  ]);
  const instructions: IntegrationCheck[] = instructionChecks.map((result, index) => ({
    id: ['claude-code instructions', 'codex instructions', 'opencode instructions'][index]!,
    status: result.matches ? 'installed' : 'missing',
    ...(!result.matches ? { fix: `cairn waymark setup --harness ${['claude-code', 'codex', 'opencode'][index]!}` } : {}),
  }));
  const hooks: IntegrationCheck = { id: 'claude-code hooks', status: claudeHookStatus, ...(claudeHookStatus !== 'installed' ? { detail: claudeHookStatus === 'stale' ? 'stale command path' : undefined, fix: hookFix } : {}) };
  return [hooks, ...instructions];
}
