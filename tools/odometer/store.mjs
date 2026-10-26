// Shared by server.mjs and stats.mjs: scans every collectors/*.mjs, refreshes each on its own clock, serves windows.
// Data is held as typed columns plus one shared string table (not one object per request): ~10x less memory than row objects.
import { readdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const here = import.meta.dirname;
const STR = ['tool', 'provider', 'model', 'session', 'project', 'turn', 'agent'];
const NUM = ['ts', 'durMs', 'input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'costUsd'];
export const COLS = [...STR, ...NUM, 'est', 'noCache', 'tools'];
const SPAN = { '1d': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 };
// A source is rescanned only when the OS reports a change in its log files (collector meta.watch), and not more often than
// MIN_GAP. An idle machine therefore does no work at all. SAFETY rescans anyway so a missed fs event can't leave data stale;
// sources whose paths can't be watched fall back to POLL.
const MIN_GAP = { 'claude-code': 5_000, default: 15_000, opencode: 30_000 };
const SAFETY = 10 * 60_000, POLL = 60_000;

export function createStore() {
  const src = new Map(); // id -> { mod, cols, n, ms, at, error, p, dirty, ... }
  let pricing = null, dirty = true, version = 0;
  const limits = {}, gz = new Map();
  const dict = [], didx = new Map(); // one string table for every string column
  const id = (s) => { s = String(s ?? ''); let x = didx.get(s); if (x === undefined) { x = dict.length; dict.push(s); didx.set(s, x); } return x; };

  const ready = (async () => {
    try { pricing = await import('./pricing.mjs'); } catch {}
    for (const f of (await readdir(join(here, 'collectors'))).filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))) {
      try {
        const mod = await import('./collectors/' + f);
        if (!mod.collect) continue;
        // two collectors claiming the same id would silently overwrite each other: keep the first, report the clash
        if (src.has(mod.meta.id)) { src.get(mod.meta.id).dup = (src.get(mod.meta.id).dup || '') + ` ${f}`; continue; }
        src.set(mod.meta.id, { mod, cols: null, n: 0, at: 0 });
      } catch (e) { src.set(f, { cols: null, n: 0, at: 0, error: 'import failed: ' + e.message }); }
    }
  })();

  /** Requests -> typed columns (+ price/cost). */
  function encode(rs) {
    const n = rs.length, S = STR.map(() => new Int32Array(n)), N = NUM.map(() => new Float64Array(n));
    const est = new Uint8Array(n), nc = new Float64Array(n), tl = new Int32Array(n);
    let lo = Infinity, hi = 0;
    for (let i = 0; i < n; i++) {
      const r = rs[i];
      let cost = r.costUsd, e = 0;
      if (!(cost > 0) && pricing?.cost) { try { cost = pricing.cost(r); e = 1; } catch { cost = null; } }
      let noCache = NaN; // the same call with zero caching
      try { const p = pricing?.price(r.model, r.provider); if (p) noCache = (r.input + r.cacheRead + r.cacheWrite) * p.in + r.output * p.out; } catch {}
      for (let j = 0; j < STR.length; j++) S[j][i] = id(r[STR[j]]);
      for (let j = 0; j < NUM.length; j++) { const v = NUM[j] === 'costUsd' ? cost : r[NUM[j]]; N[j][i] = v == null ? NaN : v; }
      est[i] = e; nc[i] = noCache; tl[i] = id((r.tools || []).join(','));
      if (r.ts < lo) lo = r.ts; if (r.ts > hi) hi = r.ts;
    }
    // sort this source by ts once, so a request can binary-search its window and k-way merge sources without a global sort
    const perm = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => N[0][a] - N[0][b]);
    const by = (a) => { const o = new a.constructor(n); for (let i = 0; i < n; i++) o[i] = a[perm[i]]; return o; };
    return { n, S: S.map(by), N: N.map(by), est: by(est), nc: by(nc), tl: by(tl), lo: n ? lo : null, hi: n ? hi : null };
  }

  function arm(s) {
    if (s.armed) return;
    s.armed = true;
    for (const w of s.mod.meta.watch || []) {
      try {
        const h = watch(w.path, { recursive: w.recursive, persistent: false }, (_e, name) => { if (!w.match || !name || w.match.test(String(name))) s.dirty = true; });
        h.on('error', () => { s.noWatch = true; });
      } catch { s.noWatch = true; }
    }
    if (!s.mod.meta.watch?.length) s.noWatch = true;
  }
  const due = (s, sid, now) => !s.at || (s.noWatch ? now - s.at > POLL : s.dirty ? now - s.at > (MIN_GAP[sid] ?? MIN_GAP.default) : now - s.at > SAFETY);

  function refresh(s) {
    if (!s.mod) return Promise.resolve();
    return (s.p ??= (async () => {
      const t0 = Date.now();
      arm(s); s.dirty = false; // clear before reading so a write during the scan re-flags it
      try {
        const rs = await s.mod.collect({ since: 0 });
        s.cols = encode(rs); s.n = rs.length; s.error = null;
        if (s.mod.rateLimits) limits[s.mod.meta.id] = await s.mod.rateLimits().catch(() => null);
        dirty = true;
      } catch (e) { s.error = e.message; }
      s.ms = Date.now() - t0; s.at = Date.now(); s.p = null;
    })());
  }

  /** Make data current: first call (and force) waits for every source; `live` also waits for Claude Code; the rest refresh in the background. */
  async function touch({ force = false, live = false } = {}) {
    await ready;
    const jobs = [], now = Date.now();
    for (const [sid, s] of src) {
      if (!s.mod || !(force || due(s, sid, now))) continue;
      const first = !s.at, p = refresh(s);
      if (first || force || (live && sid === 'claude-code')) jobs.push(p);
    }
    await Promise.all(jobs);
    if (dirty) { dirty = false; version++; gz.clear(); }
  }

  function payload(range) {
    const key = `${range}:${version}:${Math.floor(Date.now() / 6e4)}`; // windows slide, so rebuild at most once a minute
    let g = gz.get(key);
    if (g) return g;
    if (gz.size > 12) gz.clear();
    const now = Date.now(), lo = SPAN[range] ? now - SPAN[range] : 0;
    const parts = [...src.values()].map((x) => x.cols).filter((c) => c?.n).map((c) => {
      let i = 0, j = c.n; // first row with ts >= lo
      while (i < j) { const h = (i + j) >> 1; c.N[0][h] < lo ? (i = h + 1) : (j = h); }
      return { c, i };
    });
    const local = new Int32Array(dict.length).fill(-1), ldict = [], rows = [];
    const L = (x) => { let y = local[x]; if (y < 0) { y = ldict.length; ldict.push(dict[x]); local[x] = y; } return y; };
    const nn = (v) => (v !== v ? null : v);
    let total = 0;
    for (const x of src.values()) total += x.n;
    for (;;) { // k-way merge by ts (k = number of sources, so tiny)
      let best = null;
      for (const p of parts) if (p.i < p.c.n && (!best || p.c.N[0][p.i] < best.c.N[0][best.i])) best = p;
      if (!best) break;
      const { c, i: k } = best, r = [];
      for (let q = 0; q < STR.length; q++) r.push(L(c.S[q][k]));
      for (let q = 0; q < NUM.length; q++) r.push(nn(c.N[q][k]));
      r.push(c.est[k], nn(c.nc[k]), dict[c.tl[k]]);
      rows.push(r); best.i++;
    }
    const status = Object.fromEntries([...src].map(([sid, s]) => [sid, { ok: !s.error, error: s.error, dup: s.dup, n: s.n, ms: s.ms, at: s.at, first: s.cols?.lo, last: s.cols?.hi }]));
    g = gzipSync(JSON.stringify({ cols: COLS, dict: ldict, rows, status, limits, now, total }), { level: 4 });
    gz.set(key, g);
    return g;
  }

  return { touch, payload, get size() { let n = 0; for (const x of src.values()) n += x.n; return n; }, cols: COLS };
}
