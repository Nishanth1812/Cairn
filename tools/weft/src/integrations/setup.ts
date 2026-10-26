import { existsSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { installClaudeHooks, uninstallClaudeHooks } from '../hooks/claude.js';
import { CLAUDE_CODE_GUIDELINES } from './claude-code/index.js';
import { CODEX_GUIDELINES } from './codex/index.js';
import { syncInstructions } from './instructions.js';
import { installMcpConfig, type Harness } from './mcpConfig.js';

const run = promisify(execFile);
export type SetupOptions = { home: string; harnesses?: Harness[]; dryRun?: boolean; uninstall?: boolean; runner?: (args: string[], timeoutMs: number) => Promise<boolean>; bin?: string };

async function claudeRunner(args: string[], timeoutMs: number): Promise<boolean> {
  try {
    const { stdout } = await run('claude', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16_384 });
    return args[1] === 'list' ? /\bweft\b/i.test(stdout) : true;
  } catch { return false; }
}

export async function setupWeft(options: SetupOptions) {
  const selected = options.harnesses ?? ['claude-code', 'codex', 'opencode'];
  const harnesses = [...new Set(selected.flatMap((harness) => harness === 't3' ? ['claude-code', 'codex'] : [harness]))] as Harness[];
  const results: unknown[] = [];
  for (const harness of harnesses) {
    const dir = harness === 'claude-code' ? join(options.home, '.claude') : harness === 'codex' ? join(options.home, '.codex') : join(options.home, '.config', 'opencode');
    if (!existsSync(dir)) continue;
    if (harness === 'claude-code') {
      const bin = options.bin ?? (process.argv[1] ? `node "${realpathSync(resolve(process.argv[1])).replace(/\\/g, '/')}"` : 'weft');
      results.push(options.uninstall ? await uninstallClaudeHooks({ home: options.home, global: true, dryRun: options.dryRun }) : await installClaudeHooks({ home: options.home, global: true, dryRun: options.dryRun, bin }));
      if (options.uninstall) results.push(await syncInstructions(join(dir, 'CLAUDE.md'), '', options.dryRun));
      else results.push(await syncInstructions(join(dir, 'CLAUDE.md'), CLAUDE_CODE_GUIDELINES, options.dryRun));
      if (options.uninstall) results.push(await removeMcp(harness, options.home, options.dryRun));
      else results.push(await installMcpConfig(harness, { home: options.home, dryRun: options.dryRun, runner: options.runner ?? claudeRunner }));
    } else {
      const instructionPath = join(dir, 'AGENTS.md');
      results.push(options.uninstall ? await removeMcp(harness, options.home, options.dryRun) : await installMcpConfig(harness, { home: options.home, dryRun: options.dryRun }));
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

async function removeMcp(harness: Harness, home: string, dryRun?: boolean) {
  const path = harness === 'claude-code' ? join(home, '.claude.json') : harness === 'codex' ? join(home, '.codex', 'config.toml') : join(home, '.config', 'opencode', 'opencode.json');
  const { readFile, writeFile, rename, rm } = await import('node:fs/promises');
  const original = await readFile(path, 'utf8').catch(() => '');
  let content = original;
  if (harness === 'codex') content = original.replace(/(?:^|\n)\[mcp_servers\.weft\][\s\S]*?(?=\n\[|$)/, '').trimEnd() + (original.endsWith('\n') ? '\n' : '');
  else if (original) { const config = JSON.parse(original) as Record<string, unknown>; const key = harness === 'claude-code' ? 'mcpServers' : 'mcp'; const entries = config[key] as Record<string, unknown> | undefined; if (entries?.weft) { const { weft: _weft, ...rest } = entries; config[key] = rest; if (!Object.keys(rest).length) delete config[key]; content = `${JSON.stringify(config, null, 2)}\n`; } }
  const modified = content !== original;
  if (modified && !dryRun) { const temp = `${path}.${process.pid}.tmp`; try { await writeFile(temp, content); await rename(temp, path); } finally { await rm(temp, { force: true }); } }
  return { path, modified };
}
