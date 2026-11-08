// `cairn optimize`: the read-only, opt-in audit entry point (coverage matrix for all three
// hosts, transcript audit for the selected host). It is kept apart from the context command
// router so the audit loads no indexing or storage code, stays read-only by construction and
// can be removed without touching existing commands.
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runAudit, DataError, type AuditHost } from '../optimize/audit.js';
import { compareReports, type AuditComparison, type TaskOutcome } from '../optimize/compare.js';
import { hostCoverage } from '../optimize/hosts.js';
import { claudeProjectsRoot, listClaudeProjects } from '../optimize/claudeTranscript.js';
import { codexProjectsRoot, listCodexProjects } from '../optimize/codexTranscript.js';
import { listOpenCodeSessions, opencodeDatabasePath } from '../optimize/opencodeTranscript.js';
import { redactDeep, redactSafe } from '../core/security/redactor.js';

type Result = { code: number; status?: string; data?: unknown; warnings?: string[]; errors?: string[] };

const HELP = `cairn optimize — read-only, opt-in audit of local assistant session data

Usage: cairn optimize coverage              what session data each installed host exposes locally (reads no private data)
       cairn optimize sessions --consent    list local session IDs for exact targeting
       cairn optimize audit --consent       audit local session data for the selected host (read-only)
       cairn optimize compare --baseline <json> --current <json>  compare two supplied audit reports

The audit opens host session files read-only, never writes them, and reports only observed
opportunities: repeated reads and searches, large tool outputs, and provider-reported usage.
Token estimates are labeled; subscription quota and cost are never inferred.

Audit options:
  --host <host>          which host to audit: claude-code (default), codex or opencode
  --project <dir|name>   audit one project (Claude Code directory name, Codex working
                         directory, or OpenCode project directory; default: every project)
  --session-id <id>      audit one exact session ID; whether it is still running is unknown
  --recent              prioritize recently modified local files (mtime estimate for Claude/Codex;
                         OpenCode uses session activity metadata)
  --home <dir>           override the host home directory (for tests and alternate installs)
Session list options:
  --host <host>          claude-code (default), codex or opencode
  --project <name|dir>   list one exact project
  --sessions <n>         cap listed sessions (default 500; truncation is reported)
  --home <dir>           override the host home directory
Compare options (read only the two explicitly named JSON files; no consent or host scan):
  --baseline-outcome <value> --current-outcome <value>  completed, not-completed or unknown
  --baseline-elapsed-ms <n> --current-elapsed-ms <n>    user-supplied elapsed times
Global flags: --json --quiet --verbose
Run \`cairn optimize coverage\` for the per-host coverage matrix and its limitations.`;

const HOSTS: AuditHost[] = ['claude-code', 'codex', 'opencode'];

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
  if (report.scope.sessionId) lines.push(`Session ${report.scope.sessionId} selected explicitly; liveness is unknown.`);
  const big = report.opportunities.largeToolOutputs;
  lines.push(`Large tool outputs: ${big.count} result(s) at 20k+ chars (${big.chars} chars, ~${big.estimatedTokens} estimated tokens — estimate, not provider-reported).`);
  if (report.opportunities.repeatedReads.length) {
    lines.push('Top repeated reads (reads / identical re-reads):');
    for (const row of report.opportunities.repeatedReads.slice(0, 5)) {
      // Identical re-reads are the avoidable share: estimate them from the read chars,
      // so each row names its own saving instead of leaving the math to the reader.
      const repeatChars = Math.round((row.readChars ?? 0) * (row.reads > 0 ? row.identicalRepeats / row.reads : 0));
      const estTokens = Math.round(repeatChars / 4 * 1.1);
      lines.push(`  ${row.project} :: ${row.path} — ${row.reads} reads, ${row.identicalRepeats} seeing unchanged content (fingerprinted)${estTokens ? `, ~${estTokens} est. tokens avoidable (estimate)` : ''}`);
    }
  }
  if (report.opportunities.repeatedSearches.length) {
    lines.push('Top repeated searches:');
    for (const row of report.opportunities.repeatedSearches.slice(0, 5)) lines.push(`  ${row.project} :: ${row.tool} "${row.pattern}" — ${row.calls} identical calls`);
  }
  lines.push('Coverage and limits: run `cairn optimize coverage`; full limitation list in --json.');
  if (report.byProject?.length) {
    lines.push('By project (reads / identical re-reads / large outputs):');
    for (const project of report.byProject.slice(0, 5)) lines.push(`  ${project.project} — ${project.sessions} session(s), ${project.repeatedReads} reads (${project.identicalReReads} identical), ${project.largeOutputs} large output(s)`);
  }
  return lines.join('\n');
}

