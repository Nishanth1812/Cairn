#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatContext, formatSearch } from './format.js';
import { redactDeep, redactSafe } from '../core/security/redactor.js';

export interface CliIo { stdout: (text: string) => void; stderr: (text: string) => void }
export interface CliResult { code: number; data?: unknown; warnings?: string[]; errors?: string[]; status?: string }

const HELP = `weft — local-first developer efficiency tools

Usage: weft <command> [options]

Commands: init, doctor, onboard, mcp, instructions, repos, index, search, context, task,
          intent, health, portfolio, costs (stats), cache, sessions, bench,
          clean, migrate devpulse

Global flags: --json --quiet --verbose --help --version`;

function parseGlobal(args: string[]): { args: string[]; json: boolean; quiet: boolean; verbose: boolean } {
  const result = { args: [] as string[], json: false, quiet: false, verbose: false };
  for (const arg of args) {
    if (arg === '--json') result.json = true;
    else if (arg === '--quiet') result.quiet = true;
    else if (arg === '--verbose') result.verbose = true;
    else result.args.push(arg);
  }
  return result;
}

function commandName(args: string[]): string {
  if (args.includes('--version')) return 'version';
  if (args.includes('--help') || args.length === 0 || args[0] === 'help') return 'help';
  const group = args.find((arg) => !arg.startsWith('--')) ?? 'help';
  const subcommands = new Set(['instructions', 'repos', 'task', 'intent', 'migrate', 'bench', 'mcp']);
  if (subcommands.has(group)) return `${group} ${args.slice(args.indexOf(group) + 1).find((arg) => !arg.startsWith('--')) ?? ''}`.trim();
  return group === 'stats' ? 'costs' : group;
}

export async function runCli(argv = process.argv.slice(2), io: CliIo = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) }): Promise<number> {
  const parsed = parseGlobal(argv);
  const args = parsed.args;
  const command = commandName(args);
  let result: CliResult;
  if (args.includes('--version') || args[0] === '--version') result = { code: 0, data: { version: '0.1.0' } };
  else if (args.includes('--help') || args.length === 0 || args[0] === 'help') result = { code: 0, data: HELP };
  else if (args[0] === 'hook') result = await (await import('./hookCommand.js')).runHookCommand(args[1]);
  else {
    try { result = await (await import('./commands/index.js')).runCommand(args, !parsed.json); }
    catch (error) {
      const message = redactSafe(parsed.verbose && error instanceof Error ? error.stack ?? error.message : error instanceof Error ? error.message : String(error));
      const explicitCode = Number((error as { exitCode?: number }).exitCode);
      const code = explicitCode || (/migration checksum mismatch|integrity violation|database disk image is malformed/i.test(message) ? 6 : 1);
      result = { code, status: code === 2 ? 'invalid_arguments' : code === 3 ? 'missing_resource' : code === 5 ? 'cancelled' : code === 6 ? 'integrity_violation' : 'error', errors: [message] };
    }
  }
  if (parsed.json) {
    const status = result.status ?? (result.code === 0 ? 'success' : result.code === 4 ? 'partial' : result.code === 5 ? 'cancelled' : result.code === 6 ? 'integrity_violation' : result.code === 3 ? 'missing_resource' : result.code === 2 ? 'invalid_arguments' : 'error');
    io.stdout(`${JSON.stringify(redactDeep({ schema_version: 1, command, ok: result.code === 0, status, data: result.data ?? null, warnings: result.warnings ?? [], errors: result.errors ?? [] }))}\n`);
  } else if (result.code !== 0) {
    for (const warning of result.warnings ?? []) if (!parsed.quiet) io.stderr(`Warning: ${redactSafe(warning)}\n`);
    for (const error of result.errors ?? []) io.stderr(`Error: ${redactSafe(error)}\n`);
  } else if (!parsed.quiet) {
    if (typeof result.data === 'string') io.stdout(`${redactSafe(result.data)}\n`);
    else if (command === 'search' && Array.isArray(result.data)) io.stdout(`${redactSafe(formatSearch(result.data))}\n`);
    else if (command === 'context' && result.data && typeof result.data === 'object' && 'items' in result.data) io.stdout(`${redactSafe(formatContext((result.data as { items: Parameters<typeof formatContext>[0] }).items))}\n`);
    else if (result.data !== undefined) io.stdout(`${redactSafe(JSON.stringify(result.data, null, 2))}\n`);
    for (const warning of result.warnings ?? []) io.stderr(`Warning: ${redactSafe(warning)}\n`);
  }
  return result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  runCli().then((code) => { process.exitCode = code; }).catch((error: unknown) => { process.stderr.write(`${redactSafe(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = 1; });
}
