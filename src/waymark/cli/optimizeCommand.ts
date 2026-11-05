// `cairn optimize`: the read-only, opt-in audit entry point (first release: coverage matrix for all
// three hosts, transcript audit for the one verified host). It is kept apart from the context
// command router so the audit loads no indexing or storage code, stays read-only by construction
// and can be removed without touching existing commands.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runAudit, DataError } from '../optimize/audit.js';
import { hostCoverage } from '../optimize/hosts.js';
import { redactDeep, redactSafe } from '../core/security/redactor.js';

type Result = { code: number; status?: string; data?: unknown; warnings?: string[]; errors?: string[] };

const HELP = `cairn optimize — read-only, opt-in audit of local assistant session data

Usage: cairn optimize coverage              what session data each installed host exposes locally (reads no private data)
       cairn optimize audit --consent       audit local Claude Code transcripts (read-only)

The audit opens host session files read-only, never writes them, and reports only observed
opportunities: repeated reads and searches, large tool outputs, and provider-reported usage.
Token estimates are labeled; subscription quota and cost are never inferred.

Audit options:
  --project <dir|name>   audit one Claude Code project directory (default: every project)
  --home <dir>           override the host home directory (for tests and alternate installs)
Global flags: --json --quiet --verbose
Run \`cairn optimize coverage\` for the per-host coverage matrix and its limitations.`;

class OptimizeError extends Error { constructor(message: string, readonly exitCode: number, readonly status: string) { super(message); } }

function homeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function coverageText(hosts: ReturnType<typeof hostCoverage>): string {
  const lines = [];
  for (const host of hosts) {
    lines.push(`${host.label} (${host.id}) — ${host.installed ? 'installed' : 'not detected via ' + host.detection}`);
    lines.push(`  app type: ${host.appType}`);
    lines.push(`  orchestration: ${host.orchestration}`);
    lines.push(`  local data root: ${host.dataRoot}`);
    lines.push(`  audit reader: ${host.reader}`);
    const wide = Math.max(...Object.keys(host.categories).map((name) => name.length));
    for (const [name, category] of Object.entries(host.categories)) {
      lines.push(`  ${name.padEnd(wide)}  ${category.coverage}${category.detail ? ` — ${category.detail}` : ''}`);
    }
  }
  return lines.join('\n');
}

function summaryText(report: Awaited<ReturnType<typeof runAudit>>): string {
  const b = report.bounds;
  const lines = [
    `Cairn Optimize audit — ${report.host} — read-only; provenance and limits listed below.`,
    `Scanned ${b.sessionsScanned} session(s) across ${b.projectsScanned} of ${b.projectsPresent} project directorie(s)${b.sessionsSkipped ? `, ${b.sessionsSkipped} skipped or beyond cap` : ''}${b.malformedLines ? `; ${b.malformedLines} malformed line(s) skipped` : ''}.`,
    `Provider-reported usage covers ${report.usage.sessionsWithProviderUsage} session(s)${report.usage.sessionsWithoutProviderUsage ? `; ${report.usage.sessionsWithoutProviderUsage} had none and are estimates only` : ''}.${report.usage.notes[0] ? '' : ''}`,
  ];
  const big = report.opportunities.largeToolOutputs;
  lines.push(`Large tool outputs: ${big.count} result(s) at 20k+ chars (${big.chars} chars, ~${big.estimatedTokens} estimated tokens — estimate, not provider-reported).`);
  if (report.opportunities.repeatedReads.length) {
    lines.push('Top repeated reads (reads / identical re-reads):');
    for (const row of report.opportunities.repeatedReads.slice(0, 5)) lines.push(`  ${row.project} :: ${row.path} — ${row.reads} reads, ${row.identicalRepeats} seeing unchanged content (fingerprinted)`);
  }
  if (report.opportunities.repeatedSearches.length) {
    lines.push('Top repeated searches:');
    for (const row of report.opportunities.repeatedSearches.slice(0, 5)) lines.push(`  ${row.project} :: ${row.tool} "${row.pattern}" — ${row.calls} identical calls`);
  }
  lines.push('Coverage and limits: run `cairn optimize coverage`; full limitation list in --json.');
  return lines.join('\n');
}

export async function runOptimize(argv: string[]): Promise<number> {
  const args: string[] = [];
  let json = false;
  let quiet = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--quiet') quiet = true;
    else if (arg === '--verbose') { /* accepted for symmetry; reports already contain evidence */ }
    else args.push(arg);
  }
  const command = args[0];
  const flags = args.slice(1);
  const option = (name: string): string | undefined => {
    const at = flags.indexOf(name);
    if (at < 0) return undefined;
    const value = flags[at + 1];
    if (!value || value.startsWith('--')) throw new OptimizeError(`${name} requires a value`, 2, 'invalid_arguments');
    return value;
  };
  // Resolve once: --home points the whole audit at an alternate host home (tests, alternate installs).
  const home = command === 'audit' || command === 'coverage' ? (option('--home') ?? homeDirectory()) : undefined;

  const result = await (async (): Promise<Result> => {
    if (!command || command === 'help' || command === '--help' || command === '-h') return { code: 0, data: HELP };
    if (command === 'coverage') {
      const hosts = hostCoverage(home!);
      if (json) return { code: 0, data: { hosts } };
      return { code: 0, data: coverageText(hosts) };
    }
    if (command === 'audit') {
      const project = option('--project');
      if (!flags.includes('--consent')) {
        throw new OptimizeError(
          `Reading local session history requires consent. The audit would read transcripts under ${home!.replace(/\\/g, '/')}/.claude/projects read-only, change nothing, and produce a local report. Re-run with --consent.`,
          3, 'missing_resource');
      }
      const limit = option('--sessions');
      const maxSessions = limit === undefined ? undefined : Number(limit);
      if (maxSessions !== undefined && (!Number.isSafeInteger(maxSessions) || maxSessions < 1)) {
        throw new OptimizeError('--sessions requires a positive integer', 2, 'invalid_arguments');
      }
      const report = await runAudit({ home: home!, project, maxSessions });
      if (json) return { code: 0, data: report };
      return { code: 0, data: summaryText(report) };
    }
    throw new OptimizeError(`Unknown optimize command "${command ?? ''}".\n\n${HELP}`, 2, 'invalid_arguments');
  })();

  if (json) {
    process.stdout.write(`${JSON.stringify(redactDeep({ schema_version: 1, command: `optimize ${command ?? ''}`.trim(), ok: result.code === 0, status: result.status ?? (result.code === 0 ? 'success' : 'error'), data: result.data ?? null, warnings: result.warnings ?? [], errors: result.errors ?? [] }), null, 2)}\n`);
    return result.code;
  }
  if (result.code !== 0) {
    for (const error of result.errors ?? []) process.stderr.write(`Error: ${redactSafe(error)}\n`);
    return result.code;
  }
  if (!quiet && typeof result.data === 'string') process.stdout.write(`${redactSafe(result.data)}\n`);
  else if (!quiet && result.data !== undefined) process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
  for (const warning of result.warnings ?? []) process.stderr.write(`Warning: ${redactSafe(warning)}\n`);
  return result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // A reader that closes early (`cairn optimize ... | head`) is not an error.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') throw error; process.exit(process.exitCode ?? 0); });
  runOptimize(process.argv.slice(2)).then((code) => { process.exitCode = code; })
    .catch((error: unknown) => {
      if (error instanceof OptimizeError) { process.stderr.write(`Error: ${redactSafe(error.message)}\n`); process.exitCode = error.exitCode; return; }
      process.stderr.write(`Error: ${redactSafe(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = error instanceof DataError ? 3 : 1;
    });
}
