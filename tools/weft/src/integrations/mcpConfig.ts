import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export type Harness = 'claude-code' | 'codex' | 'opencode' | 't3';
const command = { command: 'weft', args: ['mcp', 'serve'] };

export function harnessConfigPath(harness: Exclude<Harness, 't3'>, home: string, project?: string): string {
  if (harness === 'claude-code') return project ? join(project, '.mcp.json') : join(home, '.claude.json');
  if (harness === 'codex') return join(project ?? home, project ? '.codex' : '.codex', 'config.toml');
  return join(project ?? home, project ? 'opencode.json' : '.config', ...(project ? [] : ['opencode', 'opencode.json']));
}

export async function installMcpConfig(harness: Harness, options: { home: string; project?: string; dryRun?: boolean; runner?: (args: string[], timeoutMs: number) => Promise<boolean> }): Promise<{ path: string; modified: boolean }> {
  if (harness === 't3') {
    const [claude, codex] = await Promise.all([
      installMcpConfig('claude-code', { home: options.home, dryRun: options.dryRun }),
      installMcpConfig('codex', { home: options.home, dryRun: options.dryRun }),
    ]);
    return { path: `T3 Code coverage via ${claude.path} + ${codex.path}`, modified: claude.modified || codex.modified };
  }
  const path = harnessConfigPath(harness, options.home, options.project);
  let original = '';
  if (harness === 'claude-code' && !options.project && options.runner && !options.dryRun) {
    if (await options.runner(['mcp', 'list'], 1500)) {
      // `claude mcp list` is global; avoid a JSON merge when the named server is already there.
      return { path, modified: false };
    }
    if (await options.runner(['mcp', 'add', '--scope', 'user', 'weft', '--', 'weft', 'mcp', 'serve'], 2000)) return { path, modified: true };
  }
  try { original = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let content: string;
  if (harness === 'codex') {
    const entry = '[mcp_servers.weft]\ncommand = "weft"\nargs = ["mcp", "serve"]';
    const pattern = /\[mcp_servers\.weft\][\s\S]*?(?=\n\[|$)/;
    content = pattern.test(original) ? original.replace(pattern, `${entry}${original.endsWith('\n') ? '\n' : ''}`) : `${original}${original && !original.endsWith('\n') ? '\n' : ''}${entry}\n`;
  } else {
    let config: Record<string, unknown>;
    try { config = original ? JSON.parse(original) as Record<string, unknown> : {}; } catch { throw new Error(`Invalid JSON harness config: ${path}`); }
    const key = harness === 'claude-code' ? 'mcpServers' : 'mcp';
    const entries = config[key] && typeof config[key] === 'object' ? config[key] as Record<string, unknown> : {};
    config[key] = { ...entries, weft: harness === 'opencode' ? { type: 'local', command: ['weft', 'mcp', 'serve'], enabled: true } : command };
    content = `${JSON.stringify(config, null, 2)}\n`;
  }
  const modified = original !== content;
  if (modified && !options.dryRun) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    try { await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  return { path, modified };
}
