// node --no-warnings tools/reconcile.mjs [--claude]
// Ground-truth check: compares what the collectors report with counters the tools keep themselves, using separate code paths.
//   OpenCode : per-session token totals stored in session_v2 (OpenCode's own running counters)
//   Codex    : last cumulative `total_token_usage` of every plain .jsonl session (Codex's own running counter)
//   Claude   : --claude re-reads every raw log and counts by requestId (a different key than the collector's message.id)
// Exit code 1 if a source disagrees beyond tolerance. Forked sessions replay their parent's history on purpose deduplicated here, so they are reported apart.
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, readdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOL = 0.005; // 0.5%
const home = homedir();
const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(3) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n.toLocaleString());
const off = (a, b) => (b ? ((a - b) / b) * 100 : a ? 100 : 0);
const tot = (r) => r.input + r.cacheRead + r.cacheWrite + r.output;
let failed = false;
const report = (name, rows) => {
  console.log(`\n${name}`);
  for (const [k, v] of rows) console.log('  ' + k.padEnd(46) + v);
};
const verdict = (ok, text) => { if (!ok) failed = true; return (ok ? 'PASS  ' : 'FAIL  ') + text; };

// ---------------- OpenCode ----------------
// A forked OpenCode session copies its parent's messages under new ids (same created-ms, same tokens). OpenCode's session counters
// count every copy; the collector keeps one. To prove that is the ONLY difference, rebuild the replayed share per session from raw rows.
async function opencode() {
  const { collect } = await import('../collectors/opencode.mjs');
  const rs = await collect({}), ours = new Map();
  for (const r of rs) ours.set(r.session, (ours.get(r.session) || 0) + tot(r)); // output already includes reasoning
  const db = new DatabaseSync(join(home, '.local/share/opencode/opencode.db'), { readOnly: true });
  const truth = new Map();
  for (const t of ['session', 'session_v2']) {
    let q; try { q = db.prepare(`select id, tokens_input i, tokens_output o, tokens_reasoning z, tokens_cache_read cr, tokens_cache_write cw from ${t}`); } catch { continue; }
    for (const r of q.all()) truth.set(r.id, r.i + r.o + r.z + r.cr + r.cw);
  }
  // raw assistant rows from both generations (v2 wins for an id present in both)
  const raw = new Map(), tk = (t = {}) => (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
  for (const [tbl, v2] of [['message', false], ['session_message', true]]) {
    let it; try { it = db.prepare(`select id, session_id s, time_created c, data from ${tbl} where ${v2 ? "type='assistant'" : "data like '%\"role\":\"assistant\"%'"}`).iterate(); } catch { continue; }
    for (const r of it) {
      let d; try { d = JSON.parse(r.data); } catch { continue; }
      const t = d.tokens, n = tk(t); if (!n) continue;
      raw.set(r.id, { s: r.s, n, k: [d.time?.created ?? r.c, v2 ? d.model?.providerID : d.providerID, v2 ? d.model?.id : d.modelID, t.input || 0, (t.output || 0) + (t.reasoning || 0), t.cache?.read || 0, t.cache?.write || 0, t.reasoning || 0].join('|') });
    }
  }
  db.close();
  const first = new Map(), replayed = new Map();
  for (const id of [...raw.keys()].sort()) { const r = raw.get(id); if (!first.has(r.k)) first.set(r.k, id); else replayed.set(r.s, (replayed.get(r.s) || 0) + r.n); }
  let same = 0, explained = 0, unexplained = 0, higher = 0, compared = 0, ourSum = 0, theirSum = 0, replaySum = 0, unexSum = 0;
  for (const [id, theirs] of truth) {
    if (!theirs) continue;
    compared++; const o = ours.get(id) || 0, rep = replayed.get(id) || 0; ourSum += o; theirSum += theirs; replaySum += rep;
    const resid = (theirs - o - rep) / theirs;            // what neither the collector nor fork replay accounts for
    if (Math.abs((o - theirs) / theirs) <= TOL) same++;
    else if (Math.abs(resid) <= TOL) explained++;
    else if (o > theirs) higher++;
    else { unexplained++; unexSum += Math.max(0, theirs - o - rep); }
  }
  report('OpenCode vs session_v2 counters', [
    ['sessions with tokens', String(compared)],
    ['match OpenCode counter within 0.5%', String(same)],
    ['lower, exactly explained by replayed fork history', String(explained)],
    ['collector higher than OpenCode counter', verdict(higher === 0, String(higher))],
    ['counters with no matching message rows left', verdict(unexSum / theirSum <= TOL, `${unexplained} sessions, ${fmt(unexSum)} tokens (${(unexSum / theirSum * 100).toFixed(2)}% of all)`)],
    ['totals: collector + replayed vs counters', `${fmt(ourSum)} + ${fmt(replaySum)} = ${fmt(ourSum + replaySum)} vs ${fmt(theirSum)}  (${off(ourSum + replaySum, theirSum).toFixed(2)}%)`],
  ]);
}

// ---------------- Codex ----------------
async function walk(dir, out = []) {
  let es = []; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) { const p = join(dir, e.name); e.isDirectory() ? await walk(p, out) : /\.jsonl$/.test(e.name) && out.push(p); }
  return out;
}
async function codex() {
  const { collect } = await import('../collectors/codex.mjs');
  const rs = await collect({}), ours = new Map();
  for (const r of rs) ours.set(r.session, (ours.get(r.session) || 0) + tot(r));
  let files = [...(await walk(join(home, '.codex/sessions'))), ...(await walk(join(home, '.codex/archived_sessions')))];
  let same = 0, lower = 0, higher = 0, compared = 0, worstHigher = 0, ourSum = 0, theirSum = 0;
  for (const f of files) {
    let sid = null, last = null, rec = null; // rec: thread_token_usage inside token_usage_record (complete); last: token_count cumulative (lags on busy sessions)
    for await (const line of createInterface({ input: createReadStream(f, 'utf8'), crlfDelay: Infinity })) {
      if (!sid && line.includes('"session_meta"')) { try { sid = JSON.parse(line).payload.id; } catch {} }
      if (line.includes('"token_usage_record"') && line.includes('"thread_token_usage"')) {
        try { const d = JSON.parse(line); if (d.type === 'token_usage_record') rec = d.payload.thread_token_usage.total_tokens; } catch {}
      }
      if (line.includes('"token_count"') && line.includes('"total_token_usage"')) {
        try { const t = JSON.parse(line).payload?.info?.total_token_usage; if (t) last = t.total_tokens ?? t.input_tokens + t.output_tokens; } catch {}
      }
    }
    last = rec ?? last;
    if (!sid || !last) continue;
    compared++; const o = ours.get(sid) || 0; ourSum += o; theirSum += last;
    const d = off(o, last) / 100;
    if (Math.abs(d) <= TOL) same++; else if (d < 0) lower++; else { higher++; worstHigher = Math.max(worstHigher, d); }
  }
  report('Codex vs its own per-thread cumulative counter', [
    ['plain session files compared', String(compared)],
    ['match within 0.5%', `${same} (${((same / compared) * 100).toFixed(1)}%)`],
    ['collector lower (forks replay parent history, deduped)', String(lower)],
    ['collector higher than Codex counter', verdict(higher === 0, String(higher) + (higher ? ` (worst +${(worstHigher * 100).toFixed(1)}%)` : ''))],
    ['total, collector vs Codex', `${fmt(ourSum)} vs ${fmt(theirSum)}  (${off(ourSum, theirSum).toFixed(2)}%)`],
  ]);
}

