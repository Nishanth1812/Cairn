// Reader for local Claude Code session transcripts. Read-only: files are opened and never written.
// It parses only the fields the audit reports on; file content and tool output are measured
// (lengths, truncated hashes) and never retained or emitted. Unknown shapes are skipped and
// counted, so a host version change degrades to fewer observations instead of a false report.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Results at or above this size are counted as large tool outputs. A constant keeps the audit
// comparable across runs; it is deliberately not user-configurable.
export const LARGE_OUTPUT_CHARS = 20_000;
const TARGET_PREVIEW_CHARS = 80;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const asCount = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const fingerprint = (text: string): string | null => /^\s*$/.test(text) ? null : createHash('sha1').update(text).digest('hex').slice(0, 12);

// Windows paths are case-insensitive, so one file read as both cases is one file. Separator form
// (\\ or /) never means a different file either.
function identityKey(path: string): string {
  const slash = path.replace(/\\/g, '/');
  return process.platform === 'win32' ? slash.toLowerCase() : slash;
}

export interface ReadObservation {
  path: string;
  reads: number;
  versions: number;
  identicalRepeats: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
}

export interface SearchObservation {
  tool: string;
  pattern: string;
  searchPath: string;
  calls: number;
}

export interface LargeOutputObservation {
  tool: string;
  target: string;
  chars: number;
  fingerprint: string | null;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}
export interface Observations {
  sessions: number;
  usage: UsageTotals;
  toolResultChars: number;
  repeatedReads: ReadObservation[];
  repeatedSearches: SearchObservation[];
  largeOutputCount: number;
  largeOutputChars: number;
  largeOutputs: LargeOutputObservation[];
}

export const emptyObservations = (): Observations => ({
  sessions: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  toolResultChars: 0,
  repeatedReads: [],
  repeatedSearches: [],
  largeOutputCount: 0,
  largeOutputChars: 0,
  largeOutputs: [],
});

export interface SessionSummary {
  sessionId: string;
  file: string;
  project: string;
  bytes: number;
  startedAt?: string;
  endedAt?: string;
  models: string[];
  usage: UsageTotals | null;
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
  private readonly models = new Map<string, number>();

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
    const model = asString(message.model);
    if (model) this.models.set(model, (this.models.get(model) ?? 0) + 1);
    if (entry.type === 'assistant') this.absorbAssistant(timestamp, message);
    else if (entry.type === 'user') this.absorbUser(timestamp, message);
  }

  private absorbAssistant(timestamp: string | undefined, message: JsonObject): void {
    const usage = isObject(message.usage) ? message.usage : undefined;
    if (usage) {
      this.usage ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
      this.usage.inputTokens += asCount(usage.input_tokens) ?? 0;
      this.usage.outputTokens += asCount(usage.output_tokens) ?? 0;
      this.usage.cacheReadTokens += asCount(usage.cache_read_input_tokens) ?? 0;
      this.usage.cacheCreationTokens += asCount(usage.cache_creation_input_tokens) ?? 0;
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
        searchPath: asString(input.path) });
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
      if (pending.file && !mark) {
        const key = identityKey(pending.file);
        const record = this.reads.get(key) ?? { path: pending.file, reads: 0, versions: 0, identicalRepeats: 0, firstTimestamp: timestamp, lastTimestamp: timestamp, labels: new Map() };
        const hash = fingerprint(text);
        if (hash && !record.labels.has(hash)) { record.labels.set(hash, hash); record.versions++; }
        else if (hash) record.identicalRepeats++;
        record.reads++;
        if (timestamp) record.lastTimestamp = timestamp;
        this.reads.set(key, record);
      }
      if (pending.pattern) {
        const key = `${pending.tool}|${pending.pattern}|${identityKey(pending.searchPath ?? '')}`;
        const record = this.searches.get(key) ?? { tool: pending.tool, pattern: pending.pattern, searchPath: pending.searchPath ?? '', calls: 0 };
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
      models: [...this.models.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model),
      usage: this.usage ? { ...this.usage } : null,
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

function describeTarget(pending: DanglingTool): { target: string } {
  if (pending.file) return { target: identityKey(pending.file) };
  if (pending.command) return { target: pending.command };
  if (pending.pattern) return { target: `pattern ${pending.pattern}` };
  return { target: pending.tool };
}

export function clipTarget(target: string): string {
  return target.length > TARGET_PREVIEW_CHARS ? `${target.slice(0, TARGET_PREVIEW_CHARS - 1)}…` : target;
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
