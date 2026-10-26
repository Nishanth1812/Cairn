import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { calculateCostMicros } from './pricing.js';

type Usage = { input: number; output: number; cached: number; write: number; model: string | null; at: string };
interface TranscriptRow {
  type?: string; id?: string; session_id?: string; sessionId?: string; cwd?: string; timestamp?: string; model?: string;
  message?: { id?: string; model?: string; usage?: Record<string, unknown>; content?: Array<{ type?: string; name?: string }> };
  payload?: { type?: string; id?: string; cwd?: string; info?: { total_token_usage?: Record<string, unknown> }; name?: string; call_id?: string };
}
const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function repoFor(db: Database.Database, cwd: string | null): string | null {
  if (!cwd) return null;
  const repos = db.prepare('SELECT id, root_path FROM repositories').all() as Array<{ id: string; root_path: string }>;
  // A session started in a subfolder still belongs to the repo that contains it; the deepest root wins.
  const dir = normalize(cwd);
  const inside = repos.filter((r) => { const root = normalize(r.root_path); return dir === root || dir.startsWith(`${root}/`); });
  return inside.sort((a, b) => b.root_path.length - a.root_path.length)[0]?.id ?? null;
}

function record(db: Database.Database, id: string, harness: string, cwd: string | null, usage: Usage, provenance: 'harness_reported' | 'provider_reported') {
  const repoId = repoFor(db, cwd);
  db.prepare(`INSERT INTO sessions (id, repo_id, harness, model, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET repo_id=excluded.repo_id, model=excluded.model, ended_at=excluded.ended_at`)
    .run(`${harness}:${id}`, repoId, harness, usage.model, usage.at, usage.at);
  const sessionId = `${harness}:${id}`;
  const cost = usage.model ? calculateCostMicros(usage.model, usage.input + usage.cached, usage.output, usage.cached, usage.write).costMicros : null;
  const eventId = `${harness}:${id}`;
  db.prepare(`INSERT INTO usage_events (id, session_id, source, provenance, observed_at, model, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens, cost_micros)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at, model=excluded.model, input_tokens=excluded.input_tokens,
      output_tokens=excluded.output_tokens, cached_input_tokens=excluded.cached_input_tokens, cache_write_tokens=excluded.cache_write_tokens, cost_micros=excluded.cost_micros`)
    .run(eventId, sessionId, harness, provenance, usage.at, usage.model, usage.input + usage.cached, usage.output, usage.cached, usage.write, cost);
}

function files(root: string): Promise<string[]> {
  return readdir(root, { withFileTypes: true }).then(async (entries) => (await Promise.all(entries.map((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : [];
  }))).flat()).catch(() => []);
}

