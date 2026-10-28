// Antigravity per-conversation SQLite stores (gen_metadata = one protobuf row per LLM call, with real token counts).
// Roots: native IDE ~/.gemini/antigravity/conversations and T3 Code's ACP wrapper
// ~/.t3/userdata/providers/antigravity/<hash>/antigravity-acp/conversations.
import { readdirSync, existsSync, copyFileSync, mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { homedir, tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const home = homedir();
const nativeRoot = join(home, '.gemini', 'antigravity', 'conversations');
const t3Providers = join(home, '.t3', 'userdata', 'providers', 'antigravity');
export const meta = {
  id: 'antigravity', label: 'Antigravity', root: nativeRoot,
  watch: [{ path: nativeRoot, recursive: false, match: /\.db(-wal)?$/ }, { path: t3Providers, recursive: true, match: /\.db(-wal)?$/ }],
};

// Minimal protobuf reader: Map(field -> [varint Number | Buffer]). Fixed32/64 are skipped over.
function pb(b) {
  const m = new Map();
  let i = 0;
  const varint = () => { let r = 0, mul = 1, c; do { c = b[i++]; r += (c & 127) * mul; mul *= 128; } while (c & 128); return r; };
  try {
    while (i < b.length) {
      const t = varint(), f = Math.floor(t / 8), w = t & 7;
      let v;
      if (w === 0) v = varint();
      else if (w === 2) { const l = varint(); if (i + l > b.length) break; v = b.subarray(i, i + l); i += l; }
      else if (w === 1) { i += 8; continue; } else if (w === 5) { i += 4; continue; } else break;
      (m.get(f) ?? m.set(f, []).get(f)).push(v);
    }
  } catch {}
  return m;
}
const one = (m, f) => m?.get(f)?.[0];
const sub = (m, f) => { const v = one(m, f); return Buffer.isBuffer(v) ? pb(v) : null; };
const num = (m, f) => { const v = one(m, f); return typeof v === 'number' ? v : 0; };
const str = (m, f) => { const v = one(m, f); return Buffer.isBuffer(v) ? v.toString('utf8') : ''; };
const tsMs = (m) => (m ? num(m, 1) * 1000 + Math.round(num(m, 2) / 1e6) : null); // google.protobuf.Timestamp/Duration

function* dbs() {
  const dirs = [nativeRoot];
  try { for (const h of readdirSync(t3Providers)) dirs.push(join(t3Providers, h, 'antigravity-acp', 'conversations')); } catch {}
  for (const d of dirs) {
    let fs; try { fs = readdirSync(d); } catch { continue; }
    for (const f of fs) if (f.endsWith('.db')) yield [d, f];
  }
}

function project(dir, id) {
  try { return basename(JSON.parse(readFileSync(join(dir, id + '.meta'), 'utf8')).cwd || ''); } catch {}
  return '';
}

function readDb(dir, file, since) {
  const src = join(dir, file), session = file.slice(0, -3), out = [];
  try { if (statSync(src).mtimeMs < since) return out; } catch { return out; }
  const tmp = mkdtempSync(join(tmpdir(), 'ag-')); // copy db+wal+shm: live stores are locked / WAL not checkpointed
  let db;
  try {
    for (const s of ['', '-wal', '-shm']) if (existsSync(src + s)) copyFileSync(src + s, join(tmp, 'c.db' + s));
    db = new DatabaseSync(join(tmp, 'c.db'), { readOnly: true });
    const steps = new Map(); // idx -> [type, ts]
    for (const r of db.prepare('select idx, step_type, metadata from steps').all())
      steps.set(r.idx, [r.step_type, r.metadata ? tsMs(sub(pb(Buffer.from(r.metadata)), 1)) : null]);
    const users = [...steps].filter(([, [t]]) => t === 14).map(([i]) => i).sort((a, b) => a - b);
    const proj = project(dir, session);
    for (const r of db.prepare('select idx, data, size from gen_metadata order by idx').all()) {
      try {
        const data = Buffer.from(r.data), m = sub(pb(data), 1);
        const u = sub(m, 4);
        if (!u) continue; // no usage = in-flight / failed call
        const kv = {};
        for (const e of m.get(20) || []) { const p = pb(e); kv[str(p, 1)] = str(p, 2); }
        const last = parseInt(kv.last_step_index, 10);
        const g9 = sub(m, 9);
        const ts = tsMs(sub(g9, 4)) ?? steps.get(last)?.[1] ?? statSync(src).mtimeMs;
        const turnIdx = users.filter((i) => i <= last).pop();
        const input = num(u, 2), output = num(u, 3), cacheRead = num(u, 5), cacheWrite = num(u, 4);
        if (ts < since || input + output + cacheRead + cacheWrite === 0) continue;
        out.push({
          id: `antigravity:${session}:${r.idx}`, tool: 'antigravity', provider: 'google',
          model: str(m, 21) || str(m, 19) || '', session, project: proj,
          turn: turnIdx === undefined ? session : `${session}:${turnIdx}`,
          // Field 9.8 tracks the gap between calls, which can include tool time, not request wall time.
          ts, durMs: null,
          input, cacheRead, cacheWrite, output, reasoning: num(u, 9), // 3 = 9 (thinking) + 10 (response)
          costUsd: null, bytes: r.size || data.length, tools: [], agent: 'main',
        });
      } catch { /* skip a malformed gen_metadata row */ }
    }
  } catch { /* locked/corrupt/odd schema: skip this conversation */ }
  finally { try { db?.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); }
  return out;
}

// Each conversation DB is copied to a temp dir to read it, so only do that when the db/wal/shm actually changed.
const MEMO = new Map(); // db path -> { key, rows }
function readCached(d, f) {
  const src = join(d, f);
  const key = ['', '-wal', '-shm'].map((s) => { try { const st = statSync(src + s); return st.mtimeMs + ':' + st.size; } catch { return '-'; } }).join('|');
  const m = MEMO.get(src);
  if (m?.key === key) return m.rows;
  const rows = readDb(d, f, 0);
  MEMO.set(src, { key, rows });
  return rows;
}

export async function collect({ since = 0 } = {}) {
  const out = [];
  for (const [d, f] of dbs()) for (const r of readCached(d, f)) if (r.ts >= since) out.push(r);
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
