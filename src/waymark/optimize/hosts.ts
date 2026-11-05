// Inventory of what each installed assistant host actually exposes locally. Static facts plus a
// local presence detector; this module reads no private data (only directory existence), so it can
// run without consent. Statuses are honest: "observable" means the data is locally readable and was
// verified, "estimated" means the source exists but cannot be relied on (or has no reader yet), and
// "unavailable" means the host does not store it locally.
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
      detection: 'checks for ~/.codex',
      reader: 'not implemented',
      categories: {
        sessions: { coverage: 'estimated', detail: 'session rollout files exist under ~/.codex/sessions as JSONL; the reader is not implemented in this release and the layout must be verified before relying on it' },
        'tool events': { coverage: 'estimated', detail: 'rollout files are expected to record tool activity, unverified by this release' },
        'provider usage': { coverage: 'estimated', detail: 'token counts are expected in rollout payloads, unverified by this release' },
        'output sizes': { coverage: 'unavailable', detail: 'no verified measure of tool output sizes in the local rollout format' },
        're-read identity': { coverage: 'unavailable', detail: 'no verified per-file content identity in the local rollout format' },
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
      detection: 'checks for ~/.config/opencode or ~/.local/share/opencode',
      reader: 'not implemented',
      categories: {
        sessions: { coverage: 'estimated', detail: 'project storage directories exist under the data root; the layout differs across OpenCode versions and has no reader in this release' },
        'tool events': { coverage: 'estimated', detail: 'part records are expected to include tool activity, unverified by this release' },
        'provider usage': { coverage: 'estimated', detail: 'token counts may exist in message records but depend on the configured provider, unverified by this release' },
        'output sizes': { coverage: 'unavailable', detail: 'no verified measure of tool output sizes in the local storage layout' },
        're-read identity': { coverage: 'unavailable', detail: 'no verified per-file content identity in the local storage layout' },
        'limit and quota status': { coverage: 'unavailable', detail: 'depends on the provider; no local source is verified' },
        'instruction size': { coverage: 'estimated', detail: 'AGENTS.md sizes on disk are measurable, but session loads are not verified' },
      },
    },
  ];
}