async function ingestFile(db: Database.Database, path: string, harness: 'claude-code' | 'codex') {
  const info = await stat(path);
  const prior = db.prepare('SELECT size_bytes, mtime_ms FROM transcript_files WHERE path = ?').get(path) as { size_bytes: number; mtime_ms: number } | undefined;
  if (prior?.size_bytes === info.size && prior.mtime_ms === info.mtimeMs) return;
  const text = await readFile(path, 'utf8');
  const sessionUses = new Map<string, { cwd: string | null; at: string; model: string | null; rows: Map<string, Usage>; tools: Map<string, number>; toolKeys: Set<string> }>();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let row: TranscriptRow; try { row = JSON.parse(line) as TranscriptRow; } catch { continue; }
    if (harness === 'claude-code' && row.type === 'assistant' && row.message?.usage && row.sessionId) {
      const item = sessionUses.get(row.sessionId) ?? { cwd: row.cwd ?? null, at: row.timestamp ?? new Date(info.mtimeMs).toISOString(), model: row.message.model ?? null, rows: new Map<string, Usage>(), tools: new Map<string, number>(), toolKeys: new Set<string>() };
      item.cwd ??= row.cwd ?? null; item.at = row.timestamp ?? item.at; item.model = row.message.model ?? item.model;
      const u = row.message.usage;
      item.rows.set(row.message.id ?? `${row.timestamp}:${item.rows.size}`, { input: count(u.input_tokens), output: count(u.output_tokens), cached: count(u.cache_read_input_tokens), write: count(u.cache_creation_input_tokens), model: row.message.model ?? null, at: row.timestamp ?? item.at });
      for (const [index, block] of (row.message.content ?? []).entries()) if (block.type === 'tool_use' && typeof block.name === 'string') {
        const key = `${row.message.id}:${index}:${block.name}`;
        if (!item.toolKeys.has(key)) { item.toolKeys.add(key); item.tools.set(block.name, (item.tools.get(block.name) ?? 0) + 1); }
      }
      sessionUses.set(row.sessionId, item);
    }
    if (harness === 'codex' && row.type === 'session_meta') {
      const id = row.id ?? row.session_id ?? path;
      sessionUses.set(id, { cwd: row.cwd ?? null, at: row.timestamp ?? new Date(info.mtimeMs).toISOString(), model: row.model ?? null, rows: new Map(), tools: new Map(), toolKeys: new Set() });
    }
    if (harness === 'codex' && row.type === 'event_msg' && row.payload?.type === 'token_count') {
      const usage = row.payload.info?.total_token_usage; if (!usage) continue;
      const item = [...sessionUses.values()].at(-1); if (!item) continue;
      item.rows.set('total', { input: Math.max(0, count(usage.input_tokens) - count(usage.cached_input_tokens)) /* Codex input already includes cached */, output: count(usage.output_tokens), cached: count(usage.cached_input_tokens), write: 0, model: null, at: row.timestamp ?? item.at });
    }
    if (harness === 'codex' && row.type === 'response_item' && row.payload?.type === 'function_call' && typeof row.payload.name === 'string') {
      const item = [...sessionUses.values()].at(-1);
      if (item) {
        const key = row.payload.call_id ?? row.payload.id ?? `${row.payload.name}:${item.toolKeys.size}`;
        if (!item.toolKeys.has(key)) { item.toolKeys.add(key); item.tools.set(row.payload.name, (item.tools.get(row.payload.name) ?? 0) + 1); }
      }
    }
  }
  const apply = db.transaction(() => {
    for (const [id, session] of sessionUses) {
      const usage = harness === 'codex' ? [...session.rows.values()].at(-1) : [...session.rows.values()].reduce<Usage | undefined>((max, value) => !max || value.input + value.output + value.cached + value.write >= max.input + max.output + max.cached + max.write ? value : max, undefined);
      if (usage) {
        const sessionId = `${harness}:${id}`;
        const total = harness === 'codex' ? usage : [...session.rows.values()].reduce((sum, value) => ({ input: sum.input + value.input, output: sum.output + value.output, cached: sum.cached + value.cached, write: sum.write + value.write, model: value.model ?? sum.model, at: value.at > sum.at ? value.at : sum.at }), { input: 0, output: 0, cached: 0, write: 0, model: session.model, at: session.at });
        record(db, id, harness, session.cwd, { ...total, model: session.model ?? usage.model }, harness === 'codex' ? 'harness_reported' : 'provider_reported');
        db.prepare('DELETE FROM session_tool_calls WHERE session_id = ?').run(sessionId);
        const insert = db.prepare('INSERT INTO session_tool_calls (session_id, tool, calls) VALUES (?, ?, ?)');
        for (const [tool, calls] of session.tools) insert.run(sessionId, tool, calls);
      }
    }
    db.prepare('INSERT INTO transcript_files (path, size_bytes, mtime_ms) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET size_bytes=excluded.size_bytes, mtime_ms=excluded.mtime_ms').run(path, info.size, info.mtimeMs);
  });
  apply();
}

export async function ingestTranscripts(db: Database.Database, options: { home?: string } = {}): Promise<void> {
  const home = options.home ?? homedir();
  const roots: Array<[string, 'claude-code' | 'codex']> = [[join(home, '.claude', 'projects'), 'claude-code'], [join(home, '.codex', 'sessions'), 'codex']];
  for (const [root, harness] of roots) for (const path of await files(root)) await ingestFile(db, path, harness);
}