interface ListedSession { sessionId: string; project: string; startedAt?: string; endedAt?: string }

function sessionListText(host: AuditHost, sessions: ListedSession[], total: number): string {
  const lines = [`Cairn Optimize sessions — ${host} — session liveness is unknown.`, `Listed ${sessions.length} of ${total} session(s).`];
  for (const session of sessions) {
    const dates = session.startedAt || session.endedAt
      ? ` — ${session.startedAt ?? 'unknown start'} to ${session.endedAt ?? 'unknown activity'}`
      : '';
    lines.push(`  ${session.project} :: ${session.sessionId}${dates}`);
  }
  return lines.join('\n');
}

function compareText(report: AuditComparison): string {
  const metric = (name: string, label: string): string => {
    const value = report.metrics[name]!;
    const count = (n: number | null): string => n === null ? 'unavailable' : n.toLocaleString('en-US');
    const delta = value.change === null ? 'delta unavailable' : `change ${value.change > 0 ? '+' : ''}${value.change.toLocaleString('en-US')}`;
    return `  ${label.padEnd(24)} ${count(value.baseline)} → ${count(value.current)} (${delta})`;
  };
  const lines = [
    `Cairn Optimize comparison — ${report.status}`,
    `Baseline: ${report.reports.baseline.host} — ${report.reports.baseline.project ?? 'all projects'}`,
    `Current:  ${report.reports.current.host} — ${report.reports.current.project ?? 'all projects'}`,
    '',
    'Sessions and provider-reported tokens:',
    metric('sessionsScanned', 'Sessions scanned'),
    metric('inputTokens', 'Input tokens'),
    metric('outputTokens', 'Output tokens'),
    metric('cacheReadTokens', 'Cache read tokens'),
    metric('cacheCreationTokens', 'Cache creation tokens'),
    metric('reasoningTokens', 'Reasoning tokens'),
    '',
    'Observed opportunities:',
    metric('repeatedReads', 'Identical re-reads'),
    metric('repeatedSearches', 'Repeated searches'),
    metric('largeToolOutputCount', 'Large outputs (count)'),
    metric('largeToolOutputChars', 'Large outputs (chars)'),
    `Task outcome: ${report.taskOutcome.baseline} → ${report.taskOutcome.current} (${report.taskOutcome.change})`,
  ];
  if (report.elapsedMs.baseline !== null || report.elapsedMs.current !== null) {
    const elapsed = (value: number | null): string => value === null ? 'unavailable' : `${value.toLocaleString('en-US')} ms`;
    lines.push(`Elapsed: ${elapsed(report.elapsedMs.baseline)} → ${elapsed(report.elapsedMs.current)}${report.elapsedMs.change === null ? '' : ` (change ${report.elapsedMs.change > 0 ? '+' : ''}${report.elapsedMs.change.toLocaleString('en-US')} ms)`}`);
  }
  if (report.notes.length) lines.push('', 'Notes:', ...report.notes.map((note) => `  ${note}`));
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
  // Unknown flags fail closed: a misspelled option (e.g. --projct) must never fall back to
  // scanning every project when the user asked for one project.
  const knownFlags = new Set(['--consent', '--recent', '--project', '--session-id', '--home', '--sessions', '--host']);
  const rejectUnknownFlags = (allowed: Set<string> = knownFlags): void => {
    for (let index = 0; index < flags.length; index++) {
      const flag = flags[index]!;
      if (!flag.startsWith('--')) continue;
      if (!allowed.has(flag)) throw new OptimizeError(`Unknown flag "${flag}".`, 2, 'invalid_arguments');
      if (flag !== '--consent' && flag !== '--recent') {
        // Value flags consume the next token; it was validated by option() above.
        index++;
      }
    }
  };
  // Resolve once: --home points the whole audit at an alternate host home (tests, alternate
  // installs). Resolved inside the result wrapper so a missing value is reported like any
  // other invalid argument, including the JSON error envelope.
  const resolveHome = (): string => option('--home') ?? homeDirectory();

  const result = await (async (): Promise<Result> => {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      if (flags.length) throw new OptimizeError(`Unexpected argument "${flags[0]}".`, 2, 'invalid_arguments');
      return { code: 0, data: HELP };
    }
    if (command === 'coverage') {
      if (flags[0] === 'help' || flags[0] === '--help' || flags[0] === '-h') return { code: 0, data: HELP };
      rejectUnknownFlags();
      for (let index = 0; index < flags.length; index++) {
        if (flags[index] === '--home') { option('--home'); index++; continue; }
        throw new OptimizeError(`Unexpected argument "${flags[index]}".`, 2, 'invalid_arguments');
      }
      const home = resolveHome();
      const hosts = hostCoverage(home);
      if (json) return { code: 0, data: { hosts } };
      return { code: 0, data: coverageText(hosts) };
    }
    if (command === 'sessions') {
      if (flags.includes('--help') || flags.includes('-h') || flags[0] === 'help') return { code: 0, data: HELP };
      rejectUnknownFlags(new Set(['--consent', '--project', '--home', '--sessions', '--host']));
      for (let index = 0; index < flags.length; index++) {
        const flag = flags[index]!;
        if (flag === '--consent') continue;
        if (flag.startsWith('--')) { index++; continue; }
        throw new OptimizeError(`Unexpected argument "${flag}".`, 2, 'invalid_arguments');
      }
      const home = resolveHome();
      const rawHost = option('--host');
      let host: AuditHost = 'claude-code';
      if (rawHost !== undefined) {
        if (!HOSTS.includes(rawHost as AuditHost)) throw new OptimizeError(`--host "${rawHost}" is not a known host. Expected one of: ${HOSTS.join(', ')}.`, 2, 'invalid_arguments');
        host = rawHost as AuditHost;
      }
      if (!flags.includes('--consent')) {
        const location = host === 'codex'
          ? `session rollouts under ${codexProjectsRoot(home)} (CODEX_HOME or ~/.codex/sessions)`
          : host === 'opencode'
            ? `the database at ${opencodeDatabasePath({ home })}`
            : `transcripts under ${claudeProjectsRoot(home)}`;
        throw new OptimizeError(`Reading local session metadata requires consent. The command would read ${location} read-only and list session IDs. Re-run with --consent.`, 3, 'missing_resource');
      }
      const rawProject = option('--project');
      const project = rawProject === '.' ? process.cwd() : rawProject;
      const rawLimit = option('--sessions');
      const limit = rawLimit === undefined ? 500 : Number(rawLimit);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new OptimizeError('--sessions requires a positive integer', 2, 'invalid_arguments');

      let listed: ListedSession[];
      try {
        if (host === 'opencode') {
          listed = (await listOpenCodeSessions(opencodeDatabasePath({ home }))).map(({ sessionId, project, startedAt, endedAt }) => ({
            sessionId, project, ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}),
          }));
        } else {
          const projects = host === 'codex' ? await listCodexProjects(home) : await listClaudeProjects(home);
          listed = projects.flatMap((entry) => entry.sessions.map(({ sessionId }) => ({ sessionId, project: entry.project })));
        }
      } catch (error) {
        if (error instanceof DataError) throw error;
        throw new DataError(`${host} session metadata could not be listed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!listed.length) throw new DataError(`No ${host} sessions were found.`);
      const projects = [...new Set(listed.map((session) => session.project))];
      if (project && !projects.includes(project)) {
        throw new DataError(`No ${host} project exactly matches "${project}". Available projects: ${projects.join(', ') || 'none'}`);
      }
      const matching = (project ? listed.filter((session) => session.project === project) : listed)
        .sort((a, b) => (b.endedAt ?? b.startedAt ?? '').localeCompare(a.endedAt ?? a.startedAt ?? '') || a.project.localeCompare(b.project) || a.sessionId.localeCompare(b.sessionId));
      const sessions = matching.slice(0, limit);
      const data = { host, project: project ?? null, total: matching.length, listed: sessions.length, truncated: sessions.length < matching.length, liveness: 'unknown', sessions };
      return { code: 0, data: json ? data : sessionListText(host, sessions, matching.length) };
    }
    if (command === 'compare') {
      if (flags[0] === 'help' || flags.includes('--help') || flags.includes('-h')) return { code: 0, data: HELP };
      const compareFlags = new Set(['--baseline', '--current', '--baseline-outcome', '--current-outcome', '--baseline-elapsed-ms', '--current-elapsed-ms']);
      rejectUnknownFlags(compareFlags);
      for (let index = 0; index < flags.length; index++) {
        const flag = flags[index]!;
        if (!compareFlags.has(flag)) throw new OptimizeError(`Unexpected argument "${flag}".`, 2, 'invalid_arguments');
        option(flag);
        index++;
      }
      const baselinePath = option('--baseline');
      const currentPath = option('--current');
      if (!baselinePath || !currentPath) throw new OptimizeError('compare requires --baseline and --current JSON report paths.', 2, 'invalid_arguments');
      const outcome = (flag: string): TaskOutcome | undefined => {
        const value = option(flag);
        if (value === undefined) return undefined;
        if (!['completed', 'not-completed', 'unknown'].includes(value)) throw new OptimizeError(`${flag} must be completed, not-completed or unknown.`, 2, 'invalid_arguments');
        return value as TaskOutcome;
      };
      const elapsed = (flag: string): number | undefined => {
        const value = option(flag);
        if (value === undefined) return undefined;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) throw new OptimizeError(`${flag} must be a non-negative number of milliseconds.`, 2, 'invalid_arguments');
        return parsed;
      };
      const load = async (path: string, label: string): Promise<unknown> => {
        let contents: string;
        try { contents = await readFile(path, 'utf8'); }
        catch (error) { throw new OptimizeError(`Cannot read ${label} report "${path}": ${error instanceof Error ? error.message : String(error)}`, 3, 'missing_resource'); }
        try { return JSON.parse(contents); }
        catch { throw new OptimizeError(`${label} report is not valid JSON.`, 2, 'invalid_arguments'); }
      };
      const [baseline, current] = await Promise.all([load(baselinePath, 'Baseline'), load(currentPath, 'Current')]);
      let report;
      try {
        report = compareReports(baseline, current, {
          baselineOutcome: outcome('--baseline-outcome'),
          currentOutcome: outcome('--current-outcome'),
          baselineElapsedMs: elapsed('--baseline-elapsed-ms'),
          currentElapsedMs: elapsed('--current-elapsed-ms'),
        });
      } catch (error) {
        throw new OptimizeError(error instanceof Error ? error.message : String(error), 2, 'invalid_arguments');
      }
      if (json) return { code: 0, data: report };
      return { code: 0, data: compareText(report) };
    }
    if (command === 'audit') {
      if (flags[0] === 'help' || flags.includes('--help') || flags.includes('-h')) return { code: 0, data: HELP };
      rejectUnknownFlags();
      for (let index = 0; index < flags.length; index++) {
        const flag = flags[index]!;
        if (flag === '--consent' || flag === '--recent') continue;
        if (flag.startsWith('--')) { index++; continue; }
        throw new OptimizeError(`Unexpected argument "${flag}".`, 2, 'invalid_arguments');
      }
      const home = resolveHome();
      const rawHost = option('--host');
      let host: AuditHost = 'claude-code';
      if (rawHost !== undefined) {
        if (!HOSTS.includes(rawHost as AuditHost)) throw new OptimizeError(`--host "${rawHost}" is not a known host. Expected one of: ${HOSTS.join(', ')}.`, 2, 'invalid_arguments');
        host = rawHost as AuditHost;
      }
      const rawProject = option('--project');
      const project = rawProject === '.' ? process.cwd() : rawProject;
      const sessionId = option('--session-id');
      if (!flags.includes('--consent')) {
        const location = host === 'codex'
          ? `session rollouts under ${codexProjectsRoot(home)} (CODEX_HOME or ~/.codex/sessions)`
          : host === 'opencode'
            ? `the database at ${opencodeDatabasePath({ home })}`
            : `transcripts under ${claudeProjectsRoot(home)}`;
        throw new OptimizeError(
          `Reading local session history requires consent. The audit would read ${location} read-only, change nothing, and produce a local report. Re-run with --consent.`,
          3, 'missing_resource');
      }
      const limit = option('--sessions');
      const maxSessions = limit === undefined ? undefined : Number(limit);
      if (maxSessions !== undefined && (!Number.isSafeInteger(maxSessions) || maxSessions < 1)) {
        throw new OptimizeError('--sessions requires a positive integer', 2, 'invalid_arguments');
      }
      const report = await runAudit({ home, project, sessionId, maxSessions, host, recent: flags.includes('--recent') });
      if (json) return { code: 0, data: report };
      return { code: 0, data: summaryText(report) };
    }
    throw new OptimizeError(`Unknown optimize command "${command ?? ''}".\n\n${HELP}`, 2, 'invalid_arguments');
  })().catch((error: unknown): Result => {
    if (error instanceof OptimizeError) return { code: error.exitCode, status: error.status, errors: [error.message] };
    if (error instanceof DataError) return { code: 3, status: 'missing_resource', errors: [error.message] };
    return { code: 1, status: 'error', errors: [error instanceof Error ? error.message : String(error)] };
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(redactDeep({ schema_version: 1, command: `optimize ${command ?? ''}`.trim(), ok: result.code === 0, status: result.status ?? (result.code === 0 ? 'success' : 'error'), data: result.data ?? null, warnings: result.warnings ?? [], errors: result.errors ?? [] }), null, 2)}\n`);
    // The envelope carries the error for machines; stderr repeats it for humans (and keeps
    // the historical stderr contract for failed runs).
    for (const error of result.errors ?? []) process.stderr.write(`Error: ${redactSafe(error)}\n`);
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
      process.stderr.write(`Error: ${redactSafe(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = 1;
    });
}
