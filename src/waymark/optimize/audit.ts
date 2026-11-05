// Orchestrates the read-only audit for the first verified host (Claude Code). It aggregates
// observations, separates provider-reported usage from estimates, ranks only observed opportunities
// and never infers subscription quota, dollars, or unobserved categories.
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ClaudeTranscript, clipTarget, emptyObservations, listClaudeProjects, claudeProjectsRoot } from './claudeTranscript.js';
import { hostCoverage } from './hosts.js';

export class DataError extends Error {}

export interface AuditBounds {
  projectsPresent: number;
  projectsScanned: number;
  sessionsScanned: number;
  sessionsSkipped: number;
  bytesRead: number;
  linesRead: number;
  malformedLines: number;
}

export interface UsageModelTotals { sessions: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }

export interface ReadRow { project: string; session: string; path: string; reads: number; identicalRepeats: number; versions: number; firstTimestamp?: string; lastTimestamp?: string }

export interface SearchRow { project: string; session: string; tool: string; pattern: string; searchPath: string; calls: number }

export interface AuditReport {
  host: 'claude-code';
  scope: { project: string | null };
  bounds: AuditBounds;
  usage: {
    source: 'provider-reported-per-message-or-estimate';
    sessionsWithProviderUsage: number;
    sessionsWithoutProviderUsage: number;
    estimatedTokensWithoutUsage: number;
    byModel: Record<string, UsageModelTotals>;
    notes: string[];
  };
  opportunities: {
    repeatedReads: ReadRow[];
    repeatedSearches: SearchRow[];
    largeToolOutputs: { count: number; chars: number; estimatedTokens: number; samples: { tool: string; target: string; chars: number }[] };
  };
  coverage: { id: 'claude-code'; label: string; reader: 'implemented' | 'not implemented'; categories: Record<string, { coverage: string; detail: string }> };
  limitations: string[];
  overhead: { elapsedMs: number };
}

export interface AuditOptions { home: string; project?: string; maxSessions?: number }

const MAX_ROWS = 10;
const estimate = (chars: number): number => Math.round(chars / 4 * 1.1);

