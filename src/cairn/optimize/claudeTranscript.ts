// Reader for local Claude Code session transcripts. Read-only: files are opened and never written.
// It parses only the fields the audit reports on; file content and tool output are measured
// (lengths, truncated hashes) and never retained or emitted. Unknown shapes are skipped and
// counted, so a host version change degrades to fewer observations instead of a false report.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprint, identityKey, safeCommandLabel, LARGE_OUTPUT_CHARS, type LargeOutputObservation, type ReadObservation, type SearchObservation, type UsageTotals } from './observations.js';

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const asCount = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

// Shared shapes live in observations.ts so every host reports the same observation kinds.
// They stay re-exported here for the existing import sites (audit, tests, tooling).
export { clipTarget, emptyObservations, LARGE_OUTPUT_CHARS, fingerprint, identityKey } from './observations.js';
export type { LargeOutputObservation, ReadObservation, SearchObservation, UsageTotals } from './observations.js';

export interface SessionSummary {
  sessionId: string;
  file: string;
  project: string;
  bytes: number;
  startedAt?: string;
  endedAt?: string;
  usage: UsageTotals | null;
  usageByModel: Record<string, UsageTotals>;
  lines: number;
  malformedLines: number;
  toolCalls: number;
  toolResultChars: number;
  reads: ReadObservation[];
  searches: SearchObservation[];
  largeOutputs: LargeOutputObservation[];
  largeOutputCount: number;
  largeOutputChars: number;
}

function collectText(parts: unknown): string {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  let text = '';
  for (const part of parts) if (isObject(part) && part.type === 'text' && typeof part.text === 'string') text += part.text;
  return text;
}

// A compiled view pairing tool_use with its tool_result, kept per session (never across sessions).
interface DanglingTool {
  tool: string;
  file?: string;
  command?: string;
  pattern?: string;
  searchPath?: string;
  glob?: string;
  type?: string;
}

export class ClaudeTranscript {
  readonly sessions: SessionSummary[] = [];
  readonly skipped: { session: string; reason: string }[] = [];
  private readonly pending = new Map<string, DanglingTool>();
  private readonly reads = new Map<string, ReadObservation & { labels: Map<string, string> }>();
  private readonly searches = new Map<string, SearchObservation>();
  private readonly largeOutputs: LargeOutputObservation[] = [];
  usage: UsageTotals | null = null;
  lines = 0;
  malformedLines = 0;
  toolCalls = 0;
  toolResultChars = 0;
  largeOutputCount = 0;
  largeOutputChars = 0;
  private startedAt?: string;
  private endedAt?: string;
  private readonly usageByModel = new Map<string, UsageTotals>();
  // One entry per counted API response, keyed by message/request identity (see absorbAssistant).
  private readonly usageEntries = new Map<string, { model: string; totals: UsageTotals; hasStop: boolean }>();

  constructor(readonly sessionId: string, readonly file: string, readonly project: string, readonly bytes: number) {}

  async read(): Promise<void> {
    const raw = await readFile(this.file, 'utf8'); // read errors propagate: the audit reports them, it never retry-writes
    for (const line of `${raw}\n`.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      this.lines++;
      let entry: unknown;
      try { entry = JSON.parse(text); } catch { this.malformedLines++; continue; } // truncated or corrupted lines are tolerated per line
      this.absorb(isObject(entry) ? entry : {});
    }
  }

  private absorb(entry: JsonObject): void {
    const timestamp = asString(entry.timestamp);
    if (timestamp) { this.startedAt ??= timestamp; this.endedAt = timestamp; }
    const message = isObject(entry.message) ? entry.message : undefined;
    if (!message) return;
    if (entry.type === 'assistant') this.absorbAssistant(timestamp, entry, message);
    else if (entry.type === 'user') this.absorbUser(timestamp, message);
  }

  private addUsage(model: string, totals: UsageTotals, sign: 1 | -1): void {
    this.usage ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const modelUsage = this.usageByModel.get(model) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    for (const target of [this.usage, modelUsage]) {
      target.inputTokens += sign * totals.inputTokens;
      target.outputTokens += sign * totals.outputTokens;
      target.cacheReadTokens += sign * totals.cacheReadTokens;
      target.cacheCreationTokens += sign * totals.cacheCreationTokens;
    }
    this.usageByModel.set(model, modelUsage);
  }

