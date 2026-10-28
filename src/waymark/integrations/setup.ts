import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { installClaudeHooks, uninstallClaudeHooks } from '../hooks/claude.js';
import { CLAUDE_CODE_GUIDELINES } from './claude-code/index.js';
import { CODEX_GUIDELINES } from './codex/index.js';
import { syncInstructions } from './instructions.js';

export type Harness = 'claude-code' | 'codex' | 'opencode' | 't3';
export type SetupOptions = { home: string; harnesses?: Harness[]; dryRun?: boolean; uninstall?: boolean; bin?: string };

export async function setupWeft(options: SetupOptions) {
  const selected = options.harnesses ?? ['claude-code', 'codex', 'opencode'];
  const harnesses = [...new Set(selected.flatMap((harness) => harness === 't3' ? ['claude-code', 'codex'] : [harness]))] as Harness[];
  const results: unknown[] = [];
  for (const harness of harnesses) {
    const dir = harness === 'claude-code' ? join(options.home, '.claude') : harness === 'codex' ? join(options.home, '.codex') : join(options.home, '.config', 'opencode');
    if (!existsSync(dir)) continue;
    if (harness === 'claude-code') {
      const bin = options.bin ?? (process.argv[1] ? `node "${realpathSync(resolve(process.argv[1])).replace(/\\/g, '/')}"` : 'cairn waymark');
      results.push(options.uninstall ? await uninstallClaudeHooks({ home: options.home, global: true, dryRun: options.dryRun }) : await installClaudeHooks({ home: options.home, global: true, dryRun: options.dryRun, bin }));
      if (options.uninstall) results.push(await syncInstructions(join(dir, 'CLAUDE.md'), '', options.dryRun));
      else results.push(await syncInstructions(join(dir, 'CLAUDE.md'), CLAUDE_CODE_GUIDELINES, options.dryRun));
    } else {
      const instructionPath = join(dir, 'AGENTS.md');
      if (!options.uninstall) results.push(await syncInstructions(instructionPath, CODEX_GUIDELINES, options.dryRun));
      else results.push(await removeManagedInstructions(instructionPath, options.dryRun));
    }
  }
  return results;
}

async function removeManagedInstructions(path: string, dryRun?: boolean) {
  const { readFile, writeFile, rename, rm, mkdir } = await import('node:fs/promises');
  const { BEGIN_MANAGED_BLOCK, END_MANAGED_BLOCK } = await import('./instructions.js');
  const original = await readFile(path, 'utf8').catch(() => '');
  const start = original.indexOf(BEGIN_MANAGED_BLOCK), end = original.indexOf(END_MANAGED_BLOCK);
  const content = start >= 0 && end >= start ? `${original.slice(0, start)}${original.slice(end + END_MANAGED_BLOCK.length)}`.trimEnd() + (original.slice(end + END_MANAGED_BLOCK.length).endsWith('\n') ? '\n' : '') : original;
  const modified = content !== original;
  if (modified && !dryRun) { await mkdir(join(path, '..'), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; try { await writeFile(temp, content); await rename(temp, path); } finally { await rm(temp, { force: true }); } }
  return { path, modified };
}
