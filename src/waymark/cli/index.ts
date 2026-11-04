#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatContext } from './format.js';
import { redactDeep, redactSafe } from '../core/security/redactor.js';
import { getUserPaths } from '../config/paths.js';
import { isStorageError, storageFailure } from '../storage/storageErrors.js';
import { performance } from 'node:perf_hooks';

export interface CliIo { stdout: (text: string) => void; stderr: (text: string) => void }
export interface CliResult { code: number; data?: unknown; warnings?: string[]; errors?: string[]; status?: string }

const HELP = `cairn waymark — local-first code index and task memory for AI coding agents

Usage: cairn waymark <command> [options]

Commands: init, doctor, onboard, instructions, repos, index, search, context, task,
          intent, health, portfolio, stats, bench,
          clean, migrate devpulse

Search: cairn waymark search "<words>" [repo] ranks code by relevance.
  --exact lists every case-insensitive literal match (file:line; not a regex); --kind function|class|interface|type|method|variable lists definitions (use * for all);
  --refs <symbol> lists import, re-export, call, and module-level usage sites;
  Queries like "class definitions in backend" also return matching symbols;
  --limit N caps the list. Run from a folder of repos to search all of them.

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
  const subcommands = new Set(['instructions', 'repos', 'task', 'intent', 'migrate', 'bench']);
  if (subcommands.has(group)) return `${group} ${args.slice(args.indexOf(group) + 1).find((arg) => !arg.startsWith('--')) ?? ''}`.trim();
  return group;
}

export async function runCli(argv = process.argv.slice(2), io: CliIo = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) }): Promise<number> {
  if (process.env.CAIRN_TIMING === '1') {
    const boot = Number(process.env.CAIRN_TIMING_BOOT);
    if (Number.isFinite(boot)) {
      io.stderr(`CAIRN_TIMING node_startup=${boot.toFixed(1)}ms\n`);
    }
  }
  const parsed = parseGlobal(argv);
  const args = parsed.args;
  const command = commandName(args);
  let result: CliResult;
  if (args.includes('--version') || args[0] === '--version') result = { code: 0, data: { version: '0.1.1' } };
  else if (args.includes('--help') || args.length === 0 || args[0] === 'help') result = { code: 0, data: HELP };
  else if (args[0] === 'hook') result = await (await import('./hookCommand.js')).runHookCommand(args[1]);
  else {
    try {
      const commands = await import('./commands/index.js');
      const boot = Number(process.env.CAIRN_TIMING_BOOT);
      if (process.env.CAIRN_TIMING === '1' && Number.isFinite(boot)) io.stderr(`CAIRN_TIMING module_load=${Math.max(0, performance.now() - boot).toFixed(1)}ms\n`);
      result = await commands.runCommand(args, !parsed.json);
    }
    catch (error) {
      const reportedError = isStorageError(error) ? storageFailure(getUserPaths().state, error, 64 * 1024 * 1024) : error;
      const message = redactSafe(parsed.verbose && reportedError instanceof Error && !isStorageError(reportedError) ? reportedError.stack ?? reportedError.message : reportedError instanceof Error ? reportedError.message : String(reportedError));
      const explicitCode = Number((reportedError as { exitCode?: number }).exitCode);
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
    else if (command === 'context' && result.data && typeof result.data === 'object' && 'items' in result.data) {
      const context = result.data as { items: Parameters<typeof formatContext>[0]; query?: string };
      io.stdout(`${redactSafe(formatContext(context.items, context.query))}\n`);
    }
    else if (result.data !== undefined) io.stdout(`${redactSafe(JSON.stringify(result.data, null, 2))}\n`);
    for (const warning of result.warnings ?? []) io.stderr(`Warning: ${redactSafe(warning)}\n`);
  }
  return result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  // A reader that closes early (`cairn waymark search x | head`) is not an error.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') throw error; process.exit(process.exitCode ?? 0); });
  runCli().then((code) => { process.exitCode = code; }).catch((error: unknown) => { process.stderr.write(`${redactSafe(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = 1; });
}