export async function runAudit(options: AuditOptions): Promise<AuditReport> {
  const started = performance.now();
  const maxSessions = options.maxSessions ?? 500;
  const root = claudeProjectsRoot(options.home);
  if (!existsSync(root)) throw new DataError(`No Claude Code local data found at ${root}. Either Claude Code has not run here, or its session data lives somewhere else.`);
  const all = await listClaudeProjects(options.home);
  if (!all.length) throw new DataError(`No Claude Code project transcripts found under ${root}. Either Claude Code has not run here, or its session data lives somewhere else.`);
  let listings = all;
  if (options.project) {
    const wanted = options.project.toLowerCase();
    // A hint may be the encoded directory name or any unique suffix of it (e.g. "demoA").
    const match = all.filter((listing) => listing.project.toLowerCase() === wanted || listing.project.toLowerCase().endsWith(wanted));
    if (!match.length) throw new DataError(`No Claude Code project directory matches "${options.project}". Available project directories: ${all.map((listing) => listing.project).join(', ')}`);
    listings = match;
  }

  const bounds: AuditBounds = { projectsPresent: all.length, projectsScanned: listings.length, sessionsScanned: 0, sessionsSkipped: 0, bytesRead: 0, linesRead: 0, malformedLines: 0 };
  const aggregated = emptyObservations();
  const modelTotals = new Map<string, UsageModelTotals>();
  const reads = new Map<string, ReadRow>();
  const searches = new Map<string, SearchRow>();
  const largeSamples: { tool: string; target: string; chars: number }[] = [];
  const readFailures: { session: string; reason: string }[] = [];
  let sessionsWithProviderUsage = 0;
  let sessionsWithoutProviderUsage = 0;
  let estimatedTokensWithoutUsage = 0;

  const queued = listings.flatMap((listing) => listing.sessions.map((session) => ({ project: listing.project, ...session })));
  // Largest first when the session cap is hit: the sessions most likely to hold complete
  // multi-file work are the audited ones. The cap and any skipped sessions are always reported.
  queued.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  for (const entry of queued) {
    if (bounds.sessionsScanned >= maxSessions) { bounds.sessionsSkipped++; continue; }
    const transcript = new ClaudeTranscript(entry.sessionId, entry.file, entry.project, entry.bytes ?? 0);
    try { await transcript.read(); }
    catch (error) {
      // A failed read is unknown data, never a zero contribution: report it and move on.
      bounds.sessionsSkipped++;
      readFailures.push({ session: entry.file, reason: error instanceof Error ? `${(error as NodeJS.ErrnoException).code ?? 'error'}: ${error.message}` : String(error) });
      continue;
    }
    bounds.sessionsScanned++;
    bounds.bytesRead += entry.bytes ?? 0;
    bounds.linesRead += transcript.lines;
    bounds.malformedLines += transcript.malformedLines;
    const summary = transcript.summary();
    if (summary.usage) {
      sessionsWithProviderUsage++;
      aggregated.usage.inputTokens += summary.usage.inputTokens;
      aggregated.usage.outputTokens += summary.usage.outputTokens;
      aggregated.usage.cacheReadTokens += summary.usage.cacheReadTokens;
      aggregated.usage.cacheCreationTokens += summary.usage.cacheCreationTokens;
    } else {
      // No provider-reported usage in a session means the token side is only estimable there.
      sessionsWithoutProviderUsage++;
      estimatedTokensWithoutUsage += estimate(summary.toolResultChars);
    }
    for (const model of summary.models.slice(0, 1)) {
      const totals = modelTotals.get(model) ?? { sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
      totals.sessions++;
      if (summary.usage) {
        totals.inputTokens += summary.usage.inputTokens;
        totals.outputTokens += summary.usage.outputTokens;
        totals.cacheReadTokens += summary.usage.cacheReadTokens;
        totals.cacheCreationTokens += summary.usage.cacheCreationTokens;
      }
      modelTotals.set(model, totals);
    }
    // Per-session rows, keyed so sessions stay isolated (cross-session reuse is not serviceable).
    for (const read of summary.reads) {
      const key = `${entry.project}|${entry.sessionId}|${read.path.toLowerCase()}`;
      const row = reads.get(key) ?? { project: entry.project, session: entry.sessionId, path: read.path, reads: 0, identicalRepeats: 0, versions: 0, firstTimestamp: read.firstTimestamp, lastTimestamp: read.lastTimestamp };
      row.reads += read.reads;
      row.identicalRepeats += read.identicalRepeats;
      row.versions = read.versions;
      if (read.lastTimestamp) row.lastTimestamp = read.lastTimestamp;
      reads.set(key, row);
    }
    for (const search of summary.searches) {
      const key = `${entry.project}|${entry.sessionId}|${search.tool}|${search.pattern}|${search.searchPath.toLowerCase()}`;
      const row = searches.get(key) ?? { project: entry.project, session: entry.sessionId, tool: search.tool, pattern: search.pattern, searchPath: search.searchPath, calls: 0 };
      row.calls += search.calls;
      searches.set(key, row);
    }
    aggregated.largeOutputCount += summary.largeOutputCount;
    aggregated.largeOutputChars += summary.largeOutputChars;
    for (const sample of summary.largeOutputs.slice(0, 2)) largeSamples.push({ tool: sample.tool, target: clipTarget(sample.target), chars: sample.chars });
  }

  const limitations: string[] = [
    'Read-only: this run opened host files for reading only, installed nothing and changed nothing.',
    'Claude Code transcript layout is undocumented; counts can be incomplete when sessions are truncated, rotated, or being written concurrently, and a host version change can change what is observable. The per-session subdirectories holding agent transcripts are also an undocumented detail.',
    'Provider token counts are API accounting recorded per assistant message. They say nothing measured about subscription quota or cost, and this report never converts them into either.',
    'Token estimates use the project estimator (chars/4 x 1.1), not a model tokenizer.',
    'Reports contain file paths, search patterns, sizes and truncated content fingerprints - never file or output content. Redaction of incidental secrets in those text fields is best-effort and not a guarantee.',
    'Reads and searches are counted within one session only, so cross-session reuse is never claimed.',
    'Reinstate nothing: this audit does not deduplicate, compact or rewrite anything and installs no hooks.',
  ];
  const failedReads = readFailures.length;
  if (failedReads > 0) limitations.push(`${failedReads} session file(s) could not be read and are excluded as unknown: ${readFailures.map((entry) => `${entry.session} (${entry.reason})`).join('; ')}`);
  if (bounds.malformedLines > 0) limitations.push(`${bounds.malformedLines} transcript line(s) were unparseable and skipped; this commonly includes lines being written while the file was read.`);
  if (sessionsWithoutProviderUsage > 0) limitations.push(`${sessionsWithoutProviderUsage} of ${sessionsWithProviderUsage + sessionsWithoutProviderUsage} audited sessions carry no provider-reported usage; their token side is only estimated (from observed tool-result sizes; assistant commentary is not measurable).`);
  if (bounds.sessionsSkipped > 0) limitations.push(`${bounds.sessionsSkipped} session file(s) beyond the ${maxSessions}-session cap were not scanned; rerun with --project to focus scope instead of inferring from partial data.`);

  const [claude] = hostCoverage(options.home);
  if (!claude) throw new DataError('Host coverage table failed to load.');
  return {
    host: 'claude-code',
    scope: { project: options.project ?? null },
    bounds,
    usage: {
      source: 'provider-reported-per-message-or-estimate',
      sessionsWithProviderUsage,
      sessionsWithoutProviderUsage,
      estimatedTokensWithoutUsage,
      byModel: Object.fromEntries([...modelTotals.entries()].sort()),
      notes: [
        'Token counts are taken verbatim per assistant message when the host records usage, and summed per model; sessions without usage are estimated and separately flagged.',
        'Cache reads and cache creation are reported separately and never merged.',
      ],
    },
    opportunities: {
      repeatedReads: [...reads.values()].sort((a, b) => b.identicalRepeats - a.identicalRepeats || b.reads - a.reads).slice(0, MAX_ROWS),
      repeatedSearches: [...searches.values()].sort((a, b) => b.calls - a.calls).slice(0, MAX_ROWS),
      largeToolOutputs: {
        count: aggregated.largeOutputCount,
        chars: aggregated.largeOutputChars,
        estimatedTokens: estimate(aggregated.largeOutputChars),
        samples: largeSamples.sort((a, b) => b.chars - a.chars).slice(0, MAX_ROWS),
      },
    },
    coverage: { id: 'claude-code', label: claude.label, reader: claude.reader, categories: claude.categories },
    limitations,
    overhead: { elapsedMs: Math.round((performance.now() - started) * 10) / 10 },
  };
}
