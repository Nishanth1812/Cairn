// Shared, host-neutral observation types and small privacy helpers. Host readers produce these
// values; the audit only ranks and reports them. Keeping the shapes here means Codex and OpenCode
// cannot quietly invent a different definition of a repeated read or a large output.
import { createHash } from 'node:crypto';
import { redactSafe } from '../core/security/redactor.js';

// Results at or above this size are counted as large tool outputs. A constant keeps the audit
// comparable across hosts; it is deliberately not user-configurable.
export const LARGE_OUTPUT_CHARS = 20_000;
const TARGET_PREVIEW_CHARS = 80;

export interface ReadObservation {
  path: string;
  reads: number;
  versions: number;
  identicalRepeats: number;
  // Model-visible chars loaded across reads of this file; drives the per-row
  // savings estimate (identical repeats are the truly avoidable share).
  readChars?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
}

export interface SearchObservation {
  tool: string;
  pattern: string;
  searchPath: string;
  calls: number;
  // Grep filters that make two searches over one pattern genuinely different searches, and
  // the include filter OpenCode records instead. All optional so the four fields above
  // identify a search when no filter is present.
  glob?: string;
  type?: string;
  include?: string;
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
  // Codex and OpenCode record reasoning output separately; Claude Code does not. The field stays
  // absent when the host did not report it, so an absent value is never reported as zero.
  reasoningTokens?: number;
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

export const fingerprint = (text: string): string | null =>
  /^\s*$/.test(text) ? null : createHash('sha1').update(text).digest('hex').slice(0, 12);

// Path identity is lexical only (the audit never stats files): separators, "." and ".." segments
// never mean a different file. Windows-like paths (drive letter, UNC, or backslash separators, or
// any path on a Windows host) are case-insensitive, so they fold case on every host; POSIX paths
// keep their case, since case-folding them would merge genuinely different files. Symlinks and
// relative-vs-absolute spellings of one file cannot be told apart without touching the filesystem.
export function identityKey(path: string): string {
  if (!path) return '';
  const raw = path.replace(/\\/g, '/');
  const windowsLike = /^[a-zA-Z]:(\/|$)/.test(raw) || raw.startsWith('//') || path.includes('\\') || process.platform === 'win32';
  const absolute = raw.startsWith('/');
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      const last = segments[segments.length - 1];
      if (last && last !== '..' && !/^[a-zA-Z]:$/.test(last)) segments.pop();
      else if (!absolute) segments.push('..');
      continue;
    }
    segments.push(segment);
  }
  let key = segments.join('/');
  if (absolute && !/^[a-zA-Z]:/.test(key)) key = `${raw.startsWith('//') ? '//' : '/'}${key}`;
  return windowsLike ? key.toLowerCase() : key;
}

export function clipTarget(target: string): string {
  return target.length > TARGET_PREVIEW_CHARS ? `${target.slice(0, TARGET_PREVIEW_CHARS - 1)}…` : target;
}

// File paths in read rows are redacted but never clipped: the audit exists to name
// the file a user should stop re-reading, and an 80-char cutoff hid it behind "…".
export function redactPath(text: string): string {
  return redactSafe(text);
}

export function redactAndClip(text: string): string {
  return clipTarget(redactSafe(text));
}

// Command arguments can contain credentials, URLs with tokens, or private paths. The report never
// needs the full command, so it keeps only the executable name. This is intentionally lossy:
// evidence is the tool and output size, not the raw command.
export function safeCommandLabel(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const executable = tokens.find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) ?? '';
  const unquoted = executable.replace(/^['"]|['"]$/g, '');
  const base = unquoted.split(/[\\/]/).pop() || unquoted;
  return redactAndClip(base || 'command');
}

// Count the model-visible text in a tool output of any known host shape: a string, content items
// (`{type: "text", text}`), or an array of either.
export function textLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce<number>((total, item) => total + textLength(item), 0);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text.length;
    if ('content' in record) return textLength(record.content);
    return Object.values(record).reduce<number>((total, item) => total + textLength(item), 0);
  }
  return value === null || value === undefined ? 0 : String(value).length;
}

export function addUsage(target: UsageTotals, source: UsageTotals): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  if (source.reasoningTokens !== undefined) target.reasoningTokens = (target.reasoningTokens ?? 0) + source.reasoningTokens;
}
