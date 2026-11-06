// Reader for local OpenCode session data in its current SQLite format. Read-only: the database
// is opened with better-sqlite3 in read-only, immutable mode (see openReadOnly) so opening it
// never creates the database or any journal/WAL/SHM sidecar next to it. Only the fields the
// audit reports on are selected; message text, tool output and raw command strings are measured
// (lengths, truncated hashes) and never retained or emitted. Cost, quota and subscription data
// are never read or inferred. Unknown or incompatible shapes degrade to a DataError, and
// unreported usage stays unknown (usage: null) rather than becoming zero.
//
// Verified against upstream OpenCode source (anomalyco/opencode, formerly sst/opencode):
// - Data root: XDG_DATA_HOME or ~/.local/share on every platform, then "opencode"
//   (packages/util/src/global-roots.ts, packages/core/src/global.ts), with the database at
//   <data>/opencode.db, overridable by OPENCODE_DB (absolute, or relative to the data root;
//   the CLI's database-path.ts). Release-channel databases (opencode-<channel>.db) are not
//   discovered here; only opencode.db and an explicit OPENCODE_DB override are read.
// - v1 (current stable line): tables session(id, project_id, directory, time_created, ...),
//   message(id, session_id, time_created, data JSON), part(id, message_id, session_id, data
//   JSON) in packages/opencode/src/session/session.sql.ts. Message data is the MessageV2
//   Info union (role user|assistant; assistant carries providerID, modelID and tokens
//   {input, output, reasoning, cache:{read, write}}); part data is a MessageV2 Part
//   discriminated by data.type, with tool parts carrying {tool, callID, state} and completed
//   state carrying {input, output} (packages/opencode/src/session/message-v2.ts).
// - v2 (packages/core/src/session/sql.ts): tables session_v2 (same identity columns plus
//   denormalised token columns, which this reader deliberately does not use), session_message
//   (id, session_id, type, seq, data JSON) and session_part (message_id, session_id, ordinal,
//   type, call_id, data JSON). Session-message data is the SessionMessage Info union
//   (packages/schema/src/session-message.ts): assistant messages carry model {id, providerID}
//   and tokens (packages/schema/src/token-usage.ts) and their content lives in session_part
//   rows as AssistantContent (text|reasoning|tool); a tool part carries {name, state} and
//   completed state carries {input, content: [{type: "text", text} | {type: "file", ...}]}.
// - Tool inputs (packages/opencode/src/tool/*.ts and packages/core/src/tool/*.ts): read
//   takes filePath (v1) or path (v2); grep/glob take pattern plus optional path/include;
//   bash (v1, also v2 core) and shell (v2 plugin) take command.
//
// The pre-SQLite flat-file layout (storage/session|message|part JSON files) is intentionally
// not read: it is frozen at migration time and has no verified reader here, so sessions that
// exist only there are reported as unavailable, never as zero.
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import { DataError } from './errors.js';
import {
  addUsage,
  fingerprint,
  identityKey,
  LARGE_OUTPUT_CHARS,
  safeCommandLabel,
  type LargeOutputObservation,
  type ReadObservation,
  type SearchObservation,
  type UsageTotals,
} from './observations.js';

type Db = Database.Database;
type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const asCount = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const parseJson = (value: unknown): JsonObject | undefined => {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};
const isoTime = (value: unknown): string | undefined => {
  const ms = asCount(value);
  return ms !== undefined && ms > 0 ? new Date(ms).toISOString() : undefined;
};
const emptyUsage = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
const sqliteCode = (error: unknown): string =>
  error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code ?? 'error') : 'error';
