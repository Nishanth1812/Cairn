// Reader for local Codex session rollouts. Read-only: files are opened and never written.
// Format verified against upstream openai/codex (main, checked 2026-11-07): rollout files are
// `sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<thread-id>.jsonl` under CODEX_HOME
// (or `~/.codex` when CODEX_HOME is unset/empty; see codexHome), each line a
// `{timestamp, type, payload}` envelope whose payload is tagged by `type`
// (session_meta, turn_context, response_item, event_msg, token_usage_record, ...).
// It parses only the fields the audit reports on; file content, command arguments, patch
// text, MCP arguments and tool output are measured (lengths, truncated hashes) and never
// retained or emitted. Unknown shapes are skipped, so a host version change degrades to
// fewer observations instead of a false report.
//
// Structurally compatible with ProjectListing / SessionSummary from claudeTranscript.ts so a
// future audit can treat both hosts alike. Three honest gaps, by design:
// - `reads` and `searches` are always empty. Codex has no verified per-file read/search
//   tool event: file access happens through opaque shell commands, and classifying
//   `cat`/`grep` argv would fabricate evidence (and risk leaking arguments). hosts.ts
//   already marks Codex re-read identity unavailable for this reason.
// - `usageByModel` attributes each reported per-response delta to the model named by the
//   most recent turn_context line (the only model association the rollout records).
//   Sessions with no preceding turn_context attribute to `unknown`, as Claude does.
// - Compressed rollouts (`rollout-*.jsonl.zst`, written by upstream after ~7 days) and
//   `archived_sessions/` are not listed. Listing them without a decompressor would
//   fabricate zero-size sessions; they are excluded rather than miscounted.
//
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fingerprint, safeCommandLabel, LARGE_OUTPUT_CHARS, type LargeOutputObservation, type ReadObservation, type SearchObservation } from './observations.js';
import type { ProjectListing } from './claudeTranscript.js';

// Results at or above this size are counted as large tool outputs. The threshold is shared
// (see observations.ts) so the audit stays comparable across hosts; deliberately not configurable.
export { LARGE_OUTPUT_CHARS };

// Mirrors UsageTotals from observations.ts: Codex reports reasoning output separately from
// output tokens, so the field is present (possibly zero) whenever a cumulative token
// snapshot was observed, and the whole `usage` is null when none was.
export interface CodexUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens?: number;
}

// SessionSummary from claudeTranscript.ts with the Codex usage shape above. Every field the
// Claude summary carries is present with the same meaning; `usage`/`usageByModel` values may
// carry the extra optional `reasoningTokens`.
export interface CodexSessionSummary {
  sessionId: string;
  file: string;
  project: string;
  bytes: number;
  startedAt?: string;
  endedAt?: string;
  usage: CodexUsageTotals | null;
  usageByModel: Record<string, CodexUsageTotals>;
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

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
// Token counts are i64 on the wire; a negative or non-finite value is not a count.
const asCount = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

// fingerprint comes from observations.ts.

// Command arguments can contain credentials, URLs with tokens, or private paths, so only the
// executable basename is ever reported as a target; arguments are dropped entirely. Env
// assignments (`TOKEN=... npm test`) are skipped when picking the executable. This is
// intentionally lossy: evidence is the tool and output size, not the raw command.
// safeCommandLabel (observations.ts) already does exactly this, including the env-skip,
// quoting and clipping, so it is reused for string commands and argv alike.
const safeArgvExecutable = (argv: string[]): string => safeCommandLabel(argv.find((token) => token && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) ?? '');

// `function_call.arguments` is a JSON string on the wire. Only its `command` field is read,
// and only to derive the executable label above; the raw arguments (which may hold file
// contents or secrets) are never retained. Unparseable arguments yield no label.
function commandLabelFromArguments(argumentsText: string | undefined): string | undefined {
  if (!argumentsText) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(argumentsText); } catch { return undefined; }
  if (!isObject(parsed)) return undefined;
  const command = parsed.command;
  if (typeof command === 'string') return safeCommandLabel(command);
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) return safeArgvExecutable(command as string[]);
  return undefined;
}

// Model-visible text of a tool output in any verified wire shape: a plain string
// (`function_call_output.output` text body), an array of content items
// (`{type: "input_text", text}`), a `{content}` wrapper, or an MCP result
// (`{content: [...], structured_content}`). Image/audio/encrypted items carry no readable
// text and contribute nothing, matching upstream's text conversion.
function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(outputText).join('');
  if (isObject(value)) {
    if (typeof value.text === 'string') return value.text;
    if ('content' in value) return outputText(value.content);
    if ('output' in value) return outputText(value.output);
  }
  return '';
}

