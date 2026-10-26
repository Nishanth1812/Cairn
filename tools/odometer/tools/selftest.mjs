// tools/selftest.mjs — verification harness for collectors/*.mjs.
// For every collector (skip files starting with "_") it calls collect({ since: now - 7d })
// and checks the returned rows against invariants, so the dashboard cannot quietly show garbage.
//
//   node tools/selftest.mjs        -> per-check PASS/FAIL report + summary table + failure/warning list
//   node tools/selftest.mjs --json -> the same result as one JSON object
//
// Exit code: 0 = no FAILs, 1 = at least one FAIL (or an import/run error).
// Writes nothing itself (collectors only refresh their own files under .cache/).
// A missing/empty source directory is SKIP, never a crash.

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY = 864e5;
const WINDOW_DAYS = 7;            // how far back we ask each collector
const TS_DAYS = 8;                // timestamps must lie within this much history
const TS_FUTURE_SLACK = 5 * 60e3; // tolerated clock skew for ts slightly in the future
const MAX_DUR_MS = 600e3;         // > 10 min "generation" = waiting on user/tools, not a model
const MIN_OUTPUT = 30;            // below this output a row says nothing about tok/s
const MAX_TOK_S = 1500;           // no model sustains this: above it, the duration is measured wrong
const FAST_TOK_S = 400;           // fast but real (2026 models reach 500+): reported, never flagged

const RANK = { SKIP: 0, PASS: 1, WARN: 2, FAIL: 3, ERROR: 4 };
const CHECK_NAMES = ['notEmpty', 'tokenSanity', 'noDoubleCount', 'cacheRatio', 'durationSanity', 'speedSanity', 'turnGrouping', 'timestamps'];
const ctx = (name, status, value) => ({ name, status, value });

// ---------- formatting / stats helpers ----------
const fmtInt = (n) => Number(n).toLocaleString('en-US');
const fmtTok = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const fmtMs = (ms) => ms >= 60e3 ? Math.round(ms / 6e4) + 'm' : (Math.round(ms / 10) / 100) + 's';
const fmtTs = (v) => v >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
const pctile = (sorted, q) => { // sorted ascending; null when empty
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const cut = (s) => (String(s).length <= 60 ? String(s) : String(s).slice(0, 57) + '...');
const ids = (list) => list.slice(0, 3).map((r) => cut(r.id ?? '(no id)'));

// Count files (not dirs) under dir; bounded so a huge tree cannot hang the harness.
async function countFiles(dir, cap = 20000) {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < cap) {
    const p = stack.pop();
    let ents; try { ents = await readdir(p, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) stack.push(join(p, e.name)); else n++;
      if (n >= cap) break;
    }
  }
  return n;
}

// Why a collector returned 0 rows. Returns { skip: reason } for legitimate empties,
// { fail: reason } when source files exist but even since=0 parses nothing (real bug).
async function emptyReason(mod) {
  const root = mod?.meta?.root;
  let st = null;
  try { if (root && existsSync(root)) st = await stat(root); } catch {}
  if (!st) return { skip: `source dir missing: ${root || '(meta.root unset)'}` };
  let files = 1;
  if (st.isDirectory()) files = await countFiles(root);
  if (!files) return { skip: `source dir is empty: ${root}` };
  if (st.isFile()) return { skip: `source file present but empty/no matching data: ${root}` };
  try {
    const all = (await mod.collect({ since: 0 })) ?? [];
    if (!all.length) return { fail: `0 rows parsed although ${fmtInt(files)} files exist in ${root}` };
    return { skip: `no rows in the last ${WINDOW_DAYS}d; ${fmtInt(all.length)} older rows exist (no recent usage)` };
  } catch (e) { return { fail: `0 rows in window; since=0 probe threw: ${e?.message || e}` }; }
}

