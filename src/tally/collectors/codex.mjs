// OpenAI Codex CLI logs: ~/.codex/sessions/**/*.jsonl + ~/.codex/archived_sessions (*.jsonl or *.jsonl.zst).
import { createReadStream } from 'node:fs';
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { cacheFile } from './_cache.mjs';
import { shellTag } from './_shell.mjs';

const root = join(homedir(), '.codex', 'sessions');
const archived = join(homedir(), '.codex', 'archived_sessions');
export const meta = { id: 'codex', label: 'OpenAI Codex', root, watch: [root, archived].map((path) => ({ path, recursive: true, match: /\.jsonl(\.zst)?$/ })) };
let MEM = null;

async function* walk(dir) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.jsonl(\.zst)?$/.test(e.name)) yield p;
  }
}

const lines = (file) => {
  const s = createReadStream(file);
  return createInterface({ input: file.endsWith('.zst') ? s.pipe(createZstdDecompress()) : s.setEncoding('utf8'), crlfDelay: Infinity });
};

const CACHE = cacheFile('codex.json');
const CACHE_VERSION = 4;
const MAX_DUR_MS = 10 * 60 * 1000;
// "timestamp", optional ordinal, top-level type, payload.type (absent for session_meta) -- lets us skip JSON.parse on the bulky lines.
const HEAD = /^\{"timestamp":"([^"]+)"(?:,"ordinal":\d+)?,"type":"([a-z_]+)","payload":\{(?:"type":"([A-Za-z_]+)")?/;

// Findings (verified on real logs):
//  * output_tokens ALREADY INCLUDES reasoning_output_tokens (total_tokens == input_tokens + output_tokens even when reasoning > 0),
//    so output = output_tokens and reasoning = reasoning_output_tokens (a subset), no addition.
//  * Newer logs have a top-level `token_usage_record` per model call with a unique response_id and per-call `usage`; it is
//    complete, whereas `event_msg/token_count` repeats and misses some calls (one 25MB file: 575 records vs 566 distinct counts).
//    So: use token_usage_record when a file has any; fall back to deduped token_count (older logs, archived_sessions) otherwise.
//  * Forked sessions replay the parent's history into the new file: dedupe globally (response_id, else turn_id+cumulative total), keep earliest ts.
// durMs heuristic: ts of the record minus the latest input-side marker before that response's first output line. Clear it
// after emission so a later response without a fresh marker cannot inherit an earlier request's start time.
async function parseFile(file) {
  let session = basename(file).replace(/\.jsonl(\.zst)?$/, ''), turn = '', model = 'unknown', cwd = ''; // some older logs have no turn_context at all
  let trig = null, armed = false, callStart = null, prevTotal = '';
  const A = { tur: { bytes: 0, tools: new Set() }, tc: { bytes: 0, tools: new Set() } };
  const out = { tur: [], tc: [] };
  const emit = (kind, ts, u, key, t) => {
    const a = A[kind];
    const duration = callStart != null && ts > callStart ? ts - callStart : null;
    out[kind].push({
      k: key, id: 'codex:' + key, tool: 'codex', provider: 'openai', model, session, project: cwd ? basename(cwd) : '',
      turn: t || turn || session, ts, durMs: duration != null && duration <= MAX_DUR_MS ? duration : null,
      input: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0) - (u.cache_write_input_tokens || 0)), cacheRead: u.cached_input_tokens || 0,
      cacheWrite: u.cache_write_input_tokens || 0, output: u.output_tokens || 0, reasoning: u.reasoning_output_tokens || 0,
      costUsd: null, bytes: a.bytes, tools: [...a.tools], agent: 'main',
    });
    a.bytes = 0; a.tools = new Set();
    callStart = null;
  };
  try {
    for await (const line of lines(file)) {
      A.tur.bytes += line.length; A.tc.bytes += line.length;
      const h = HEAD.exec(line);
      if (!h) continue;
      const t = Date.parse(h[1]), top = h[2], sub = h[3];
      if (top === 'response_item') {
        if (sub.endsWith('_output')) { trig = t; armed = true; continue; }
        let isModelOut = true;
        if (sub === 'message') {
          let d; try { d = JSON.parse(line); } catch { continue; }
          if (d.payload.role !== 'assistant') { trig = t; armed = true; isModelOut = false; }
        } else if (sub.endsWith('_call')) {
          let d; try { d = JSON.parse(line); } catch { continue; }
          const n = d.payload.name;
          for (const x of [n, shellTag(d.payload.arguments)]) if (x) { A.tur.tools.add(x); A.tc.tools.add(x); }
        }
        if (isModelOut && armed) { callStart = trig; armed = false; }
        continue;
      }
      if (top === 'session_meta' || top === 'turn_context' || sub === 'task_started') {
        let d; try { d = JSON.parse(line); } catch { continue; }
        const p = d.payload;
        if (top === 'session_meta') { session = p.id || session; cwd = p.cwd || cwd; }
        else if (top === 'turn_context') { turn = p.turn_id || turn; model = p.model || model; cwd = p.cwd || cwd; }
        else { turn = p.turn_id || turn; trig = t; armed = true; }
      } else if (sub === 'item_completed') {
        if (line.includes('"type":"UserMessage"')) { trig = t; armed = true; }
      } else if (top === 'token_usage_record') {
        let d; try { d = JSON.parse(line); } catch { continue; }
        const p = d.payload;
        if (p?.usage) emit('tur', t, p.usage, p.response_id || (p.turn_id + ':' + p.usage.total_tokens + ':' + t), p.turn_id);
      } else if (sub === 'token_count') {
        let d; try { d = JSON.parse(line); } catch { continue; }
        const i = d.payload.info;
        if (!i?.last_token_usage) continue;
        const tot = JSON.stringify(i.total_token_usage);
        if (tot === prevTotal) continue; // Codex repeats token_count events
        prevTotal = tot;
        emit('tc', t, i.last_token_usage, turn + ':' + i.total_token_usage?.total_tokens + ':' + tot.length, turn);
      }
    }
  } catch { /* unreadable / truncated file: keep what we parsed */ }
  return out.tur.length ? out.tur : out.tc;
}