const projectKey = (path: string): string => {
  if (/^[a-zA-Z]:(?:[\\/]|$)/.test(path) || path.startsWith('\\\\') || path.includes('\\')) return identityKey(path);
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else if (part !== '..' || !absolute) parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}`;
};

// ---------------------------------------------------------------------------
// Paths (XDG / OPENCODE_DB), mirroring upstream global-roots and database-path.
// ---------------------------------------------------------------------------

export interface OpenCodePathOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/** OpenCode's data directory: $XDG_DATA_HOME/opencode, else ~/.local/share/opencode on every platform. */
export function opencodeDataRoot(options: OpenCodePathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const xdg = env.XDG_DATA_HOME;
  return xdg ? join(xdg, 'opencode') : join(home, '.local', 'share', 'opencode');
}

/**
 * The SQLite file to read. OPENCODE_DB wins (absolute as-is, relative resolved under the data
 * root, ":memory:" returned as-is and later reported as unreadable); otherwise opencode.db.
 */
export function opencodeDatabasePath(options: OpenCodePathOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env.OPENCODE_DB;
  if (override) return override === ':memory:' ? override : isAbsolute(override) ? override : join(opencodeDataRoot(options), override);
  return join(opencodeDataRoot(options), 'opencode.db');
}

// ---------------------------------------------------------------------------
// Read-only opening. Primary path: a file: URI with mode=ro&immutable=1, which
// reads the main file only when no journal sidecars exist. Immutable mode avoids
// source locks and sidecar creation; live WAL/rollback-journal state is reported unknown.
// ---------------------------------------------------------------------------

interface OpenHandle {
  db: Db;
  close: () => void;
  verify: () => void;
}

async function openReadOnly(databasePath: string): Promise<OpenHandle> {
  if (databasePath === ':memory:') throw new DataError('OpenCode database path is ":memory:"; there is no local file to read.');
  if (!existsSync(databasePath)) {
    throw new DataError(
      `No OpenCode database found at ${databasePath}. Either OpenCode has not run here, its database lives somewhere else (XDG_DATA_HOME / OPENCODE_DB), or it uses a release-channel database (opencode-<channel>.db) that this reader does not discover.`,
    );
  }
  if (['-wal', '-shm', '-journal'].some((suffix) => existsSync(`${databasePath}${suffix}`))) {
    throw new DataError(`OpenCode database at ${databasePath} has a live SQLite journal/WAL sidecar; this audit stops instead of reporting stale data. Close OpenCode and retry after SQLite has checkpointed and removed the sidecars; Cairn will not checkpoint or delete them.`);
  }
  try {
    const DatabaseCtor = (await import('better-sqlite3')).default;
    const initial = statSync(databasePath);
    const uri = `${pathToFileURL(resolve(databasePath)).href}?mode=ro&immutable=1`;
    const db = new DatabaseCtor(uri, { readonly: true, fileMustExist: true });
    if (['-wal', '-shm', '-journal'].some((suffix) => existsSync(`${databasePath}${suffix}`))) {
      db.close();
      throw new DataError(`OpenCode database at ${databasePath} changed while opening; a fresh consistent read is unavailable and its sessions are excluded as unknown.`);
    }
    return {
      db,
      close: () => db.close(),
      verify: () => {
        const current = statSync(databasePath);
        if (initial.size !== current.size || initial.mtimeMs !== current.mtimeMs || initial.ctimeMs !== current.ctimeMs || ['-wal', '-shm', '-journal'].some((suffix) => existsSync(`${databasePath}${suffix}`))) {
          throw new DataError(`OpenCode database at ${databasePath} changed while it was being read; a fresh consistent read is unavailable and its sessions are excluded as unknown.`);
        }
      },
    };
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError(`OpenCode database at ${databasePath} could not be opened in immutable read-only mode (${sqliteCode(error)}); its sessions are excluded as unknown.`);
  }
}

// ---------------------------------------------------------------------------
// Schema detection (v1, v2, or both when a migrated database keeps both).
// ---------------------------------------------------------------------------

export type OpenCodeSchema = 'v1' | 'v2' | 'v1+v2';

interface DetectedSchema {
  schema: OpenCodeSchema;
  hasV1: boolean;
  hasV2: boolean;
  hasSessionPart: boolean;
}

const tableColumns = (db: Db, table: string): Set<string> | undefined => {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as { name: string }[];
  return rows.length ? new Set(rows.map((row) => row.name)) : undefined;
};

function requireColumns(db: Db, table: string, wanted: string[], schemaLabel: string): void {
  const columns = tableColumns(db, table);
  if (!columns) return;
  const missing = wanted.filter((column) => !columns.has(column));
  if (missing.length) {
    throw new DataError(
      `OpenCode database uses an incompatible ${schemaLabel} schema: table "${table}" is missing column(s) ${missing.join(', ')}. Sessions are excluded as unknown rather than guessed.`,
    );
  }
}

function detectSchema(db: Db, databasePath: string): DetectedSchema {
  const hasV1 = tableColumns(db, 'session') !== undefined && tableColumns(db, 'message') !== undefined && tableColumns(db, 'part') !== undefined;
  const hasV2 = tableColumns(db, 'session_v2') !== undefined && tableColumns(db, 'session_message') !== undefined;
  if (hasV1) {
    requireColumns(db, 'session', ['id', 'project_id', 'directory'], 'v1');
    requireColumns(db, 'message', ['id', 'session_id', 'time_created', 'data'], 'v1');
    requireColumns(db, 'part', ['id', 'message_id', 'session_id', 'data'], 'v1');
  }
  if (hasV2) {
    requireColumns(db, 'session_v2', ['id', 'project_id', 'directory'], 'v2');
    requireColumns(db, 'session_message', ['id', 'session_id', 'type', 'data'], 'v2');
    if (tableColumns(db, 'session_part') !== undefined) {
      requireColumns(db, 'session_part', ['message_id', 'session_id', 'data'], 'v2');
    }
  }
  if (!hasV1 && !hasV2) {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    throw new DataError(
      `OpenCode database at ${databasePath} has no recognised session schema (found table(s): ${tables.join(', ') || 'none'}). It may use a newer or older layout this reader does not verify; sessions are excluded as unknown.`,
    );
  }
  return {
    schema: hasV1 && hasV2 ? 'v1+v2' : hasV1 ? 'v1' : 'v2',
    hasV1,
    hasV2,
    hasSessionPart: hasV2 && tableColumns(db, 'session_part') !== undefined,
  };
}

// ---------------------------------------------------------------------------
// Per-session summaries, mirroring ClaudeTranscript's shape for later audit use.
// ---------------------------------------------------------------------------

export interface OpenCodeSessionSummary {
  sessionId: string;
  project: string;
  database: string;
  /** Size of the single SQLite file (all sessions in one database share it). */
  bytes: number;
  schema: OpenCodeSchema;
  startedAt?: string;
  endedAt?: string;
  /** Provider-reported tokens, or null when the host recorded none. Never cost/quota. */
  usage: UsageTotals | null;
  usageByModel: Record<string, UsageTotals>;
  messages: number;
  parts: number;
  malformedRows: number;
  toolCalls: number;
  toolResultChars: number;
  reads: ReadObservation[];
  searches: SearchObservation[];
  largeOutputs: LargeOutputObservation[];
  largeOutputCount: number;
  largeOutputChars: number;
}

export interface OpenCodeSessionInfo {
  sessionId: string;
  project: string;
  database: string;
  bytes: number;
  schema: OpenCodeSchema;
}

interface SessionRow {
  id: string;
  project: string;
  startedAt?: string;
  endedAt?: string;
}

const rowProject = (row: JsonObject): string => asString(row.directory) ?? asString(row.project_id) ?? 'unknown';

function listSessionRows(db: Db, detected: DetectedSchema): SessionRow[] {
  const byId = new Map<string, SessionRow>();
  if (detected.hasV1) {
    const rows = db
      .prepare('SELECT id, project_id, directory, time_created, time_updated FROM session ORDER BY time_created, id')
      .all() as JsonObject[];
    for (const row of rows) {
      const id = asString(row.id);
      if (id) byId.set(id, { id, project: rowProject(row), startedAt: isoTime(row.time_created), endedAt: isoTime(row.time_updated) });
    }
  }
  if (detected.hasV2) {
    const rows = db
      .prepare('SELECT id, project_id, directory, time_created, time_updated FROM session_v2 ORDER BY time_created, id')
      .all() as JsonObject[];
    for (const row of rows) {
      const id = asString(row.id);
      if (!id) continue;
      const existing = byId.get(id);
      if (existing) {
        if (existing.project === 'unknown') existing.project = rowProject(row);
        existing.startedAt ??= isoTime(row.time_created);
        existing.endedAt ??= isoTime(row.time_updated);
      } else {
        byId.set(id, { id, project: rowProject(row), startedAt: isoTime(row.time_created), endedAt: isoTime(row.time_updated) });
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function usageFromTokens(tokens: unknown): UsageTotals | undefined {
  if (!isObject(tokens)) return undefined;
  const cache = isObject(tokens.cache) ? tokens.cache : {};
  const usage = emptyUsage();
  usage.inputTokens = asCount(tokens.input) ?? 0;
  usage.outputTokens = asCount(tokens.output) ?? 0;
  usage.cacheReadTokens = asCount(cache.read) ?? 0;
  usage.cacheCreationTokens = asCount(cache.write) ?? 0;
  const reasoning = asCount(tokens.reasoning);
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return usage;
}

const modelLabel = (provider: string | undefined, model: string | undefined): string =>
  provider && model ? `${provider}/${model}` : (model ?? 'unknown');

// v2 tool content is an array of {type: "text", text} | {type: "file", ...}; only text counts as output.
function v2OutputText(state: JsonObject): string {
  const content = state.content;
  if (Array.isArray(content)) {
    return content
      .filter((item): item is JsonObject => isObject(item) && item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text as string)
      .join('');
  }
  return asString(state.output) ?? '';
}

interface ToolEvent {
  tool: string;
  input: JsonObject | null;
  status: string;
  outputText: string;
}

function describeToolTarget(event: ToolEvent): string {
  const input = event.input ?? {};
  const file = asString(input.filePath) ?? asString(input.path);
  if (event.tool === 'read' && file) return identityKey(file);
  if (event.tool === 'bash' || event.tool === 'shell') {
    const command = asString(input.command);
    // Raw command text is never reported; only the executable name is evidence.
    return command ? safeCommandLabel(command) : event.tool;
  }
  const pattern = asString(input.pattern);
  if (pattern && (event.tool === 'grep' || event.tool === 'glob')) return `pattern ${pattern}`;
  return event.tool;
}

class SessionAccumulator {
  messages = 0;
  parts = 0;
  malformedRows = 0;
  toolCalls = 0;
  toolResultChars = 0;
  largeOutputCount = 0;
  largeOutputChars = 0;
  usage: UsageTotals | null = null;
  private startedAt?: string;
  private endedAt?: string;
  private readonly usageByModel = new Map<string, UsageTotals>();
  private readonly reads = new Map<string, ReadObservation & { labels: Set<string> }>();
  private readonly searches = new Map<string, SearchObservation>();
  private readonly largeOutputs: LargeOutputObservation[] = [];

  noteTime(iso: string | undefined): void {
    if (!iso) return;
    this.startedAt ??= iso;
    this.endedAt = iso;
  }

  seedTimes(startedAt: string | undefined, endedAt: string | undefined): void {
    this.noteTime(startedAt);
    if (endedAt && (!this.endedAt || endedAt > this.endedAt)) this.endedAt = endedAt;
  }

  addUsage(model: string, tokens: unknown): void {
    const usage = usageFromTokens(tokens);
    if (!usage) return;
    this.usage ??= emptyUsage();
    addUsage(this.usage, usage);
    const perModel = this.usageByModel.get(model) ?? emptyUsage();
    addUsage(perModel, usage);
    this.usageByModel.set(model, perModel);
  }

  absorbTool(event: ToolEvent, iso: string | undefined): void {
    this.toolCalls++;
    if (event.status !== 'completed') return; // pending/running/error carry no tool result to measure
    const text = event.outputText;
    this.toolResultChars += text.length;
    if (text.length >= LARGE_OUTPUT_CHARS) {
      this.largeOutputCount++;
      this.largeOutputChars += text.length;
      this.largeOutputs.push({ tool: event.tool, target: describeToolTarget(event), chars: text.length, fingerprint: fingerprint(text) });
    }
    const input = event.input ?? {};
    if (event.tool === 'read') {
      const file = asString(input.filePath) ?? asString(input.path);
      if (file) {
        const hash = fingerprint(text);
        if (!hash) return;
        const key = identityKey(file);
        const record = this.reads.get(key) ?? { path: file, reads: 0, versions: 0, identicalRepeats: 0, firstTimestamp: iso, lastTimestamp: iso, labels: new Set<string>() };
        if (hash && !record.labels.has(hash)) {
          record.labels.add(hash);
          record.versions++;
        } else if (hash) {
          record.identicalRepeats++;
        }
        record.reads++;
        if (iso) record.lastTimestamp = iso;
        this.reads.set(key, record);
      }
    }
    if (event.tool === 'grep' || event.tool === 'glob') {
      const pattern = asString(input.pattern);
      if (pattern) {
        const searchPath = asString(input.path) ?? '';
        const key = `${event.tool}|${pattern}|${identityKey(searchPath)}|${asString(input.include) ?? ''}`;
        const record = this.searches.get(key) ?? {
          tool: event.tool,
          pattern,
          searchPath,
          calls: 0,
          ...(asString(input.include) ? { include: asString(input.include) } : {}),
        };
        record.calls++;
        this.searches.set(key, record);
      }
    }
  }

  summary(base: {
    sessionId: string;
    project: string;
    database: string;
    bytes: number;
    schema: OpenCodeSchema;
  }): OpenCodeSessionSummary {
    const reads = [...this.reads.values()]
      .filter((record) => record.reads > 1)
      .map((record) => ({
        path: record.path,
        reads: record.reads,
        versions: record.versions,
        identicalRepeats: record.identicalRepeats,
        firstTimestamp: record.firstTimestamp,
        lastTimestamp: record.lastTimestamp,
      }))
      .sort((a, b) => b.identicalRepeats - a.identicalRepeats || b.reads - a.reads);
    const searches = [...this.searches.values()].filter((record) => record.calls > 1).sort((a, b) => b.calls - a.calls);
    const large = [...this.largeOutputs].sort((a, b) => b.chars - a.chars).slice(0, 5);
    return {
      ...base,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      usage: this.usage ? { ...this.usage } : null,
      usageByModel: Object.fromEntries(this.usageByModel),
      messages: this.messages,
      parts: this.parts,
      malformedRows: this.malformedRows,
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

function absorbToolPartData(acc: SessionAccumulator, data: JsonObject, iso: string | undefined): void {
  if (data.type !== 'tool') return;
  const state = isObject(data.state) ? data.state : undefined;
  const input = state && isObject(state.input) ? state.input : null;
  const outputText = state && state.status === 'completed' ? (asString(state.output) ?? '') : '';
  acc.absorbTool({ tool: asString(data.tool) ?? 'unknown', input, status: asString(state?.status) ?? 'unknown', outputText }, iso);
}

function absorbV1Session(db: Db, sessionId: string, acc: SessionAccumulator): void {
  const messages = db
    .prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id')
    .all(sessionId) as JsonObject[];
  for (const row of messages) {
    const data = parseJson(row.data);
    if (!data) {
      acc.malformedRows++;
      continue;
    }
    acc.messages++;
    const iso = isoTime(row.time_created);
    acc.noteTime(iso);
    // Message-level tokens only. Step-finish parts also carry tokens, but adding
    // them would double-count: each step's input/cache already includes the full
    // prompt, and upstream v1 overwrites message tokens on each step-finish, so a
    // multi-step message reports only its last step (a known undercount this
    // reader preserves by reporting message tokens verbatim, never by summing
    // steps into an invented total).
    if (data.role === 'assistant') acc.addUsage(modelLabel(asString(data.providerID), asString(data.modelID)), data.tokens);
  }
  const parts = db
    .prepare('SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY message_id, id')
    .all(sessionId) as JsonObject[];
  for (const row of parts) {
    const data = parseJson(row.data);
    if (!data) {
      acc.malformedRows++;
      continue;
    }
    acc.parts++;
    acc.noteTime(isoTime(row.time_created));
    absorbToolPartData(acc, data, isoTime(row.time_created));
  }
}

function absorbV2Session(db: Db, sessionId: string, detected: DetectedSchema, acc: SessionAccumulator): void {
  const messages = db
    .prepare('SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq, time_created, id')
    .all(sessionId) as JsonObject[];
  const partRowsByMessage = new Map<string, JsonObject[]>();
  if (detected.hasSessionPart) {
    const partRows = db
      .prepare('SELECT message_id, ordinal, type, data FROM session_part WHERE session_id = ? ORDER BY message_id, ordinal')
      .all(sessionId) as JsonObject[];
    for (const row of partRows) {
      const messageId = asString(row.message_id);
      if (!messageId) continue;
      const list = partRowsByMessage.get(messageId) ?? [];
      list.push(row);
      partRowsByMessage.set(messageId, list);
    }
  }
  for (const row of messages) {
    const data = parseJson(row.data);
    if (!data) {
      acc.malformedRows++;
      continue;
    }
    acc.messages++;
    const iso = isoTime(row.time_created);
    acc.noteTime(iso);
    const type = asString(row.type) ?? asString(data.type);
    if (type === 'assistant') {
      // Assistant messages only: compaction messages carry their own token
      // record for the compaction request, which is not assistant usage.
      const model = isObject(data.model) ? data.model : undefined;
      acc.addUsage(modelLabel(asString(model?.providerID), asString(model?.id) ?? asString(model?.modelID)), data.tokens);
    }
    const messageId = asString(row.id);
    const partRows = messageId ? partRowsByMessage.get(messageId) : undefined;
    if (partRows && partRows.length) {
      for (const partRow of partRows) {
        const partData = parseJson(partRow.data);
        if (!partData) {
          acc.malformedRows++;
          continue;
        }
        acc.parts++;
        if (partData.type === 'tool') {
          const state = isObject(partData.state) ? partData.state : undefined;
          const input = state && isObject(state.input) ? state.input : null;
          const outputText = state && state.status === 'completed' ? v2OutputText(state) : '';
          acc.absorbTool(
            { tool: asString(partData.name) ?? asString(partData.tool) ?? 'unknown', input, status: asString(state?.status) ?? 'unknown', outputText },
            iso,
          );
        }
      }
    } else if (Array.isArray(data.content)) {
      // Older v2 rows may inline assistant content instead of session_part rows.
      for (const item of data.content) {
        if (!isObject(item)) continue;
        acc.parts++;
        if (item.type === 'tool') {
          const state = isObject(item.state) ? item.state : undefined;
          const input = state && isObject(state.input) ? state.input : null;
          const outputText = state && state.status === 'completed' ? v2OutputText(state) : '';
          acc.absorbTool(
            { tool: asString(item.name) ?? asString(item.tool) ?? 'unknown', input, status: asString(state?.status) ?? 'unknown', outputText },
            iso,
          );
        }
      }
    }
  }
}

function readSessionWithDb(
  db: Db,
  detected: DetectedSchema,
  databasePath: string,
  bytes: number,
  session: SessionRow,
): OpenCodeSessionSummary {
  const acc = new SessionAccumulator();
  acc.seedTimes(session.startedAt, session.endedAt);
  // During migration both tables can contain the same session; v2 is canonical.
  if (detected.hasV2) absorbV2Session(db, session.id, detected, acc);
  else absorbV1Session(db, session.id, acc);
  return acc.summary({ sessionId: session.id, project: session.project, database: databasePath, bytes, schema: detected.schema });
}

// ---------------------------------------------------------------------------
// Public APIs for later audit integration. All are read-only and consent is the
// caller's responsibility (the future CLI must gate them behind --consent, as
// the Claude audit does); none of them writes to the database or its directory.
// ---------------------------------------------------------------------------

export async function listOpenCodeSessions(databasePath: string): Promise<OpenCodeSessionInfo[]> {
  const { db, close, verify } = await openReadOnly(databasePath);
  try {
    const detected = detectSchema(db, databasePath);
    const bytes = statSync(databasePath).size;
    const sessions = listSessionRows(db, detected).map((session) => ({
      sessionId: session.id,
      project: session.project,
      database: databasePath,
      bytes,
      schema: detected.schema,
    }));
    verify();
    return sessions;
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError(`OpenCode database at ${databasePath} could not be read (${sqliteCode(error)}); its sessions are excluded as unknown.`);
  } finally {
    close();
  }
}

export async function readOpenCodeSession(databasePath: string, sessionId: string): Promise<OpenCodeSessionSummary> {
  const { db, close, verify } = await openReadOnly(databasePath);
  try {
    const detected = detectSchema(db, databasePath);
    const session = listSessionRows(db, detected).find((row) => row.id === sessionId);
    if (!session) throw new DataError(`No OpenCode session "${sessionId}" found in ${databasePath}.`);
    const bytes = statSync(databasePath).size;
    const summary = readSessionWithDb(db, detected, databasePath, bytes, session);
    verify();
    return summary;
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError(`OpenCode session "${sessionId}" in ${databasePath} could not be read (${sqliteCode(error)}); it is excluded as unknown.`);
  } finally {
    close();
  }
}

export interface OpenCodeDatabaseSummary {
  database: string;
  bytes: number;
  schema: OpenCodeSchema;
  sessions: OpenCodeSessionSummary[];
  bounds: {
    projectsListed: number;
    projectsScanned: number;
    sessionsListed: number;
    sessionsScanned: number;
    sessionsSkipped: number;
    messages: number;
    parts: number;
    malformedRows: number;
  };
  skipped: { session: string; reason: string }[];
  limitations: string[];
}

export const OPENCODE_LIMITATIONS: string[] = [
  'Read-only: this reader uses SQLite immutable read-only mode only when no journal/WAL sidecar exists; when a live sidecar is present, sessions are excluded as unknown rather than risking a stale or torn read. Source files are never copied or changed.',
  'OpenCode storage is not a documented stable API; a host version change can change table or JSON shapes, and unknown shapes degrade to fewer observations instead of a false report.',
  'Only opencode.db (or an explicit OPENCODE_DB override) is read. Release-channel databases (opencode-<channel>.db) and the frozen pre-SQLite flat-file layout are not read.',
  'Token counts are provider-reported per assistant message, summed verbatim. They say nothing measured about subscription quota or cost, and this reader never converts them into either; it does not even select cost columns. In v1, upstream overwrites a multi-step message\'s tokens on each step-finish, so output/reasoning for multi-step messages can be undercounted; v2 compaction-message tokens are excluded from assistant usage.',
  'Reports contain file paths, search patterns, tool names, sizes and truncated output fingerprints - never file, output or raw command content. Redaction of incidental secrets in those text fields is best-effort and not a guarantee.',
  'Reads and searches are counted within one session only, so cross-session reuse is never claimed.',
];

export async function readOpenCodeDatabase(databasePath: string, options: { project?: string; maxSessions?: number } = {}): Promise<OpenCodeDatabaseSummary> {
  const { db, close, verify } = await openReadOnly(databasePath);
  try {
    const detected = detectSchema(db, databasePath);
    const bytes = statSync(databasePath).size;
    const allListed = listSessionRows(db, detected);
    let projects = [...new Set(allListed.map((session) => session.project))];
    if (options.project) {
      const wanted = projectKey(options.project);
      const exact = projects.filter((project) => projectKey(project) === wanted);
      projects = exact.length ? exact : projects.filter((project) => projectKey(project).endsWith(`/${wanted.replace(/^\/+/, '')}`));
      if (projects.length > 1) throw new DataError(`Project "${options.project}" is ambiguous: it matches ${projects.join(', ')}. Pass the full project directory.`);
      if (!projects.length) throw new DataError(`No OpenCode project directory matches "${options.project}". Available project directories: ${[...new Set(allListed.map((session) => session.project))].join(', ') || 'none'}`);
    }
    const selectedProjects = new Set(projects);
    const listed = allListed.filter((session) => selectedProjects.has(session.project));
    const ordered = [...listed].sort((a, b) => (b.endedAt ?? b.startedAt ?? '').localeCompare(a.endedAt ?? a.startedAt ?? '') || a.id.localeCompare(b.id));
    const maxSessions = options.maxSessions ?? Number.POSITIVE_INFINITY;
    const selected = ordered.slice(0, maxSessions);
    const sessions: OpenCodeSessionSummary[] = [];
    const skipped: { session: string; reason: string }[] = [];
    let messages = 0;
    let parts = 0;
    let malformedRows = 0;
    for (const session of selected) {
      try {
        const summary = readSessionWithDb(db, detected, databasePath, bytes, session);
        sessions.push(summary);
        messages += summary.messages;
        parts += summary.parts;
        malformedRows += summary.malformedRows;
      } catch (error) {
        // A failed session read is unknown data, never a zero contribution.
        skipped.push({ session: session.id, reason: error instanceof Error ? `${sqliteCode(error)}: ${error.message}` : String(error) });
      }
    }
    const limitations = [...OPENCODE_LIMITATIONS];
    if (listed.length > selected.length) limitations.push(`${listed.length - selected.length} matching session(s) beyond the ${maxSessions}-session cap were not read.`);
    if (skipped.length) limitations.push(`${skipped.length} session(s) could not be read and are excluded as unknown: ${skipped.map((entry) => `${entry.session} (${entry.reason})`).join('; ')}`);
    if (malformedRows) limitations.push(`${malformedRows} message/part row(s) were unparseable and skipped; this commonly includes rows being written while the database was read.`);
    verify();
    return {
      database: databasePath,
      bytes,
      schema: detected.schema,
      sessions,
      bounds: { projectsListed: new Set(allListed.map((session) => session.project)).size, projectsScanned: new Set(selected.map((session) => session.project)).size, sessionsListed: listed.length, sessionsScanned: sessions.length, sessionsSkipped: skipped.length + listed.length - selected.length, messages, parts, malformedRows },
      skipped,
      limitations,
    };
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError(`OpenCode database at ${databasePath} could not be read (${sqliteCode(error)}); its sessions are excluded as unknown.`);
  } finally {
    close();
  }
}

/** Per-session reader mirroring ClaudeTranscript, for audits that process one session at a time. */
export class OpenCodeTranscript {
  constructor(
    readonly database: string,
    readonly sessionId: string,
    readonly project: string,
    readonly bytes: number,
    readonly schema: OpenCodeSchema = 'v1',
  ) {}

  async read(): Promise<OpenCodeSessionSummary> {
    const summary = await readOpenCodeSession(this.database, this.sessionId);
    return { ...summary, project: this.project || summary.project, bytes: this.bytes || summary.bytes, schema: summary.schema };
  }
}