  private absorbAssistant(timestamp: string | undefined, entry: JsonObject, message: JsonObject): void {
    const usage = isObject(message.usage) ? message.usage : undefined;
    if (usage) {
      const totals: UsageTotals = {
        inputTokens: asCount(usage.input_tokens) ?? 0,
        outputTokens: asCount(usage.output_tokens) ?? 0,
        cacheReadTokens: asCount(usage.cache_read_input_tokens) ?? 0,
        cacheCreationTokens: asCount(usage.cache_creation_input_tokens) ?? 0,
      };
      const model = asString(message.model) ?? 'unknown';
      // One API response can be written as several transcript lines sharing a message.id (and a
      // requestId), each carrying that response's full usage. Summing lines would count it once
      // per line, so count each message+request identity once. A repeated identity is a later,
      // cumulative snapshot of the same response, so it replaces the earlier one (a snapshot
      // already carrying stop_reason is the final one and is not overwritten by a later
      // non-final duplicate). The same message.id under a different requestId is a separate
      // request and is counted separately; entries with no identity cannot be told apart and
      // each is counted, never merged. Tool observations below run on every line regardless, so
      // a usage duplicate never discards the tool calls its lines carry.
      const messageId = asString(message.id);
      const requestId = asString(entry.requestId);
      const key = messageId && requestId ? `msg:${messageId}|req:${requestId}` : messageId ? `msg:${messageId}` : requestId ? `req:${requestId}` : undefined;
      if (!key) this.addUsage(model, totals, 1);
      else {
        const hasStop = asString(message.stop_reason) !== undefined;
        const prior = this.usageEntries.get(key);
        if (prior && prior.hasStop && !hasStop) { /* keep the final stop_reason snapshot */ }
        else {
          if (prior) this.addUsage(prior.model, prior.totals, -1);
          this.usageEntries.set(key, { model, totals, hasStop });
          this.addUsage(model, totals, 1);
        }
      }
    }
    const content = Array.isArray(message.content) ? message.content : [];
    for (const item of content) {
      if (!isObject(item) || item.type !== 'tool_use') continue;
      this.toolCalls++;
      const input = isObject(item.input) ? item.input : {};
      const tool = asString(item.name) ?? 'unknown';
      if (asString(item.id)) this.pending.set(String(item.id), { tool,
        file: asString(input.file_path),
        command: asString(input.command),
        pattern: asString(input.pattern),
        searchPath: asString(input.path),
        glob: asString(input.glob),
        type: asString(input.type) });
    }
    if (timestamp) this.startedAt ??= timestamp;
  }

