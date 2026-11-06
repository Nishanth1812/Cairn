// Orchestrates the read-only, consent-gated audit. One report shape serves every host so
// opportunities stay comparable: Claude Code transcripts, Codex rollouts and the OpenCode
// SQLite database are read the same read-only way, but each host's gaps stay explicit in
// its limitations instead of being smoothed over. The audit aggregates observations,
// separates provider-reported usage from estimates, ranks only observed opportunities and
// never infers subscription quota, dollars, or unobserved categories.
import { existsSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ClaudeTranscript, emptyObservations, listClaudeProjects, claudeProjectsRoot, type ProjectListing } from './claudeTranscript.js';
import { CodexTranscript, listCodexProjects, codexProjectsRoot } from './codexTranscript.js';
import { opencodeDatabasePath, readOpenCodeDatabase, type OpenCodeSessionSummary } from './opencodeTranscript.js';
import { clipTarget, identityKey, type LargeOutputObservation, type ReadObservation, type SearchObservation, type UsageTotals } from './observations.js';
import { DataError } from './errors.js';
import { hostCoverage } from './hosts.js';

export { DataError } from './errors.js';

export type AuditHost = 'claude-code' | 'codex' | 'opencode';

export interface AuditBounds {
  projectsPresent: number;
  projectsScanned: number;
  sessionsScanned: number;
  sessionsSkipped: number;
  bytesRead: number;
  linesRead: number;
  malformedLines: number;
}

export interface UsageModelTotals { sessions: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; reasoningTokens?: number }
interface UsageRecord { id: string; usage: UsageTotals; usageByModel?: Record<string, UsageTotals> }

export interface ReadRow { project: string; session: string; path: string; reads: number; identicalRepeats: number; versions: number; firstTimestamp?: string; lastTimestamp?: string }

export interface SearchRow { project: string; session: string; tool: string; pattern: string; searchPath: string; calls: number; glob?: string; type?: string; include?: string }

export interface AuditReport {
  host: AuditHost;
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
  coverage: { id: AuditHost; label: string; reader: 'implemented' | 'not implemented'; categories: Record<string, { coverage: string; detail: string }> };
  limitations: string[];
  overhead: { elapsedMs: number };
}

export interface AuditOptions { home: string; project?: string; maxSessions?: number; host?: AuditHost; recent?: boolean }

const MAX_ROWS = 10;
const estimate = (chars: number): number => Math.round(chars / 4 * 1.1);

// Narrows a project listing to the one project a hint names, or the whole listing without a
// hint. Exact matches win; otherwise the hint must be a suffix of exactly one project name.
// Several matches are ambiguous and fail closed instead of widening the scan. The literal
// "unknown" is rejected for hosts where it is a fallback bucket for sessions whose project
// could not be read: scanning it would lump unrelated sessions together.
function selectProjects<T extends { project: string }>(all: T[], project: string | undefined, hostLabel: string, unknownIsBucket: boolean): T[] {
  if (!project) return all;
  if (unknownIsBucket && project.toLowerCase() === 'unknown') {
    throw new DataError(`Project "unknown" is not a real ${hostLabel} project; it is the fallback for sessions whose project could not be read. Pass the full project directory to audit one project.`);
  }
  const wanted = projectPathKey(project);
  const claudeEncoded = hostLabel === 'Claude Code' && (project.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(project) || project.includes('\\'))
    ? project.replace(/\\/g, '/').replace(/[:/]/g, '-')
    : undefined;
  const encodedExact = claudeEncoded === undefined ? [] : all.filter((listing) =>
    /^[a-zA-Z]:[\\/]/.test(project) || project.includes('\\')
      ? listing.project.toLowerCase() === claudeEncoded.toLowerCase()
      : listing.project === claudeEncoded);
  const exact = encodedExact.length ? encodedExact : all.filter((listing) => projectPathKey(listing.project) === wanted);
  const candidates = exact.length ? exact : all.filter((listing) => projectPathKey(listing.project).endsWith(`/${wanted.replace(/^\/+/, '')}`));
  if (!candidates.length) throw new DataError(`No ${hostLabel} project directory matches "${project}". Available project directories: ${all.map((listing) => listing.project).join(', ')}`);
  if (candidates.length > 1) throw new DataError(`Project "${project}" is ambiguous: it matches ${candidates.map((listing) => listing.project).join(', ')}. Ask for the full project directory name.`);
  return candidates;
}