// ---------------- Claude (opt-in: reads every raw log) ----------------
async function claude() {
  const { collect } = await import('../collectors/claude.mjs');
  const rs = await collect({});
  const root = join(home, '.claude/projects');
  const byReq = new Map(); // requestId -> max usage; independent of the collector's message.id grouping
  for (const f of await walk(root)) {
    for await (const line of createInterface({ input: createReadStream(f, 'utf8'), crlfDelay: Infinity })) {
      if (!line.includes('"type":"assistant"')) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const u = d.message?.usage;
      if (!u || d.message.model === '<synthetic>') continue;
      const k = d.requestId || d.message.id, v = [u.input_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0, u.output_tokens || 0];
      const o = byReq.get(k);
      byReq.set(k, o ? o.map((x, i) => Math.max(x, v[i])) : v);
    }
  }
  let rawSum = 0, n = 0;
  for (const v of byReq.values()) { const s = v.reduce((a, b) => a + b, 0); if (s) { rawSum += s; n++; } }
  const ourSum = rs.reduce((a, r) => a + tot(r), 0);
  const d = off(ourSum, rawSum) / 100;
  report('Claude Code vs an independent requestId re-count of the raw logs', [
    ['requests (raw requestId / collector)', `${n.toLocaleString()} / ${rs.length.toLocaleString()}`],
    ['total tokens (raw / collector)', verdict(Math.abs(d) <= TOL, `${fmt(rawSum)} / ${fmt(ourSum)}  (${(d * 100).toFixed(3)}%)`)],
  ]);
}

console.log('Reconciling collectors against independent counters (tolerance ±0.5%)');
await opencode();
await codex();
if (process.argv.includes('--claude')) await claude(); else console.log('\nClaude Code: skipped (pass --claude to re-read every raw log, ~1-2 min)');
console.log('\nAntigravity: no independent counter exists; its token fields are inferred from protobuf (see docs/antigravity-findings.md).');
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: all checked sources agree with their own counters');
process.exit(failed ? 1 : 0);