export async function collect({ since = 0 } = {}) {
  let cache = MEM;
  if (!cache) { cache = {}; try { cache = JSON.parse(await readFile(CACHE, 'utf8')); } catch {} }
  let changed = false;
  const next = {}, byKey = new Map();
  for (const dir of [root, archived]) {
    for await (const file of walk(dir)) {
      let st; try { st = await stat(file); } catch { continue; }
      const key = CACHE_VERSION + ':' + st.mtimeMs + ':' + st.size;
      let ent = cache[file];
      if (ent?.key !== key) { ent = { key, reqs: await parseFile(file) }; changed = true; }
      next[file] = ent;
      for (const r of ent.reqs) {
        const o = byKey.get(r.k);
        if (!o || r.ts < o.ts) byKey.set(r.k, r);
      }
    }
  }
  MEM = next; // kept in memory: an unchanged log never gets re-read or re-written
  if (changed || Object.keys(next).length !== Object.keys(cache).length) {
    try { await mkdir(dirname(CACHE), { recursive: true }); await writeFile(CACHE, JSON.stringify(next)); } catch {}
  }
  const out = [];
  for (const { k, ...r } of byKey.values()) if (r.ts >= since) out.push(r);
  return out;
}

// Latest rate-limit snapshot seen in the newest few session files (null if none).
export async function rateLimits() {
  const files = [];
  for await (const f of walk(root)) { try { files.push({ f, m: (await stat(f)).mtimeMs }); } catch {} }
  files.sort((a, b) => b.m - a.m);
  let best = null;
  for (const { f } of files.slice(0, 4)) {
    try {
      for await (const line of lines(f)) {
        if (!line.includes('"rate_limits":{')) continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        const rl = d.payload?.rate_limits, p = rl?.primary, t = Date.parse(d.timestamp);
        if (p && (!best || t >= best.seenAt)) {
          best = { planType: rl.plan_type ?? null, usedPercent: p.used_percent, windowMinutes: p.window_minutes, resetsAt: p.resets_at * 1000, seenAt: t };
        }
      }
    } catch {}
    if (best) break; // newest file with data wins
  }
  return best;
}

if (import.meta.filename === process.argv[1]) {
  const t0 = Date.now(), rs = await collect({});
  console.log(rs.length, 'reqs in', Date.now() - t0, 'ms');
  console.log(rs.slice(0, 2));
  const by = {};
  for (const r of rs) by[r.model] = (by[r.model] || 0) + r.input + r.cacheRead + r.cacheWrite + r.output;
  console.log(by);
  console.log(await rateLimits());
}