function projectPathKey(path: string): string {
  if (/^[a-zA-Z]:(?:[\\/]|$)/.test(path) || path.startsWith('\\\\') || path.includes('\\')) return identityKey(path);
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else if (part !== '..' || !absolute) parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}`;
}

function fileMtime(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return Number.NEGATIVE_INFINITY; }
}

// What the aggregation needs from any host's per-session summary. Hosts differ only in how
// they obtain these values; the ranking below is shared so it cannot drift per host.
interface NormalizedSession {
  project: string;
  sessionId: string;
  usage: UsageTotals | null;
  usageByModel: Record<string, UsageTotals>;
  usageRecords?: UsageRecord[];
  toolResultChars: number;
  reads: ReadObservation[];
  searches: SearchObservation[];
  largeOutputs: LargeOutputObservation[];
  largeOutputCount: number;
  largeOutputChars: number;
  messages?: number;
  parts?: number;
  malformedRows?: number;
}

interface BuildInput {
  host: AuditHost;
  project: string | null;
  bounds: AuditBounds;
  sessions: NormalizedSession[];
  limitations: string[];
  usageNote: string;
  started: number;
  home: string;
}

const zeroUsage = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
function addUsageTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  const result: UsageTotals = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens };
  if (a.reasoningTokens !== undefined || b.reasoningTokens !== undefined) result.reasoningTokens = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  return result;
}
function subtractUsageTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  const result: UsageTotals = { inputTokens: Math.max(0, a.inputTokens - b.inputTokens), outputTokens: Math.max(0, a.outputTokens - b.outputTokens), cacheReadTokens: Math.max(0, a.cacheReadTokens - b.cacheReadTokens), cacheCreationTokens: Math.max(0, a.cacheCreationTokens - b.cacheCreationTokens) };
  if (a.reasoningTokens !== undefined || b.reasoningTokens !== undefined) result.reasoningTokens = Math.max(0, (a.reasoningTokens ?? 0) - (b.reasoningTokens ?? 0));
  return result;
}
function hasUsage(usage: UsageTotals): boolean {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens + (usage.reasoningTokens ?? 0) > 0;
}
function addUsageToAggregate(target: UsageTotals, usage: UsageTotals): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  target.cacheCreationTokens += usage.cacheCreationTokens;
  if (usage.reasoningTokens !== undefined) target.reasoningTokens = (target.reasoningTokens ?? 0) + usage.reasoningTokens;
}
function addModelUsage(totals: Map<string, UsageModelTotals>, model: string, usage: UsageTotals, countSession = true): void {
  const total = totals.get(model) ?? { sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  if (countSession) total.sessions++;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheCreationTokens += usage.cacheCreationTokens;
  if (usage.reasoningTokens !== undefined) total.reasoningTokens = (total.reasoningTokens ?? 0) + usage.reasoningTokens;
  totals.set(model, total);
}

function buildReport(input: BuildInput): AuditReport {
  const aggregated = emptyObservations();
  const modelTotals = new Map<string, UsageModelTotals>();
  const reads = new Map<string, ReadRow>();
  const searches = new Map<string, SearchRow>();
  const usageRecordValues = new Map<string, Set<string>>();
  const conflictingUsageIds = new Set<string>();
  const largeSamples: { tool: string; target: string; chars: number }[] = [];
  let sessionsWithProviderUsage = 0;
  let sessionsWithoutProviderUsage = 0;
  let estimatedTokensWithoutUsage = 0;

  for (const summary of input.sessions) {
    if (summary.usage) {
      sessionsWithProviderUsage++;
      const records = summary.usageRecords ?? [];
      const keyedUsage = records.reduce((total, record) => addUsageTotals(total, record.usage), zeroUsage());
      const remainder = subtractUsageTotals(summary.usage, keyedUsage);
      addUsageToAggregate(aggregated.usage, remainder);
      const modelSessionKeys = new Set<string>();
      for (const [model, usage] of Object.entries(summary.usageByModel)) {
        const keyed = records.reduce((total, record) => addUsageTotals(total, record.usageByModel?.[model] ?? zeroUsage()), zeroUsage());
        const unkeyed = subtractUsageTotals(usage, keyed);
        addModelUsage(modelTotals, model, unkeyed, false);
        if (hasUsage(unkeyed)) modelSessionKeys.add(model);
      }
      for (const record of records) {
        const value = JSON.stringify([record.usage, record.usageByModel ?? {}]);
        const key = `${input.host}|${record.id}`;
        const previous = usageRecordValues.get(key);
        if (previous?.has(value)) continue;
        if (previous) { conflictingUsageIds.add(key); previous.add(value); }
        else usageRecordValues.set(key, new Set([value]));
        addUsageToAggregate(aggregated.usage, record.usage);
        for (const [model, usage] of Object.entries(record.usageByModel ?? {})) {
          addModelUsage(modelTotals, model, usage, false);
          modelSessionKeys.add(model);
        }
      }
      for (const model of modelSessionKeys) (modelTotals.get(model) as UsageModelTotals).sessions++;
    } else {
      // No provider-reported usage in a session means the token side is only estimable there.
      sessionsWithoutProviderUsage++;
      estimatedTokensWithoutUsage += estimate(summary.toolResultChars);
    }
    if (!summary.usage) for (const [model, usage] of Object.entries(summary.usageByModel)) addModelUsage(modelTotals, model, usage);
    // Per-session rows, keyed so sessions stay isolated (cross-session reuse is not serviceable).
    for (const read of summary.reads) {
      const key = `${summary.project}|${summary.sessionId}|${identityKey(read.path)}`;
      const row = reads.get(key) ?? { project: summary.project, session: summary.sessionId, path: read.path, reads: 0, identicalRepeats: 0, versions: 0, firstTimestamp: read.firstTimestamp, lastTimestamp: read.lastTimestamp };
      row.reads += read.reads;
      row.identicalRepeats += read.identicalRepeats;
      row.versions = read.versions;
      if (read.lastTimestamp) row.lastTimestamp = read.lastTimestamp;
      reads.set(key, row);
    }
    for (const search of summary.searches) {
      // The identity includes the filters: the same pattern under a different glob/type/include
      // is a different search, not a repeat of the same one.
      const key = `${summary.project}|${summary.sessionId}|${search.tool}|${search.pattern}|${identityKey(search.searchPath)}|${search.glob ?? ''}|${search.type ?? ''}|${search.include ?? ''}`;
      const row = searches.get(key) ?? { project: summary.project, session: summary.sessionId, tool: search.tool, pattern: search.pattern, searchPath: search.searchPath, calls: 0, ...(search.glob ? { glob: search.glob } : {}), ...(search.type ? { type: search.type } : {}), ...(search.include ? { include: search.include } : {}) };
      row.calls += search.calls;
      searches.set(key, row);
    }
    aggregated.largeOutputCount += summary.largeOutputCount;
    aggregated.largeOutputChars += summary.largeOutputChars;
    for (const sample of summary.largeOutputs.slice(0, 2)) largeSamples.push({ tool: sample.tool, target: clipTarget(sample.target), chars: sample.chars });
  }

  const inventory = hostCoverage(input.home).find((entry) => entry.id === input.host);
  if (!inventory) throw new DataError('Host coverage table failed to load.');
  return {
    host: input.host,
    scope: { project: input.project },
    bounds: input.bounds,
    usage: {
      source: 'provider-reported-per-message-or-estimate',
      sessionsWithProviderUsage,
      sessionsWithoutProviderUsage,
      estimatedTokensWithoutUsage,
      byModel: Object.fromEntries([...modelTotals.entries()].sort()),
      notes: [
        input.usageNote,
        'Cache reads and cache creation are reported separately and never merged.',
        ...(conflictingUsageIds.size ? [`${conflictingUsageIds.size} repeated request identity/identities carried different usage snapshots; both were retained because neither can be assumed final.`] : []),
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
    coverage: { id: inventory.id, label: inventory.label, reader: inventory.reader, categories: inventory.categories },
    limitations: input.limitations,
    overhead: { elapsedMs: Math.round((performance.now() - input.started) * 10) / 10 },
  };
}

async function runClaudeAudit(options: AuditOptions, maxSessions: number, started: number): Promise<AuditReport> {
  const root = claudeProjectsRoot(options.home);
  if (!existsSync(root)) throw new DataError(`No Claude Code local data found at ${root}. Either Claude Code has not run here, or its session data lives somewhere else.`);
  const all = await listClaudeProjects(options.home);
  if (!all.length) throw new DataError(`No Claude Code project transcripts found under ${root}. Either Claude Code has not run here, or its session data lives somewhere else.`);
  const listings = selectProjects(all, options.project, 'Claude Code', false);

  const bounds: AuditBounds = { projectsPresent: all.length, projectsScanned: listings.length, sessionsScanned: 0, sessionsSkipped: 0, bytesRead: 0, linesRead: 0, malformedLines: 0 };
  const sessions: NormalizedSession[] = [];
  const readFailures: { session: string; reason: string }[] = [];

  const queued = listings.flatMap((listing) => listing.sessions.map((session) => ({ project: listing.project, ...session, recentTime: options.recent ? fileMtime(session.file) : undefined })));
  // Largest first when the session cap is hit: the sessions most likely to hold complete
  // multi-file work are the audited ones. The cap and any skipped sessions are always reported.
  queued.sort(options.recent
    ? (a, b) => (b.recentTime as number) - (a.recentTime as number) || a.file.localeCompare(b.file)
    : (a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
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
    sessions.push(transcript.summary());
  }

  const limitations: string[] = [
    'Read-only: this run opened host files for reading only, installed nothing and changed nothing.',
    'Claude Code transcript layout is undocumented; counts can be incomplete when sessions are truncated, rotated, or being written concurrently, and a host version change can change what is observable. The per-session subdirectories holding agent transcripts are also an undocumented detail.',
    'Provider token counts are API accounting recorded per assistant message. They say nothing measured about subscription quota or cost, and this report never converts them into either.',
    'Repeated provider requests are deduplicated only when message and request identity are both available and totals match; anonymous usage remains summed per file, and conflicting snapshots are retained and flagged.',
    'Token estimates use the project estimator (chars/4 x 1.1), not a model tokenizer.',
    'Reports contain file paths, search patterns, sizes and truncated content fingerprints - never file or output content. Redaction of incidental secrets in those text fields is best-effort and not a guarantee.',
    'Reads and searches are counted within one session only, so cross-session reuse is never claimed.',
    'Reinstate nothing: this audit does not deduplicate, compact or rewrite anything and installs no hooks.',
  ];
  if (options.recent) limitations.push('Recent-first selection uses transcript file modification time as an estimate, not a host session timestamp; ties use file path order.');
  if (readFailures.length > 0) limitations.push(`${readFailures.length} session file(s) could not be read and are excluded as unknown: ${readFailures.map((entry) => `${entry.session} (${entry.reason})`).join('; ')}`);
  if (bounds.malformedLines > 0) limitations.push(`${bounds.malformedLines} transcript line(s) were unparseable and skipped; this commonly includes lines being written while the file was read.`);
  const withoutUsage = sessions.filter((session) => !session.usage).length;
  if (withoutUsage > 0) limitations.push(`${withoutUsage} of ${sessions.length} audited sessions carry no provider-reported usage; their token side is only estimated (from observed tool-result sizes; assistant commentary is not measurable).`);
  if (bounds.sessionsSkipped > 0) limitations.push(`${bounds.sessionsSkipped} session file(s) beyond the ${maxSessions}-session cap were not scanned; rerun with --project to focus scope instead of inferring from partial data.`);

  return buildReport({
    host: 'claude-code',
    project: options.project ?? null,
    bounds,
    sessions,
    limitations,
    usageNote: 'Token counts are taken verbatim per assistant message when the host records usage, and summed per model; sessions without usage are estimated and separately flagged.',
    started,
    home: options.home,
  });
}

async function runCodexAudit(options: AuditOptions, maxSessions: number, started: number): Promise<AuditReport> {
  const root = codexProjectsRoot(options.home);
  if (!existsSync(root)) throw new DataError(`No Codex local data found at ${root}. Either Codex has not run here, or its session data lives somewhere else (CODEX_HOME).`);
  let all: ProjectListing[];
  try {
    all = await listCodexProjects(options.home);
  } catch (error) {
    throw new DataError(`Codex session directory under ${root} could not be listed (${error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code ?? 'error') : 'error'}: ${error instanceof Error ? error.message : String(error)}); its sessions are excluded as unknown.`);
  }
  if (!all.length) throw new DataError(`No Codex session rollouts found under ${root}. Either Codex has not run here, or its session data lives somewhere else (CODEX_HOME).`);
  const listings = selectProjects(all, options.project, 'Codex', true);

  const bounds: AuditBounds = { projectsPresent: all.length, projectsScanned: listings.length, sessionsScanned: 0, sessionsSkipped: 0, bytesRead: 0, linesRead: 0, malformedLines: 0 };
  const sessions: NormalizedSession[] = [];
  const readFailures: { session: string; reason: string }[] = [];

  const queued = listings.flatMap((listing) => listing.sessions.map((session) => ({ project: listing.project, ...session, recentTime: options.recent ? fileMtime(session.file) : undefined })));
  queued.sort(options.recent
    ? (a, b) => (b.recentTime as number) - (a.recentTime as number) || a.file.localeCompare(b.file)
    : (a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  for (const entry of queued) {
    if (bounds.sessionsScanned >= maxSessions) { bounds.sessionsSkipped++; continue; }
    const transcript = new CodexTranscript(entry.sessionId, entry.file, entry.project, entry.bytes ?? 0);
    try { await transcript.read(); }
    catch (error) {
      bounds.sessionsSkipped++;
      readFailures.push({ session: entry.file, reason: error instanceof Error ? `${(error as NodeJS.ErrnoException).code ?? 'error'}: ${error.message}` : String(error) });
      continue;
    }
    bounds.sessionsScanned++;
    bounds.bytesRead += entry.bytes ?? 0;
    bounds.linesRead += transcript.lines;
    bounds.malformedLines += transcript.malformedLines;
    sessions.push(transcript.summary());
  }

  const limitations: string[] = [
    'Read-only: this run opened host files for reading only, installed nothing and changed nothing.',
    'Codex rollout layout is verified against upstream openai/codex but is not a documented stable API; a host version change can change what is observable.',
    'Compressed rollouts (rollout-*.jsonl.zst) and archived_sessions/ are excluded, not counted as zero: sessions visible only there are not part of this audit.',
    'Repeated reads and searches are not reported for Codex: file access goes through opaque shell commands, so no per-file read identity is fabricated. Tool calls and output sizes are still measured.',
    'Per-model usage attributes each response delta to the model named by the most recent turn_context line; sessions without one attribute to unknown.',
    'Provider token counts are API accounting recorded per response. They say nothing measured about subscription quota or cost, and this report never converts them into either.',
    'Token estimates use the project estimator (chars/4 x 1.1), not a model tokenizer.',
    'Reports contain executable names, tool names, sizes and truncated content fingerprints - never command arguments, file content or tool output content. Redaction of incidental secrets in those text fields is best-effort and not a guarantee.',
    'Sessions are counted within one rollout only, so cross-session reuse is never claimed.',
    'Reinstate nothing: this audit does not deduplicate, compact or rewrite anything and installs no hooks.',
  ];
  if (options.recent) limitations.push('Recent-first selection uses rollout file modification time as an estimate, not a host session timestamp; ties use file path order.');
  if (readFailures.length > 0) limitations.push(`${readFailures.length} session file(s) could not be read and are excluded as unknown: ${readFailures.map((entry) => `${entry.session} (${entry.reason})`).join('; ')}`);
  if (bounds.malformedLines > 0) limitations.push(`${bounds.malformedLines} rollout line(s) were unparseable and skipped; this commonly includes lines being written while the file was read.`);
  const withoutUsage = sessions.filter((session) => !session.usage).length;
  if (withoutUsage > 0) limitations.push(`${withoutUsage} of ${sessions.length} audited sessions carry no provider-reported usage; their token side is only estimated (from observed tool-result sizes; assistant commentary is not measurable).`);
  if (bounds.sessionsSkipped > 0) limitations.push(`${bounds.sessionsSkipped} session file(s) beyond the ${maxSessions}-session cap were not scanned; rerun with --project to focus scope instead of inferring from partial data.`);

  return buildReport({
    host: 'codex',
    project: options.project ?? null,
    bounds,
    sessions,
    limitations,
    usageNote: 'Token counts are the latest cumulative snapshot per session, never a sum of snapshots; per-response deltas only attribute them to models and are summed per model.',
    started,
    home: options.home,
  });
}

async function runOpenCodeAudit(options: AuditOptions, maxSessions: number, started: number): Promise<AuditReport> {
  const database = opencodeDatabasePath({ home: options.home });
  const summary = await readOpenCodeDatabase(database, { project: options.project, maxSessions });
  if (!summary.bounds.sessionsListed) throw new DataError(`No OpenCode sessions found in ${database}. Either OpenCode has not run here, or its database lives somewhere else (XDG_DATA_HOME / OPENCODE_DB).`);
  const sessions: NormalizedSession[] = summary.sessions.map((session: OpenCodeSessionSummary) => ({
    project: session.project,
    sessionId: session.sessionId,
    usage: session.usage,
    usageByModel: session.usageByModel,
    messages: session.messages,
    parts: session.parts,
    malformedRows: session.malformedRows,
    toolResultChars: session.toolResultChars,
    reads: session.reads,
    searches: session.searches,
    largeOutputs: session.largeOutputs,
    largeOutputCount: session.largeOutputCount,
    largeOutputChars: session.largeOutputChars,
  }));
  const bounds: AuditBounds = {
    projectsPresent: summary.bounds.projectsListed,
    projectsScanned: summary.bounds.projectsScanned,
    sessionsScanned: sessions.length,
    sessionsSkipped: summary.bounds.sessionsSkipped,
    bytesRead: sessions.length ? summary.bytes : 0,
    linesRead: sessions.reduce((total, session) => total + (session.messages ?? 0) + (session.parts ?? 0), 0),
    malformedLines: sessions.reduce((total, session) => total + (session.malformedRows ?? 0), 0),
  };

  const limitations = [...summary.limitations];
  if (bounds.malformedLines > 0) limitations.push(`${bounds.malformedLines} message/part row(s) were unparseable and skipped; this commonly includes rows being written while the database was read.`);
  const withoutUsage = sessions.filter((session) => !session.usage).length;
  if (withoutUsage > 0) limitations.push(`${withoutUsage} of ${sessions.length} audited sessions carry no provider-reported usage; their token side is only estimated (from observed tool-result sizes; assistant commentary is not measurable).`);
  if (summary.bounds.sessionsSkipped > summary.skipped.length) limitations.push(`${summary.bounds.sessionsSkipped - summary.skipped.length} matching session(s) beyond the ${maxSessions}-session cap were not scanned; rerun with --project to focus scope instead of inferring from partial data.`);

  return buildReport({
    host: 'opencode',
    project: options.project ?? null,
    bounds,
    sessions,
    limitations,
    usageNote: 'Token counts are taken verbatim per assistant message when the host records usage, and summed per model; sessions without usage are estimated and separately flagged.',
    started,
    home: options.home,
  });
}

export async function runAudit(options: AuditOptions): Promise<AuditReport> {
  const started = performance.now();
  const maxSessions = options.maxSessions ?? 500;
  const host = options.host ?? 'claude-code';
  if (host === 'codex') return runCodexAudit(options, maxSessions, started);
  if (host === 'opencode') return runOpenCodeAudit(options, maxSessions, started);
  return runClaudeAudit(options, maxSessions, started);
}