interface PendingTool { tool: string; target: string }

interface RawUsage { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number }

function parseTokenUsage(value: unknown): RawUsage | null {
  if (!isObject(value)) return null;
  return {
    input: asCount(value.input_tokens) ?? 0,
    output: asCount(value.output_tokens) ?? 0,
    cacheRead: asCount(value.cached_input_tokens) ?? 0,
    cacheWrite: asCount(value.cache_write_input_tokens) ?? 0,
    reasoning: asCount(value.reasoning_output_tokens) ?? 0,
    total: asCount(value.total_tokens) ?? 0,
  };
}

const toUsageTotals = (raw: RawUsage): CodexUsageTotals => ({
  inputTokens: raw.input,
  outputTokens: raw.output,
  cacheReadTokens: raw.cacheRead,
  cacheCreationTokens: raw.cacheWrite,
  reasoningTokens: raw.reasoning,
});

// Upstream resolution (codex-rs/utils/home-dir): a non-empty CODEX_HOME wins and is used
// as-is (relative values resolve against the working directory, as canonicalization would);
// otherwise the default is `<home>/.codex`. The `home` argument is the caller's home
// directory, so tests can point the reader at a synthetic tree through it.
export function codexHome(home: string): string {
  const override = process.env.CODEX_HOME;
  if (override) return isAbsolute(override) ? override : resolve(override);
  return join(home, '.codex');
}

export function codexProjectsRoot(home: string): string {
  return join(codexHome(home), 'sessions');
}

// `rollout-<timestamp>-<thread-id>[_<rollout-id>].jsonl` (upstream rollout_file_name.rs).
// The session id is the thread id: everything before the optional `_<rollout-id>` suffix
// used for reverted threads. Files that do not match are not rollouts and are skipped.
const ROLLOUT_FILE = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)\.jsonl$/;

function sessionIdFromFileName(name: string): string | undefined {
  const match = ROLLOUT_FILE.exec(name);
  if (!match) return undefined;
  const sessionId = (match[2] ?? '').split('_')[0];
  return sessionId || undefined;
}

// The sessions directory is organized by date, not by project, so the project a rollout
// belongs to can only be read from its first line: `session_meta.payload.cwd`. Only that
// one line is read (streamed, then closed); a missing, malformed or cwd-less first line
// yields `unknown` rather than a date folder or file name dressed up as a project.
async function peekProject(file: string): Promise<string> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      let entry: unknown;
      try { entry = JSON.parse(text); } catch { return 'unknown'; }
      if (isObject(entry) && entry.type === 'session_meta' && isObject(entry.payload)) {
        const cwd = asString(entry.payload.cwd);
        if (cwd) return cwd;
      }
      return 'unknown';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    lines.close();
    stream.destroy();
  }
}

// Lists every rollout under `<codex home>/sessions`, grouped by the project (session_meta
// cwd) each rollout declares. A file whose size cannot be read (deleted mid-scan, locked)
// is listed with bytes: null and only counted if the later read succeeds, so a missing size
// never becomes a fake zero — matching listClaudeProjects.
export async function listCodexProjects(home: string): Promise<ProjectListing[]> {
  const root = codexProjectsRoot(home);
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && sessionIdFromFileName(entry.name)) files.push(path);
    }
  };
  await walk(root);
  files.sort((a, b) => a.localeCompare(b));
  const byProject = new Map<string, { sessionId: string; file: string; bytes: number | null }[]>();
  for (const file of files) {
    const name = file.split(/[\\/]/).pop() ?? '';
    const sessionId = sessionIdFromFileName(name);
    if (!sessionId) continue;
    let bytes: number | null = null;
    try { bytes = (await stat(file)).size; } catch { bytes = null; }
    const project = await peekProject(file);
    const sessions = byProject.get(project) ?? [];
    sessions.push({ sessionId, file, bytes });
    byProject.set(project, sessions);
  }
  return [...byProject.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([project, sessions]) => ({ project, sessions: sessions.sort((a, b) => a.file.localeCompare(b.file)) }));
}

export class CodexTranscript {
  readonly sessionId: string;
  readonly file: string;
  readonly project: string;
  readonly bytes: number;
  lines = 0;
  malformedLines = 0;
  toolCalls = 0;
  toolResultChars = 0;
  largeOutputCount = 0;
  largeOutputChars = 0;
  private startedAt?: string;
  private endedAt?: string;
  private cumulative: RawUsage | null = null;
  private lastCumulativeKey: string | null = null;
  private currentModel = 'unknown';
  private readonly usageByModel = new Map<string, RawUsage>();
  private readonly pending = new Map<string, PendingTool>();
  private readonly countedCalls = new Set<string>();
  private readonly recordedOutputs = new Set<string>();
  private readonly largeOutputs: LargeOutputObservation[] = [];