  private absorbUser(timestamp: string | undefined, message: JsonObject): void {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const item of content) {
      if (!isObject(item) || item.type !== 'tool_result') continue;
      const text = collectText(item.content);
      this.toolResultChars += text.length;
      const pending = item.tool_use_id === undefined ? undefined : this.pending.get(String(item.tool_use_id));
      if (!pending) continue;
      const mark = item.is_error === true;
      if (text.length >= LARGE_OUTPUT_CHARS) {
        this.largeOutputCount++;
        this.largeOutputChars += text.length;
        this.largeOutputs.push({ tool: pending.tool, ...describeTarget(pending), chars: text.length, fingerprint: fingerprint(text) });
      }
      if (typeof item.tool_use_id !== 'string') continue;
      // Only Read loads a file; Write/Edit and friends name a file_path too but never read it, so
      // counting every file-bearing tool would report writes and edits as repeated reads.
      if (pending.file && !mark && pending.tool.toLowerCase() === 'read') {
        const key = identityKey(pending.file);
        const record = this.reads.get(key) ?? { path: pending.file, reads: 0, versions: 0, identicalRepeats: 0, firstTimestamp: timestamp, lastTimestamp: timestamp, labels: new Map() };
        const hash = fingerprint(text);
        if (hash && !record.labels.has(hash)) { record.labels.set(hash, hash); record.versions++; }
        else if (hash) record.identicalRepeats++;
        record.reads++;
        if (timestamp) record.lastTimestamp = timestamp;
        this.reads.set(key, record);
      }
      // Only Grep (content search) and Glob (path search) are searches. Their identity is the
      // pattern plus the normalized search path plus the Grep glob/type filters when present:
      // the same pattern under a different filter is a different search, not a repeat of it.
      const searchTool = pending.tool.toLowerCase();
      if (pending.pattern && (searchTool === 'grep' || searchTool === 'glob')) {
        const key = `${pending.tool}|${pending.pattern}|${identityKey(pending.searchPath ?? '')}|${pending.glob ?? ''}|${pending.type ?? ''}`;
        const record = this.searches.get(key) ?? { tool: pending.tool, pattern: pending.pattern, searchPath: pending.searchPath ?? '', calls: 0, ...(pending.glob ? { glob: pending.glob } : {}), ...(pending.type ? { type: pending.type } : {}) };
        record.calls++;
        this.searches.set(key, record);
      }
    }
  }

  summary(): SessionSummary {
    const reads = [...this.reads.values()]
      .filter((record) => record.reads > 1)
      .map((record) => ({ path: record.path, reads: record.reads, versions: record.versions, identicalRepeats: record.identicalRepeats, firstTimestamp: record.firstTimestamp, lastTimestamp: record.lastTimestamp }))
      .sort((a, b) => b.identicalRepeats - a.identicalRepeats || b.reads - a.reads);
    const searches = [...this.searches.values()].filter((record) => record.calls > 1).sort((a, b) => b.calls - a.calls);
    const large = [...this.largeOutputs].sort((a, b) => b.chars - a.chars).slice(0, 5);
    return {
      sessionId: this.sessionId,
      file: this.file,
      project: this.project,
      bytes: this.bytes,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      usage: this.usage ? { ...this.usage } : null,
      usageByModel: Object.fromEntries(this.usageByModel),
      lines: this.lines,
      malformedLines: this.malformedLines,
      toolCalls: this.toolCalls,
      toolResultChars: this.toolResultChars,
      reads,
      searches,
      largeOutputs: large,
      largeOutputCount: this.largeOutputCount,
      largeOutputChars: this.largeOutputChars,
    };
  }
}

// Large-output targets are surfaced in the audit, so a shell command is reported by its
// executable name only (see safeCommandLabel): arguments are dropped entirely because they
// can hold credentials, and pattern-matching redaction cannot recognize every secret shape.
// File paths and search patterns are reported as-is; the CLI redacts them best-effort on the
// way out, which is a best effort, not a guarantee.
function describeTarget(pending: DanglingTool): { target: string } {
  if (pending.file) return { target: identityKey(pending.file) };
  if (pending.command) return { target: safeCommandLabel(pending.command) };
  if (pending.pattern) return { target: `pattern ${pending.pattern}` };
  return { target: pending.tool };
}

export interface ProjectListing { project: string; sessions: { sessionId: string; file: string; bytes: number | null }[] }

export function claudeProjectsRoot(home: string): string {
  return join(home, '.claude', 'projects');
}

// Lists every project directory and every transcript file in it, including the per-session
// subdirectories this host uses for agent transcripts. A file whose size cannot be read (deleted
// mid-scan, locked) is listed with bytes: null and only counted if the later read succeeds, so a
// missing size never becomes a fake zero.
export async function listClaudeProjects(home: string): Promise<ProjectListing[]> {
  const root = claudeProjectsRoot(home);
  const projects: ProjectListing[] = [];
  const dirs = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const dir of dirs) {
    const base = join(root, dir.name);
    const walk = async (prefix: string): Promise<{ sessionId: string; file: string; bytes: number | null }[]> => {
      const sessions: { sessionId: string; file: string; bytes: number | null }[] = [];
      const entries = await readdir(join(base, prefix), { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) sessions.push(...await walk(relative));
        else if (entry.name.endsWith('.jsonl')) {
          const path = join(base, relative);
          let bytes: number | null = null;
          try { bytes = (await stat(path)).size; } catch { bytes = null; }
          sessions.push({ sessionId: entry.name.replace(/\.jsonl$/, ''), file: path, bytes });
        }
      }
      return sessions;
    };
    projects.push({ project: dir.name, sessions: await walk('') });
  }
  return projects;
}