// Run one collector over the window and evaluate every invariant on its rows.
async function runCollector(file, since) {
  const base = file.split(/[\\/]/).pop();
  const rec = { module: file, id: base, label: '', status: 'PASS', rows: 0, tokens: 0, medianTokPerSec: null, cacheHit: null, checks: [] };
  const add = (name, status, value) => {
    rec.checks.push(ctx(name, status, value));
    if (RANK[status] > RANK[rec.status]) rec.status = status;
  };

  let mod;
  try { mod = await import(pathToFileURL(file).href); }
  catch (e) { rec.status = 'FAIL'; add('import', 'FAIL', 'module failed to load: ' + (e?.message || e)); return rec; }
  if (mod?.meta?.id) rec.id = mod.meta.id;
  if (mod?.meta?.label) rec.label = mod.meta.label;

  if (typeof mod?.collect !== 'function') { add('collect', 'SKIP', 'no collect() export — not a collector'); return rec; }

  let rows;
  try {
    rows = (await mod.collect({ since })) ?? [];
    if (!Array.isArray(rows)) throw new TypeError('collect() returned ' + typeof rows + ', expected array');
  } catch (e) {
    rec.status = 'FAIL';
    add('collect', 'FAIL', 'collect() threw: ' + (e?.message || e));
    return rec;
  }
  const N = rows.length;
  rec.rows = N;
  const now = Date.now();

  // 1) notEmpty — with the legit-empty shortcuts
  if (!N) {
    const why = await emptyReason(mod).catch((e) => ({ fail: `0 rows; emptyReason probe crashed: ${e?.message || e}` }));
    add('notEmpty', why.skip ? 'SKIP' : 'FAIL', why.skip ?? why.fail);
    for (const name of CHECK_NAMES.slice(1)) add(name, 'SKIP', 'no rows');
    return rec;
  }

  // Aggregate everything we need per invariant (single pass where possible).
  let tokens = 0, ctxT = 0, cacheReadSum = 0, outSum = 0;
  const badTok = [];
  for (const r of rows) {
    const bad = ![r.input, r.cacheRead, r.cacheWrite, r.output].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
      || !((r.input || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0) + (r.output || 0) > 0);
    if (bad) badTok.push(r);
    else { tokens += r.input + r.cacheRead + r.cacheWrite + r.output; ctxT += r.input + r.cacheRead + r.cacheWrite; cacheReadSum += r.cacheRead; outSum += r.output; }
  }

  const idCounts = new Map();
  for (const r of rows) { const k = typeof r.id === 'string' ? r.id : ''; idCounts.set(k, (idCounts.get(k) || 0) + 1); }
  const dupExtra = rows.length - idCounts.size, blankIds = idCounts.get('') || 0;
  const dupIds = [...idCounts].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n}x ${k || '(empty id)'}`);

  const ratios = []; let badRatio = 0;
  for (const r of rows) {
    const c = (r.input || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);
    if (!(c > 0)) continue;
    const q = (r.cacheRead || 0) / c;
    ratios.push(q);
    if (!(q >= 0 && q <= 1)) badRatio++;
  }
  let minR = Infinity, maxR = -Infinity;
  for (const q of ratios) { if (q < minR) minR = q; if (q > maxR) maxR = q; }
  if (!ratios.length) minR = maxR = null;

  const durs = []; let nanDur = 0;
  const speedRows = [];
  for (const r of rows) {
    if (typeof r.durMs !== 'number') continue; // null/undefined/string = no duration
    if (!Number.isFinite(r.durMs)) { nanDur++; continue; }
    durs.push(r.durMs);
    if (r.durMs > 0 && r.output >= MIN_OUTPUT) speedRows.push(r.output / (r.durMs / 1000));
  }
  const noDur = rows.length - durs.length - nanDur;
  const nonPos = durs.filter((d) => d <= 0).length, overMax = durs.filter((d) => d > MAX_DUR_MS).length;
  durs.sort((a, b) => a - b);
  const speeds = [...speedRows].sort((a, b) => a - b);
  const fastN = speedRows.filter((s) => s > MAX_TOK_S).length;      // impossible: duration bug
  const quickN = speedRows.filter((s) => s > FAST_TOK_S && s <= MAX_TOK_S).length; // fast but plausible

  const groups = new Map();
  for (const r of rows) {
    const t = r.turn;
    if (t == null || t === '') continue; // unknowable turn: not grouped anywhere
    let g = groups.get(t);
    if (!g) groups.set(t, g = { tool: new Set(), sess: new Set() });
    g.tool.add(String(r.tool)); g.sess.add(String(r.session));
  }
  const mixed = [...groups.entries()].filter(([, g]) => g.tool.size > 1 || g.sess.size > 1);
  const eg = mixed[0] ? `\n         eg turn <${cut(mixed[0][0])}>: sessions [${[...mixed[0][1].sess].map((s) => cut(s)).join(', ')}], tools [${[...mixed[0][1].tool].join(', ')}]` : '';

  const lo = since - (TS_DAYS - WINDOW_DAYS) * DAY, hi = now + TS_FUTURE_SLACK;
  let notTs = 0, early = 0, late = 0, oldest = Infinity;
  for (const r of rows) {
    if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) { notTs++; continue; }
    if (r.ts < oldest) oldest = r.ts;
    if (r.ts < lo) early++; else if (r.ts > hi) late++;
  }
  const badTs = notTs + early + late;

  // 1..8) the invariants
  add('notEmpty', 'PASS', `${fmtInt(N)} rows in the last ${WINDOW_DAYS}d`);
  add('tokenSanity', badTok.length ? 'FAIL' : 'PASS', badTok.length
    ? `${fmtInt(badTok.length)}/${fmtInt(N)} rows have a negative/non-numeric token field or an all-zero sum; eg ${ids(badTok)}`
    : `all ${fmtInt(N)} rows: input/cacheRead/cacheWrite/output ≥ 0 (finite) and sum > 0`);
  add('noDoubleCount', dupExtra + blankIds ? 'FAIL' : 'PASS', dupExtra + blankIds
    ? `${dupExtra} duplicate id occurrences, ${blankIds} rows without an id (unique: ${idCounts.size} of ${N})${dupIds.length ? '; eg ' + dupIds.join(', ') : ''}`
    : `${fmtInt(idCounts.size)} unique ids for ${fmtInt(N)} rows`);
  add('cacheRatio', badRatio ? 'FAIL' : ratios.length ? 'PASS' : 'SKIP', ratios.length
    ? `${badRatio ? badRatio + ' rows outside [0,1]; ' : ''}cacheRead/(input+cacheRead+cacheWrite) in [${(minR * 100).toFixed(1)}%, ${(maxR * 100).toFixed(1)}%] over ${fmtInt(ratios.length)} rows with context tokens`
    : 'no rows with context tokens');
  add('durationSanity', nonPos + overMax + nanDur ? 'FAIL' : durs.length ? 'PASS' : 'SKIP', durs.length
    ? `median ${fmtMs(pctile(durs, 0.5))}, max ${fmtMs(durs[durs.length - 1])}; ${fmtInt(noDur)}/${fmtInt(N)} rows without durMs; ${nonPos} ≤ 0ms, ${overMax} > ${MAX_DUR_MS / 6e4}min, ${nanDur} NaN`
    : `no rows carry durMs (${fmtInt(noDur)}/${fmtInt(N)} null, ${nanDur} NaN)`);
  add('speedSanity', fastN ? 'WARN' : speeds.length ? 'PASS' : 'SKIP', speeds.length
    ? `${fastN} rows above ${MAX_TOK_S} tok/s (impossible, max ${fmtTs(pctile(speeds, 1))})${quickN ? `; ${fmtInt(quickN)} rows between ${FAST_TOK_S} and ${MAX_TOK_S} tok/s are fast but plausible` : ''}; p50 ${fmtTs(pctile(speeds, 0.5))}, p90 ${fmtTs(pctile(speeds, 0.9))} tok/s over ${fmtInt(speeds.length)} rows with durMs + output ≥ ${MIN_OUTPUT}`
    : `no rows with durMs > 0 and output ≥ ${MIN_OUTPUT}`);
  add('turnGrouping', mixed.length ? 'FAIL' : groups.size ? 'PASS' : 'SKIP', groups.size
    ? `${mixed.length}/${fmtInt(groups.size)} turn groups mix tools or sessions${eg}`
    : `all ${fmtInt(N)} rows have empty/missing turn ids`);
  add('timestamps', badTs ? 'FAIL' : 'PASS', badTs
    ? `${badTs}/${fmtInt(N)} rows bad timestamps: ${notTs} non-numeric/NaN, ${early} older than ${TS_DAYS}d, ${late} in the future beyond ${TS_FUTURE_SLACK / 6e4}min clock-skew slack`
    : `all ${fmtInt(N)} ts are finite numbers within the last ${TS_DAYS}d (oldest ${((now - oldest) / DAY).toFixed(1)}d ago)`);

  // summary figures for the compact table
  rec.tokens = tokens;
  rec.cacheHit = ctxT > 0 ? cacheReadSum / ctxT : null;
  rec.medianTokPerSec = speeds.length ? pctile(speeds, 0.5) : null;
  return rec;
}

// ---------- reporting ----------
const HEAD = ['collector', 'rows', 'tokens', 'median tok/s', 'cache hit', 'status'];
const ALIGN = ['l', 'r', 'r', 'r', 'r', 'l'];
const cells = (r) => [
  r.id,
  fmtInt(r.rows),
  fmtTok(r.tokens),
  r.medianTokPerSec == null ? '—' : fmtTs(r.medianTokPerSec),
  r.cacheHit == null ? '—' : (r.cacheHit * 100).toFixed(1) + '%',
  r.status,
];
const table = (rows_) => {
  const widths = HEAD.map((h, i) => Math.max(h.length, ...rows_.map((r) => cells(r)[i].length)));
  const pad = (s, i) => ALIGN[i] === 'r' ? s.padStart(widths[i]) : s.padEnd(widths[i]);
  const line = (c) => c.map(pad).join('  ');
  console.log(line(HEAD));
  console.log(line(HEAD.map((h, i) => '-'.repeat(widths[i]))));
  for (const r of rows_) console.log(line(cells(r)));
};
const checkLine = (c) => `  ${c.name.padEnd(15)}${c.status.padEnd(5)}${c.value}`;

async function main() {
  const json = process.argv.slice(2).includes('--json');
  const now = Date.now(), since = now - WINDOW_DAYS * DAY;
  const dir = join(import.meta.dirname, '..', 'collectors');
  let files = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort(); }
  catch { /* collectors dir missing */ }

  const runs = (await Promise.allSettled(files.map((f) => runCollector(join(dir, f), since)))).map((s, i) =>
    s.status === 'fulfilled' ? s.value
      : { module: files[i], id: baseOf(files[i]), label: '', status: 'FAIL', rows: 0, tokens: 0, medianTokPerSec: null, cacheHit: null, checks: [ctx('run', 'FAIL', 'harness crashed: ' + (s.reason?.message || s.reason))] });

  const fails = runs.flatMap((r) => r.checks.filter((c) => c.status === 'FAIL').map((c) => `${r.id}/${c.name} — ${c.value}`));
  const warns = runs.flatMap((r) => r.checks.filter((c) => c.status === 'WARN').map((c) => `${r.id}/${c.name} — ${c.value}`));
  const ok = fails.length === 0;

  if (json) {
    console.log(JSON.stringify({
      generatedAt: new Date(now).toISOString(),
      window: { days: WINDOW_DAYS, since: new Date(since).toISOString() },
      ok,
      totals: { collectors: runs.length, rows: runs.reduce((a, r) => a + r.rows, 0), tokens: runs.reduce((a, r) => a + r.tokens, 0), fails: fails.length, warns: warns.length },
      collectors: runs.map((r) => ({ id: r.id, label: r.label, module: r.module, status: r.status, rows: r.rows, tokens: r.tokens, medianTokPerSec: r.medianTokPerSec, cacheHit: r.cacheHit, checks: r.checks })),
      failures: fails, warnings: warns,
    }, null, 2));
  } else {
    console.log(`collector self-test — collecting the last ${WINDOW_DAYS}d (since ${new Date(since).toISOString().slice(0, 16)})`);
    for (const r of runs) {
      console.log(`\n# ${r.id} — ${baseOf(r.module)}`);
      for (const c of r.checks) console.log(checkLine(c));
    }
    console.log('\nsummary');
    table(runs);
    console.log('');
    if (!fails.length && !warns.length) console.log('no failures, no warnings');
    else {
      for (const f of fails) console.log('FAIL  ' + f);
      for (const w of warns) console.log('WARN  ' + w);
    }
  }
  process.exitCode = ok ? 0 : 1;
}

const baseOf = (p) => String(p).split(/[\\/]/).pop();
main().catch((e) => { console.error('selftest crashed:', e); process.exitCode = 1; });
