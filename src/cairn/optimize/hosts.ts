// Inventory of what each installed assistant host actually exposes locally. Static facts plus a
// local presence detector; this module reads no private data (only directory existence), so it can
// run without consent. Statuses are honest: "observable" means the data is locally readable and was
// verified against the upstream source (see the reader headers for the exact upstream paths),
// "estimated" means the source exists but cannot be relied on, and "unavailable" means the host
// does not store it locally — or, like Codex re-read identity, that a verified reader deliberately
// does not fabricate it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type HostId = 'claude-code' | 'codex' | 'opencode';
export type CoverageStatus = 'observable' | 'estimated' | 'unavailable';

export interface CategoryCoverage { coverage: CoverageStatus; detail: string }

export interface HostInventory {
  id: HostId;
  label: string;
  appType: string;
  orchestration: string;
  dataRoot: string;
  installed: boolean;
  detection: string;
  reader: 'implemented' | 'not implemented';
  categories: Record<string, CategoryCoverage>;
}

function claudeInstalled(home: string): boolean {
  return existsSync(join(home, '.claude', 'projects')) || existsSync(join(home, '.claude', 'settings.json'));
}
function codexInstalled(home: string): boolean {
  return existsSync(join(home, '.codex'));
}
function opencodeInstalled(home: string): boolean {
  return existsSync(join(home, '.config', 'opencode')) || existsSync(join(home, '.local', 'share', 'opencode'));
}

export function hostCoverage(home: string): HostInventory[] {
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      appType: 'local terminal and desktop application writing sessions on this machine',
      orchestration: 'local; no cloud-only session log is required for this audit',
      dataRoot: join(home, '.claude'),
      installed: claudeInstalled(home),
      detection: 'checks for ~/.claude/projects or ~/.claude/settings.json',
      reader: 'implemented',
      categories: {
        sessions: { coverage: 'observable', detail: 'JSONL transcripts under ~/.claude/projects/<project>/<session>.jsonl; the layout is not a documented stable API, so version-dependent misreads stay possible' },
        'tool events': { coverage: 'observable', detail: 'assistant lines record tool_use inputs (file paths, search patterns) and user lines record the matching tool_result' },
        'provider usage': { coverage: 'observable', detail: 'assistant lines may carry input/output/cache token counts; when present they are API token accounting and are not subscription billing or quota' },
        'output sizes': { coverage: 'observable', detail: 'tool_result text lengths are measurable without retaining content' },
        're-read identity': { coverage: 'observable', detail: 'tool_result content can be fingerprinted to tell identical re-reads from re-reads after change; the fingerprint is a truncated hash, not content' },
        'limit and quota status': { coverage: 'unavailable', detail: 'subscription limits are not stored in local transcripts; no quota is ever inferred' },
        'instruction size': { coverage: 'estimated', detail: 'CLAUDE.md file sizes on disk are measurable, but which instruction text a session actually loaded is not reliably recorded per line' },
      },
    },
    {
      id: 'codex',
      label: 'Codex',
      appType: 'local CLI writing sessions on this machine',
      orchestration: 'local session logs; usage limits are cloud-side and not exposed locally by this reader',
      dataRoot: join(home, '.codex'),
      installed: codexInstalled(home),
      detection: 'checks for ~/.codex (CODEX_HOME overrides the data root)',
      reader: 'implemented',
      categories: {
        sessions: { coverage: 'observable', detail: 'rollout JSONL under ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl (CODEX_HOME overrides the root), verified against openai/codex; compressed .zst rollouts and archived sessions are excluded, not guessed' },
        'tool events': { coverage: 'observable', detail: 'response_item and event_msg records pair tool calls with outputs; command arguments, patch text and MCP arguments are never retained, only executable names are reported' },
        'provider usage': { coverage: 'observable', detail: 'token_count and token_usage_record payloads carry cumulative session totals; the latest snapshot wins, rate limits are never read, and usage is API accounting, not subscription billing or quota' },
        'output sizes': { coverage: 'observable', detail: 'tool output lengths are measurable without retaining content (same 20k-char threshold as the other hosts)' },
        're-read identity': { coverage: 'unavailable', detail: 'no verified per-file read event exists in rollouts: file access goes through opaque shell commands, so this reader deliberately fabricates nothing' },
        'limit and quota status': { coverage: 'unavailable', detail: 'Codex pricing documents usage as factor-dependent; subscription quota state is not available locally' },
        'instruction size': { coverage: 'estimated', detail: 'AGENTS.md sizes on disk are measurable, but session loads are not verified' },
      },
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      appType: 'local open-source assistant with configurable providers',
      orchestration: 'local storage plus provider-remote model calls; provider behavior varies per configuration',
      dataRoot: join(home, '.local', 'share', 'opencode'),
      installed: opencodeInstalled(home),
      detection: 'checks for ~/.config/opencode or ~/.local/share/opencode (XDG_DATA_HOME and OPENCODE_DB override the directory and file)',
      reader: 'implemented',
      categories: {
        sessions: { coverage: 'observable', detail: 'SQLite database (opencode.db, or OPENCODE_DB) holding v1 (session/message/part) and v2 (session_v2/session_message/session_part) tables, verified against upstream OpenCode; read read-only in immutable mode or via a private temp copy, so no journal/WAL/SHM file is ever created next to the source' },
        'tool events': { coverage: 'observable', detail: 'tool parts carry the tool name, input and completed output; raw command strings are never reported, only executable names' },
        'provider usage': { coverage: 'observable', detail: 'assistant messages carry provider-reported input/output/reasoning/cache tokens, summed verbatim; they are never converted to cost or quota, and cost columns are never even selected' },
        'output sizes': { coverage: 'observable', detail: 'completed tool output lengths are measurable without retaining content (same 20k-char threshold as the other hosts)' },
        're-read identity': { coverage: 'observable', detail: 'completed read outputs can be fingerprinted to tell identical re-reads from re-reads after change; the fingerprint is a truncated hash, not content' },
        'limit and quota status': { coverage: 'unavailable', detail: 'depends on the provider; no local source is verified' },
        'instruction size': { coverage: 'estimated', detail: 'AGENTS.md sizes on disk are measurable, but session loads are not verified' },
      },
    },
  ];
}
