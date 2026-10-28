// Claude Code session logs: ~/.claude/projects/**/*.jsonl (includes subagent files).
import { createReadStream } from 'node:fs';
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { cacheFile } from './_cache.mjs';
import { shellTag } from './_shell.mjs';

const root = join(homedir(), '.claude', 'projects');
export const meta = { id: 'claude-code', label: 'Claude Code', root, watch: [{ path: root, recursive: true, match: /\.jsonl$/ }] };

async function* walk(dir) {
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

// A turn starts only at a real human prompt. Non-human user lines seen in real logs: isMeta (skill bodies, peer/system
// notices, command caveats), isCompactSummary, and wrapper text (task notifications, slash-command echo/stdout, interrupt markers).
const WRAP = /^(<system-reminder>|<command-|<local-command|<task-notification|Caveat:|\[Request interrupted)/;
const isPrompt = (d) => {
  if (d.isMeta || d.isCompactSummary) return false;
  const c = d.message?.content;
  if (typeof c === 'string') return c.trim() !== '' && !WRAP.test(c.trimStart());
  return Array.isArray(c) && !c.some((b) => b.type === 'tool_result')
    && c.some((b) => b.type === 'text' && b.text?.trim() && !WRAP.test(b.text.trimStart()));
};

const CACHE = cacheFile('claude.json');
const VER = 'v5'; // bump when parseFile output changes so stale cache entries are not reused
const MAX_DUR = 10 * 60 * 1000; // longer "requests" are waiting on the user/tools, not generation
const TS = /"timestamp":"([^"]+)"/;
let MEM = null;

// One file -> { msgs: partial per-message records, turns: [[ts, id]] of main-thread human prompts }.
// Sidechain (subagent) records carry `side` = file start ts; collect() maps it to a main turn once all files are read.
async function parseFile(file) {
  const msgs = {}, turns = [];
  let turn = '', project = '', prevT = null, apiStart = null, firstT = null;
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const isA = line.includes('"type":"assistant"');
    const isU = !isA && line.includes('"type":"user"');
    const tm = TS.exec(line), t = tm ? Date.parse(tm[1]) : null;
    if (t && firstT == null) firstT = t;
    if (!isA && !isU) {
      if (t && line.includes('"type":"api-request"')) apiStart = t;
      continue;
    }
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.cwd && !project) project = basename(d.cwd);
    if (isU) {
      if (!d.isSidechain && isPrompt(d)) { turn = d.uuid; if (t) turns.push([t, turn]); }
      if (t) prevT = t;
      continue;
    }
    const m = d.message, u = m?.usage;
    // synthetic = client-generated errors; all-zero usage lines are replays of a message already logged with real usage
    if (!u || m.model === '<synthetic>' || !(u.input_tokens || u.output_tokens || u.cache_read_input_tokens || u.cache_creation_input_tokens)) {
      if (t) prevT = t; continue;
    }
    let r = msgs[m.id];
    if (!r) {
      r = msgs[m.id] = {
        id: 'claude-code:' + m.id, tool: 'claude-code', provider: 'anthropic', model: m.model,
        session: d.sessionId || basename(file, '.jsonl'), project,
        turn: d.isSidechain ? '' : (turn || d.sessionId), side: d.isSidechain ? firstT : null,
        ts: t, durMs: null, input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0,
        costUsd: null, bytes: 0, tools: [], agent: d.isSidechain ? 'subagent' : 'main',
        // apiBlockIndex 0 is the first response block; api-request marks send time, including time-to-first-token.
        start: apiStart != null && apiStart <= t ? apiStart : (prevT != null && prevT <= t ? prevT : null), seen: [],
      };
      apiStart = null;
    }
    // every content-block line repeats the final usage (replays may carry zeros), so max-merge is safe
    r.input = Math.max(r.input, u.input_tokens || 0);
    r.cacheRead = Math.max(r.cacheRead, u.cache_read_input_tokens || 0);
    r.cacheWrite = Math.max(r.cacheWrite, u.cache_creation_input_tokens || 0);
    r.cacheWrite1h = Math.max(r.cacheWrite1h, u.cache_creation?.ephemeral_1h_input_tokens || 0);
    r.output = Math.max(r.output, u.output_tokens || 0);
    r.reasoning = Math.max(r.reasoning, u.output_tokens_details?.thinking_tokens || 0);
    r.ts = Math.max(r.ts, t);
    if (!r.seen.includes(d.uuid)) { r.seen.push(d.uuid); r.bytes += line.length; }
    for (const b of m.content || []) if (b.type === 'tool_use') for (const n of [b.name, b.name === 'Bash' && shellTag(b.input?.command)]) if (n && !r.tools.includes(n)) r.tools.push(n);
    if (t) prevT = t;
  }
  return { msgs, turns };
}

export async function collect({ since = 0 } = {}) {
  let cache = MEM;
  if (!cache) { cache = {}; try { cache = JSON.parse(await readFile(CACHE, 'utf8')); } catch {} }
  let changed = false;
  const next = {}, byMsg = new Map(); // dedupe globally by message id (no cross-file duplicates in practice, but resumes can copy history)
  const sessTurns = new Map(); // session -> [[ts, turnId]] across all its files (main + subagents share sessionId)
  for await (const file of walk(root)) {
    const st = await stat(file), key = VER + ':' + st.mtimeMs + ':' + st.size;
    let ent = cache[file];
    if (ent?.key !== key) { ent = { key, ...(await parseFile(file)) }; changed = true; }
    next[file] = ent;
    for (const [id, r] of Object.entries(ent.msgs)) {
      const o = byMsg.get(id);
      if (!o || r.output > o.output) byMsg.set(id, r);
    }
    if (ent.turns.length) {
      const sid = basename(file, '.jsonl');
      sessTurns.set(sid, (sessTurns.get(sid) || []).concat(ent.turns));
    }
  }
  for (const l of sessTurns.values()) l.sort((a, b) => a[0] - b[0]);
  MEM = next; // kept in memory: an unchanged log never gets re-read or re-written
  if (changed || Object.keys(next).length !== Object.keys(cache).length) {
    try { await mkdir(dirname(CACHE), { recursive: true }); await writeFile(CACHE, JSON.stringify(next)); } catch {} // a read-only cache only costs a re-read next start
  }
  const out = [];
  for (const r of byMsg.values()) {
    if (r.ts < since) continue;
    const { start, seen, side, ...q } = r;
    if (r.agent === 'subagent') { // attribute to the main turn active when the subagent was spawned
      const l = sessTurns.get(r.session) || [];
      let i = l.length; while (i && l[i - 1][0] > side) i--;
      q.turn = i ? l[i - 1][1] : r.session;
    }
    const dur = start != null && r.ts >= start ? r.ts - start : null;
    q.durMs = dur != null && dur <= MAX_DUR ? dur : null;
    out.push(q);
  }
  return out;
}

if (import.meta.filename === process.argv[1]) {
  const t0 = Date.now(), rs = await collect({});
  console.log(rs.length, 'reqs in', Date.now() - t0, 'ms');
  console.log(rs.slice(0, 2));
  const by = {};
  for (const r of rs) by[r.model] = (by[r.model] || 0) + r.input + r.cacheRead + r.cacheWrite + r.output;
  console.log(by);
}
