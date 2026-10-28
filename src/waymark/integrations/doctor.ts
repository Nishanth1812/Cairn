import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { CLAUDE_CODE_GUIDELINES } from './claude-code/index.js';
import { CODEX_GUIDELINES } from './codex/index.js';
import { checkInstructions } from './instructions.js';

export type IntegrationCheck = { id: string; status: 'installed' | 'missing' | 'stale'; detail?: string; fix?: string };

function commandOnPath(command: string): boolean {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  return (process.env.PATH ?? '').split(delimiter).some((dir) => extensions.some((extension) => existsSync(join(dir, `${command}${extension}`))));
}

function commandStatus(command: string, args: string[] = []): 'installed' | 'stale' {
  if (isAbsolute(command) || /[\\/]/.test(command)) return existsSync(command) ? 'installed' : 'stale';
  if (commandOnPath(command)) {
    const script = args.find((arg) => /[\\/]/.test(arg) && /\.(?:mjs|cjs|js)$/i.test(arg));
    return !script || existsSync(script) ? 'installed' : 'stale';
  }
  return 'stale';
}

function checkEntry(id: string, entry: unknown, fix: string): IntegrationCheck {
  if (!entry || typeof entry !== 'object') return { id, status: 'missing', fix };
  const value = entry as { command?: unknown; args?: unknown };
  const command = typeof value.command === 'string' ? value.command : Array.isArray(value.command) && typeof value.command[0] === 'string' ? value.command[0] : undefined;
  if (!command) return { id, status: 'missing', fix };
  const args = Array.isArray(value.command) ? value.command.slice(1) : value.args;
  const status = commandStatus(command, Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : []);
  return { id, status, ...(status === 'stale' ? { detail: 'stale command path', fix } : {}) };
}

async function jsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; return undefined; }
}

async function mcpCheck(id: string, path: string, section: string, fix: string): Promise<IntegrationCheck> {
  const config = await jsonFile(path);
  const servers = config?.[section] as Record<string, unknown> | undefined;
  return checkEntry(id, servers?.weft, fix);
}

async function codexMcpCheck(home: string): Promise<IntegrationCheck> {
  const id = 'codex MCP', fix = 'weft setup --harness codex';
  let content: string;
  try { content = await readFile(join(home, '.codex', 'config.toml'), 'utf8'); }
  catch { return { id, status: 'missing', fix }; }
  const section = /^\[mcp_servers\.weft\]\r?\n([\s\S]*?)(?=^\[|\s*$)/m.exec(content)?.[1];
  if (!section) return { id, status: 'missing', fix };
  const command = /^command\s*=\s*"([^"]+)"/m.exec(section)?.[1];
  const args = [...section.matchAll(/"([^"]+)"/g)].slice(1).map((match) => match[1]!);
  if (!command) return { id, status: 'missing', fix };
  const status = commandStatus(command, args);
  return { id, status, ...(status === 'stale' ? { detail: 'stale command path', fix } : {}) };
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
  const claudePath = join(home, '.claude.json');
  const claude = await jsonFile(join(home, '.claude', 'settings.json'));
  const hookFix = 'weft setup --harness claude-code';
  const claudeMcp = await mcpCheck('claude-code MCP', claudePath, 'mcpServers', hookFix);
  const codexMcp = await codexMcpCheck(home);
  const claudeHookStatus = hookStatus(hookCommand(claude));
  const opencodePath = join(home, '.config', 'opencode', 'opencode.json');
  const opencodeMcp = await mcpCheck('opencode MCP', opencodePath, 'mcp', 'weft setup --harness opencode');
  const instructionChecks = await Promise.all([
    checkInstructions(join(home, '.claude', 'CLAUDE.md'), CLAUDE_CODE_GUIDELINES),
    checkInstructions(join(home, '.codex', 'AGENTS.md'), CODEX_GUIDELINES),
    checkInstructions(join(home, '.config', 'opencode', 'AGENTS.md'), CODEX_GUIDELINES),
  ]);
  const instructions: IntegrationCheck[] = instructionChecks.map((result, index) => ({
    id: ['claude-code instructions', 'codex instructions', 'opencode instructions'][index]!,
    status: result.matches ? 'installed' : 'missing',
    ...(!result.matches ? { fix: `weft setup --harness ${['claude-code', 'codex', 'opencode'][index]!}` } : {}),
  }));
  const hooks: IntegrationCheck = { id: 'claude-code hooks', status: claudeHookStatus, ...(claudeHookStatus !== 'installed' ? { detail: claudeHookStatus === 'stale' ? 'stale command path' : undefined, fix: hookFix } : {}) };
  const t3Status = [claudeMcp.status, codexMcp.status].includes('stale') ? 'stale' : claudeMcp.status === 'installed' && codexMcp.status === 'installed' ? 'installed' : 'missing';
  return [hooks, claudeMcp, codexMcp, opencodeMcp, ...instructions,
    { id: 't3 MCP coverage', status: t3Status, ...(t3Status !== 'installed' ? { detail: 'uses Claude Code and Codex user configs', fix: 'weft setup --harness t3' } : { detail: 'Claude Code + Codex user configs' }) },
  ];
}