  constructor(sessionId: string, file: string, project: string, bytes: number) {
    this.sessionId = sessionId;
    this.file = file;
    this.project = project;
    this.bytes = bytes;
  }

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
    const payload = isObject(entry.payload) ? entry.payload : undefined;
    if (!payload) return;
    switch (entry.type) {
      case 'turn_context': {
        const model = asString(payload.model);
        if (model) this.currentModel = model;
        break;
      }
      case 'token_usage_record': {
        // Newer per-response record: `usage` is the delta, `thread_token_usage` the
        // session cumulative. `turn_token_usage` is per-turn and is ignored.
        this.absorbCumulative(parseTokenUsage(payload.thread_token_usage), parseTokenUsage(payload.usage));
        break;
      }
      case 'response_item': this.absorbResponseItem(payload); break;
      case 'event_msg': this.absorbEventMsg(payload); break;
      default: break; // session_meta and every other verified type carry no audit fields here
    }
  }

  // `total_token_usage` is cumulative across the session (upstream adds each response into
  // it), while `last_token_usage` is the per-response delta. The session total is therefore
  // the latest cumulative snapshot — never a sum of snapshots or of deltas — so the same
  // session is counted once however many snapshots it holds. Two traps are handled:
  // - Rate-limit-only updates re-emit token_count with an unchanged cumulative and a
  //   repeated last delta; summing those would overcount, so a snapshot whose cumulative
  //   is unchanged since the last one contributes no per-model delta.
  // - After compaction, upstream fills the cumulative to the context window with every
  //   breakdown field zeroed. That synthetic fill is context state, not provider usage,
  //   so it is not adopted as the session total.
  // Rate limits themselves are never read: subscription quota is not in this file and is
  // never inferred from it.
  private absorbCumulative(total: RawUsage | null, delta: RawUsage | null, modelContextWindow?: number): void {
    if (!total) return;
    const syntheticFill = total.input === 0 && total.output === 0 && total.cacheRead === 0
      && total.cacheWrite === 0 && total.reasoning === 0 && total.total > 0
      && modelContextWindow !== undefined && total.total === modelContextWindow;
    if (syntheticFill) return;
    const key = [total.input, total.output, total.cacheRead, total.cacheWrite, total.reasoning, total.total].join('|');
    this.cumulative = total;
    if (key === this.lastCumulativeKey) return;
    this.lastCumulativeKey = key;
    if (!delta || delta.input + delta.output + delta.cacheRead + delta.cacheWrite + delta.reasoning === 0) return;
    const modelUsage = this.usageByModel.get(this.currentModel) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
    modelUsage.input += delta.input;
    modelUsage.output += delta.output;
    modelUsage.cacheRead += delta.cacheRead;
    modelUsage.cacheWrite += delta.cacheWrite;
    modelUsage.reasoning += delta.reasoning;
    modelUsage.total += delta.total;
    this.usageByModel.set(this.currentModel, modelUsage);
  }

  private registerCall(callId: string | undefined, tool: string, target: string): void {
    if (!callId) { this.toolCalls++; return; }
    if (this.countedCalls.has(callId)) return; // the same invocation appears as both a
    // response_item and an event_msg begin/end pair; it is one tool call, not two.
    this.countedCalls.add(callId);
    this.toolCalls++;
    this.pending.set(callId, { tool, target });
  }

  private recordOutput(callId: string | undefined, toolHint: string | undefined, text: string): void {
    if (callId) {
      if (this.recordedOutputs.has(callId)) return; // paired output seen twice (e.g. a
      // function_call_output and the exec_command_end for the same call): count it once.
      this.recordedOutputs.add(callId);
    }
    this.toolResultChars += text.length;
    if (text.length < LARGE_OUTPUT_CHARS) return;
    const pending = callId ? this.pending.get(callId) : undefined;
    const tool = pending?.tool ?? toolHint ?? 'unknown';
    this.largeOutputCount++;
    this.largeOutputChars += text.length;
    this.largeOutputs.push({ tool, target: pending?.target ?? tool, chars: text.length, fingerprint: fingerprint(text) });
  }

  private absorbResponseItem(payload: JsonObject): void {
    switch (payload.type) {
      case 'function_call': {
        const name = asString(payload.name) ?? 'unknown';
        const callId = asString(payload.call_id);
        const label = /shell|exec|command/i.test(name) ? commandLabelFromArguments(asString(payload.arguments)) : undefined;
        this.registerCall(callId, name, label ?? name);
        break;
      }
      case 'function_call_output': {
        this.recordOutput(asString(payload.call_id), asString(payload.name), outputText(payload.output));
        break;
      }
      case 'custom_tool_call': {
        const name = asString(payload.name) ?? 'unknown';
        // `input` for apply_patch is the patch text itself; it is never retained.
        this.registerCall(asString(payload.call_id), name, name);
        break;
      }
      case 'custom_tool_call_output': {
        this.recordOutput(asString(payload.call_id), asString(payload.name), outputText(payload.output));
        break;
      }
      case 'local_shell_call': {
        const action = isObject(payload.action) ? payload.action : undefined;
        const argv = action && Array.isArray(action.command) ? action.command.filter((part): part is string => typeof part === 'string') : [];
        // `action.env` may hold secrets and is never read.
        this.registerCall(asString(payload.call_id), 'shell', argv.length ? safeArgvExecutable(argv) : 'shell');
        break;
      }
      default: break; // messages, reasoning, web/image search calls: no tool output to measure
    }
  }

  private absorbEventMsg(payload: JsonObject): void {
    switch (payload.type) {
      case 'token_count': {
        const info = isObject(payload.info) ? payload.info : undefined;
        if (!info) break; // `info` is optional upstream: absent means unknown, never zero
        this.absorbCumulative(
          parseTokenUsage(info.total_token_usage),
          parseTokenUsage(info.last_token_usage),
          asCount(info.model_context_window),
        );
        break;
      }
      case 'exec_command_begin': {
        const command = payload.command;
        const target = typeof command === 'string' ? safeCommandLabel(command)
          : Array.isArray(command) ? safeArgvExecutable(command.filter((part): part is string => typeof part === 'string'))
          : 'shell';
        this.registerCall(asString(payload.call_id), 'shell', target);
        break;
      }
      case 'exec_command_end': {
        this.recordOutput(asString(payload.call_id), 'shell', asString(payload.aggregated_output) ?? '');
        break;
      }
      case 'patch_apply_begin': {
        this.registerCall(asString(payload.call_id), 'apply_patch', 'apply_patch');
        break;
      }
      case 'patch_apply_end': {
        const text = `${asString(payload.stdout) ?? ''}${asString(payload.stderr) ?? ''}`;
        this.recordOutput(asString(payload.call_id), 'apply_patch', text);
        break;
      }
      case 'mcp_tool_call_begin': {
        const invocation = isObject(payload.invocation) ? payload.invocation : undefined;
        const server = invocation ? asString(invocation.server) : undefined;
        const tool = invocation ? asString(invocation.tool) : undefined;
        const label = server && tool ? `mcp:${server}:${tool}` : tool ?? 'mcp';
        // `invocation.arguments` may hold secrets and is never read.
        this.registerCall(asString(payload.call_id), label, label);
        break;
      }
      case 'mcp_tool_call_end': {
        const invocation = isObject(payload.invocation) ? payload.invocation : undefined;
        const server = invocation ? asString(invocation.server) : undefined;
        const tool = invocation ? asString(invocation.tool) : undefined;
        const label = server && tool ? `mcp:${server}:${tool}` : tool ?? 'mcp';
        const result = payload.result;
        const text = typeof result === 'string' ? result : outputText(isObject(result) ? result.content ?? result : result);
        this.recordOutput(asString(payload.call_id), label, text);
        break;
      }
      default: break; // output deltas (the end event carries the full output), item lifecycle
      // wrappers, user/agent messages: counting them would double-count the paired records.
    }
  }

  summary(): CodexSessionSummary {
    const large = [...this.largeOutputs].sort((a, b) => b.chars - a.chars).slice(0, 5);
    return {
      sessionId: this.sessionId,
      file: this.file,
      project: this.project,
      bytes: this.bytes,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      usage: this.cumulative ? toUsageTotals(this.cumulative) : null,
      usageByModel: Object.fromEntries([...this.usageByModel.entries()].map(([model, raw]) => [model, toUsageTotals(raw)])),
      lines: this.lines,
      malformedLines: this.malformedLines,
      toolCalls: this.toolCalls,
      toolResultChars: this.toolResultChars,
      reads: [],
      searches: [],
      largeOutputs: large,
      largeOutputCount: this.largeOutputCount,
      largeOutputChars: this.largeOutputChars,
    };
  }
}
