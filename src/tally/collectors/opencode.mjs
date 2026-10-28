// OpenCode: SQLite DB at ~/.local/share/opencode/opencode.db.
// Two generations of the same data (verified on the real DB):
//  * `message` (+ `part`): v1 rows, JSON {role:'assistant', tokens, providerID, modelID, parentID, path.cwd, ...}
//  * `session_message` type='assistant' (+ `session_v2`): v2 rows, SAME ids and SAME tokens for every overlapping row (41302 of 58156),
//    but ~16.8k newer rows exist ONLY here. v2 JSON: {time{created,streamed?,completed}, agent, model{id,providerID}, content[], tokens, cost}.
//  So: v2 is primary; v1 rows are used only when their id is absent from session_message.
// Other findings: tokens are PER REQUEST (not cumulative); tokens.output EXCLUDES reasoning (session_v2.tokens_output + tokens_reasoning
// match the per-row sums), so output = output + reasoning per contract; times are ms epoch.
// OpenCode forks ("(fork #N)" sessions) COPY the parent's messages under new ids with identical time.created + tokens -> deduped by
// fingerprint (keep the smallest id = the original), otherwise replayed history is counted again.
// durMs: message time.completed is AFTER tool execution (can be minutes), so generation time = time.streamed, else the latest tool-call
// `time.created` (call parsed ~0.4s before stream end), else completed. v1-only rows have no such info (completed - created).
// Cache: .cache/opencode.json holds every parsed Req; each run only re-reads rows with time_updated >= watermark (max seen - 1h).
import { DatabaseSync } from 'node:sqlite';
import { existsSync, copyFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { cacheFile } from './_cache.mjs';

const root = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
export const meta = { id: 'opencode', label: 'OpenCode', root, watch: [{ path: join(root, '..'), recursive: false, match: /^opencode\.db/ }] };
let MEM = null; // { cache, rows, out, lastPrune, lastWrite } survives between scans so the 27MB cache file is read once
// A request that "took" more than 10 minutes was not generating: the provider was queueing, or the
// gap includes tool execution. Such durations are dropped (null) instead of dragging the speed stats down.
const MAX_DUR = 10 * 60 * 1000;
const CACHE = cacheFile('opencode.json');
const CV = 3, MARGIN = 3600e3; // CV: bump when the parsed rows change shape, so stale durations are not reused

function openDb() {
  try {
    const db = new DatabaseSync(root, { readOnly: true });
    db.prepare('select 1 from message limit 1').get(); // WAL read can fail lazily, so probe
    return { db };
  } catch {}
  // fallback: snapshot db+wal+shm to a temp dir (can be huge, hence only on failure)
  const dir = mkdtempSync(join(tmpdir(), 'opencode-'));
  for (const s of ['', '-wal', '-shm']) if (existsSync(root + s)) copyFileSync(root + s, join(dir, 'opencode.db' + s));
  return { db: new DatabaseSync(join(dir, 'opencode.db'), { readOnly: true }), dir };
}

const q = (db, sql) => { try { return db.prepare(sql); } catch { return null; } }; // table may not exist on other OpenCode versions
const toks = (t = {}) => {
  const c = t.cache || {}, reasoning = t.reasoning || 0;
  return { input: t.input || 0, cacheRead: c.read || 0, cacheWrite: c.write || 0, output: (t.output || 0) + reasoning, reasoning };
};

export async function collect({ since = 0 } = {}) {
  if (!existsSync(root)) return [];
  let h;
  try {
    h = openDb();
    const { db } = h;
    if (!MEM) {
      let cache = { v: 0, wmS: 0, wmM: 0, rows: {} };
      try { const c = JSON.parse(readFileSync(CACHE, 'utf8')); if (c.v === CV) cache = c; } catch {}
      MEM = { cache, rows: new Map(Object.entries(cache.rows)), out: null, best: null, lastFull: 0, lastWrite: 0 }; // rows: id -> Req (+ _c = time.created, used only for fork dedupe)
      cache.rows = null;
    }
    const { cache, rows } = MEM;
    let dirty = false;
    // a re-read row only counts as a change if it differs: the 1h margin re-reads recent rows on every scan
    // fork dedupe: same created-ms + model + token tuple under different ids = replayed history; keep the smallest id (the original).
    // `best` is maintained incrementally for new rows; an edited or deleted row forces one full rebuild.
    const fk = (r) => [r._c, r.provider, r.model, r.input, r.output, r.cacheRead, r.cacheWrite, r.reasoning].join('|');
    const addBest = (r) => { const k = fk(r), b = MEM.best.get(k); if (!b || r.id < b.id) MEM.best.set(k, r); };
    let rebuild = !MEM.best;
    if (rebuild) MEM.best = new Map();
    // a re-read row only counts as a change if it differs: the 1h margin re-reads recent rows on every scan
    const put = (id, r) => {
      const o = rows.get(id);
      if (!o) { dirty = true; rows.set(id, r); if (!rebuild) addBest(r); return; }
      if (o.ts !== r.ts || o.output !== r.output || o.input !== r.input || o.cacheRead !== r.cacheRead || o.cacheWrite !== r.cacheWrite || o.durMs !== r.durMs) { dirty = true; rebuild = true; }
      rows.set(id, r);
    };

    // session meta: project + subagent flag (parent_id). session_v2 is a superset of session.
    const sess = new Map();
    for (const t of ['session', 'session_v2'])
      for (const r of q(db, `select id, directory, parent_id from ${t}`)?.all() ?? []) sess.set(r.id, r);
    const proj = (s, cwd) => { const d = cwd || sess.get(s)?.directory; return d ? basename(d) : ''; };
    const agentOf = (s, a) => (sess.get(s)?.parent_id ? 'subagent' : a || 'main');

    // drop rows deleted from the DB (id scans are index-only and cheap)
    // Most rescans only look at rows created in the last hour via the indexed time_created column. time_updated has no index (a full
    // table scan), so a complete time_updated sweep + prune of deleted rows runs only every 10 minutes.
    const full = Date.now() - MEM.lastFull > 10 * 60e3;
    if (full) {
      MEM.lastFull = Date.now();
      const live = new Set();
      for (const t of ['message', 'session_message']) for (const r of q(db, `select id from ${t}`)?.iterate() ?? []) live.add(r.id);
      for (const id of rows.keys()) if (!live.has(id.slice(9))) { rows.delete(id); dirty = true; rebuild = true; }
    }

    // v2 assistant rows
    const hasV2 = !!q(db, 'select 1 from session_message limit 1');
    if (hasV2) {
      // a turn = the nearest preceding user/synthetic message (verified: matches v1 parentID in ~100% of rows)
      let users = null; // built on first use: most rescans find no new rows
      const turnOf = (s, seq) => {
        if (!users) {
          users = new Map();
          for (const r of db.prepare(`select id, session_id s, seq from session_message where type in ('user','synthetic') order by session_id, seq`).iterate())
            (users.get(r.s) ?? users.set(r.s, []).get(r.s)).push(r);
        }
        const a = users.get(s); if (!a) return s;
        let lo = 0, hi = a.length - 1, best = null;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].seq < seq) { best = a[m]; lo = m + 1; } else hi = m - 1; }
        return best?.id ?? s;
      };
      let maxU = cache.wmS + MARGIN, maxC = (cache.wmC ?? 0) + MARGIN; // running maxes of rows seen: avoids full-table max() queries
      const it = db.prepare(`select id, session_id s, seq, time_created c, time_updated u, length(cast(data as blob)) n, data
        from session_message where type = 'assistant' and ${full ? 'time_updated' : 'time_created'} >= ?`).iterate(full ? cache.wmS : cache.wmC ?? 0);
      for (const r of it) {
        if (r.u > maxU) maxU = r.u;
        if (r.c > maxC) maxC = r.c;
        let d; try { d = JSON.parse(r.data); } catch { continue; }
        const t = toks(d.tokens);
        if (t.input + t.output + t.cacheRead + t.cacheWrite <= 0) continue;
        const created = d.time?.created ?? r.c, done = d.time?.completed;
        const tools = [], tc = [];
        for (const c of d.content || []) if (c.type === 'tool' && c.name) { if (!tools.includes(c.name)) tools.push(c.name); if (c.time?.created) tc.push(c.time.created); }
        const end = d.time?.streamed ?? (tc.length ? Math.max(...tc) : done);
        put('opencode:' + r.id, {
          id: 'opencode:' + r.id, tool: 'opencode', provider: d.model?.providerID || '', model: d.model?.id || '',
          session: r.s, project: proj(r.s), turn: rows.get('opencode:' + r.id)?.turn ?? turnOf(r.s, r.seq), ts: done ?? r.u ?? created, // a row's turn never changes: skip the user-message scan for margin re-reads
          durMs: end != null && created != null && end >= created && end - created <= MAX_DUR ? end - created : null,
          ...t, costUsd: d.cost > 0 ? d.cost : null, bytes: r.n, tools, agent: agentOf(r.s, d.agent), _c: created,
        });
      }
      cache.wmS = Math.max(cache.wmS, maxU - MARGIN); cache.wmC = Math.max(cache.wmC ?? 0, maxC - MARGIN);
    }

    // v1-only rows (ids not in session_message): old OpenCode versions / stragglers
    let maxM = cache.wmM + MARGIN;
    const v1 = db.prepare(`select id, session_id s, time_created c, time_updated u, length(cast(data as blob)) n, data from message m
      where time_updated >= ? and data like '%"role":"assistant"%'${hasV2 ? ' and not exists (select 1 from session_message x where x.id = m.id)' : ''}`);
    const pBytes = db.prepare('select sum(length(cast(data as blob))) b from part where message_id = ?');
    const pTools = db.prepare(`select substr(data,1,200) h from part where message_id = ? and data like '{"type":"tool","tool":"%'`);
    for (const r of (full || !hasV2 ? v1.iterate(cache.wmM) : [])) { // v1-only rows come from old OpenCode versions: a 10-minute sweep is plenty
      if (r.u > maxM) maxM = r.u;
      let d; try { d = JSON.parse(r.data); } catch { continue; }
      if (d.role !== 'assistant') continue;
      const t = toks(d.tokens);
      if (t.input + t.output + t.cacheRead + t.cacheWrite <= 0) continue;
      const created = d.time?.created ?? r.c, done = d.time?.completed;
      const tools = [];
      for (const p of pTools.iterate(r.id)) {
        const n = /^\{"type":"tool","tool":"((?:[^"\\]|\\.)*)"/.exec(p.h)?.[1];
        if (n && !tools.includes(n)) tools.push(n);
      }
      put('opencode:' + r.id, {
        id: 'opencode:' + r.id, tool: 'opencode', provider: d.providerID || '', model: d.modelID || '',
        session: r.s, project: proj(r.s, d.path?.cwd), turn: d.parentID || r.s, ts: done ?? r.u ?? created,
        durMs: done != null && created != null && done >= created && done - created <= MAX_DUR ? done - created : null, // shortcut: includes tool time, no stream end in v1
        ...t, costUsd: d.cost > 0 ? d.cost : null, bytes: r.n + (pBytes.get(r.id)?.b || 0), tools, agent: agentOf(r.s, d.agent), _c: created,
      });
    }
    cache.wmM = Math.max(cache.wmM, maxM - MARGIN);

    if ((dirty && Date.now() - MEM.lastWrite > 60e3) || cache.v !== CV) { // memory is authoritative; a crash only costs a re-read of the last minute
      MEM.lastWrite = Date.now(); cache.v = CV;
      try {
        mkdirSync(join(CACHE, '..'), { recursive: true });
        writeFileSync(CACHE, JSON.stringify({ v: CV, wmS: cache.wmS, wmC: cache.wmC, wmM: cache.wmM, rows: Object.fromEntries(rows) }));
      } catch {}
    }

    if (!dirty && MEM.out) return since > 0 ? MEM.out.filter((r) => r.ts >= since) : MEM.out;
    if (rebuild) { MEM.best.clear(); for (const r of rows.values()) addBest(r); }
    MEM.out = [...MEM.best.values()];
    return since > 0 ? MEM.out.filter((r) => r.ts >= since) : MEM.out;
  } catch {
    return [];
  } finally {
    try { h?.db.close(); } catch {}
    if (h?.dir) rmSync(h.dir, { recursive: true, force: true });
  }
}

if (import.meta.filename === process.argv[1]) {
  const t0 = Date.now(), rs = await collect({});
  console.log(rs.length, 'reqs in', Date.now() - t0, 'ms');
  console.log(rs.slice(0, 2));
  const by = {};
  for (const r of rs) {
    const k = r.provider + '/' + r.model, e = by[k] ||= { n: 0, tokens: 0, reasoning: 0, cost: 0 };
    e.n++; e.tokens += r.input + r.cacheRead + r.cacheWrite + r.output; e.reasoning += r.reasoning; e.cost += r.costUsd || 0;
  }
  console.table(by);
  console.log('with tools:', rs.filter((r) => r.tools.length).length, 'with dur:', rs.filter((r) => r.durMs != null).length, 'total tokens:', Object.values(by).reduce((a, e) => a + e.tokens, 0));
}
