#!/usr/bin/env node
// token-odometer-stats [--watch | --line | --last | --stop-hook | --open | --compact | --json | --csv]   quick terminal check: today per tool + last requests (--line: one line for a status bar; --last: the latest turn; --stop-hook: Claude Code Stop hook, prints the latest turn when it cost enough).
process.removeAllListeners('warning'); // node:sqlite's experimental notice
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.mjs';

const PORT = process.env.PORT || 4747;
const flag = (k) => process.argv.includes('--' + k);
const arg = (k) => process.argv.find((a) => a.startsWith('--' + k + '='))?.split('=')[1];
const RANGE = arg('range') || '1d', SERVER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const EXPORT = flag('json') || flag('csv');
const n = (x) => (x >= 1e9 ? (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : String(Math.round(x)));
const usd = (x) => (x >= 100 ? '$' + Math.round(x) : '$' + x.toFixed(2));
const ago = (ms) => (ms < 6e4 ? Math.round(ms / 1e3) + 's' : ms < 36e5 ? Math.round(ms / 6e4) + 'm' : (ms / 36e5).toFixed(1) + 'h');
const pad = (s, w, r) => (r ? String(s).padStart(w) : String(s).padEnd(w));
const store = createStore();

async function fetchRows() {
  try { // reuse a running server (instant); otherwise scan directly
    const r = await fetch(`http://127.0.0.1:${PORT}/api/data?range=${RANGE}${flag('line') || EXPORT ? '' : '&live'}`, { signal: AbortSignal.timeout(2500) });
    return decode(await r.json());
  } catch {
    // no server yet: start one in the background so the next call is instant (idle cost is zero), and answer this call directly
    if (!flag('no-start') && !EXPORT) spawn(process.execPath, ['--no-warnings', SERVER], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    await store.touch({ live: true });
    const d = JSON.parse(gunzipSync(store.payload(RANGE)));
    return decode(d);
  }
}
function decode(d) {
  const ix = Object.fromEntries(d.cols.map((c, i) => [c, i])), S = ['tool', 'provider', 'model', 'session', 'project', 'turn', 'agent'];
  return d.rows.map((r) => {
    const o = Object.fromEntries(d.cols.map((c, i) => [c, r[i]]));
    for (const c of S) o[c] = d.dict[o[c]];
    o.ctx = o.input + o.cacheRead + o.cacheWrite; o.tot = o.ctx + o.output;
    return o;
  });
}

async function show() {
  const rows = await fetchRows(), now = Date.now(), mid = new Date().setHours(0, 0, 0, 0);
  const today = rows.filter((r) => r.ts >= mid), by = new Map();
  for (const r of today) {
    const a = by.get(r.tool) || by.set(r.tool, { n: 0, tot: 0, fresh: 0, cr: 0, ctx: 0, cost: 0, tps: [] }).get(r.tool);
    a.n++; a.tot += r.tot; a.fresh += r.input + r.cacheWrite + r.output; a.cr += r.cacheRead; a.ctx += r.ctx; a.cost += r.costUsd || 0;
    if (r.durMs > 0 && r.output >= 30) a.tps.push(r.output / (r.durMs / 1e3));
  }
  const med = (a) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1] : 0);
  if (flag('last') || flag('stop-hook')) { // latest turn (a prompt and all its tool-loop requests, subagents included) + today
    const hook = flag('stop-hook'), sid = hook ? JSON.parse((!process.stdin.isTTY && (await new Response(process.stdin).text())) || '{}').session_id : arg('session');
    const mine = sid ? rows.filter((r) => r.session === sid) : rows, end = mine.at(-1);
    if (!end) return;
    const t = mine.filter((r) => r.session === end.session && r.turn === end.turn), sum = (k) => t.reduce((a, r) => a + (r[k] || 0), 0);
    const ctx = sum('ctx'), cost = sum('costUsd'), day = today.reduce((a, r) => a + (r.costUsd || 0), 0), STEP = 5;
    if (hook && cost < (+process.env.ODOMETER_MIN_USD || 0.25) && Math.floor(day / STEP) === Math.floor((day - cost) / STEP)) return; // quiet unless the turn was pricey or today crossed another $5
    const line = `Odometer · turn ${n(sum('tot'))} tok (${n(ctx - sum('cacheRead') + sum('output'))} new, ${n(sum('output'))} out) · ~${usd(cost)} · cache ${ctx ? Math.round(sum('cacheRead') / ctx * 100) : 0}% · ${t.length} req · today ~${usd(day)}`;
    console.log(hook ? JSON.stringify({ systemMessage: line }) : line);
    return;
  }
  if (process.argv.includes('--line')) { // e.g. a Claude Code status line or shell prompt
    let tot = 0, fresh = 0, cr = 0, ctx = 0, cost = 0;
    for (const a of by.values()) { tot += a.tot; fresh += a.fresh; cr += a.cr; ctx += a.ctx; cost += a.cost; }
    const spd = med(rows.slice(-10).filter((r) => r.durMs > 0 && r.output >= 30).map((r) => r.output / (r.durMs / 1e3)));
    console.log(`today ${n(tot)} tok (${n(fresh)} new) · ~${usd(cost)} API-eq · cache ${ctx ? Math.round(cr / ctx * 100) : 0}% · ${Math.round(spd) || '–'} tok/s`);
    return;
  }
  const out = [`Token Odometer · today since ${new Date(mid).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · as of ${new Date(now).toLocaleTimeString()}`, ''];
  out.push(pad('tool', 13) + pad('reqs', 7, 1) + pad('processed', 11, 1) + pad('paid-new', 10, 1) + pad('cache', 7, 1) + pad('API-eq $', 10, 1) + pad('tok/s', 7, 1));
  let T = { n: 0, tot: 0, fresh: 0, cost: 0 };
  for (const [t, a] of [...by].sort((x, y) => y[1].tot - x[1].tot)) {
    out.push(pad(t, 13) + pad(a.n, 7, 1) + pad(n(a.tot), 11, 1) + pad(n(a.fresh), 10, 1) + pad(a.ctx ? Math.round(a.cr / a.ctx * 100) + '%' : '–', 7, 1) + pad(usd(a.cost), 10, 1) + pad(Math.round(med(a.tps)) || '–', 7, 1));
    T.n += a.n; T.tot += a.tot; T.fresh += a.fresh; T.cost += a.cost;
  }
  if (!by.size) out.push('no requests yet today');
  else out.push(pad('total', 13) + pad(T.n, 7, 1) + pad(n(T.tot), 11, 1) + pad(n(T.fresh), 10, 1) + pad('', 7) + pad(usd(T.cost), 10, 1));
  const last = rows.slice(-6);
  if (last.length) {
    out.push('', 'latest requests');
    for (const r of last) out.push(`  ${pad(ago(now - r.ts) + ' ago', 9)}${pad(r.tool, 13)}${pad(r.model.slice(0, 22), 23)}ctx ${pad(n(r.ctx), 7, 1)}  out ${pad(n(r.output), 6, 1)}  cache ${pad(r.ctx ? Math.round(r.cacheRead / r.ctx * 100) + '%' : '–', 4, 1)}  ${r.durMs > 0 && r.output >= 30 ? Math.round(r.output / (r.durMs / 1e3)) + ' tok/s' : ''}`);
  }
  out.push('', 'API-eq $ = what these tokens cost at API list prices (not what a subscription bills).');
  console.log(out.join('\n'));
}

if (EXPORT) { // --json | --csv [--range=1d|7d|30d|All] [--by=day|tool|model|project]: pipe into a spreadsheet, jq or a CI job
  const by = arg('by'), rows = await fetchRows();
  const key = { day: (r) => new Date(r.ts).toISOString().slice(0, 10), tool: (r) => r.tool, model: (r) => r.model, project: (r) => r.project || '(none)' }[by];
  if (by && !key) { console.error('--by must be day, tool, model or project'); process.exit(2); }
  const sum = ['input', 'cacheRead', 'cacheWrite', 'output'], round = (x) => Math.round((x || 0) * 1e6) / 1e6;
  let out;
  if (key) {
    const g = new Map();
    for (const r of rows) {
      const k = key(r), a = g.get(k) || g.set(k, { [by]: k, requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 }).get(k);
      a.requests++; a.costUsd += r.costUsd || 0;
      for (const c of sum) a[c] += r[c];
    }
    out = [...g.values()].map((a) => ({ ...a, costUsd: round(a.costUsd) })).sort((x, y) => (by === 'day' ? (x.day < y.day ? -1 : 1) : y.costUsd - x.costUsd));
  } else {
    out = rows.map((r) => ({ time: new Date(r.ts).toISOString(), tool: r.tool, provider: r.provider, model: r.model, project: r.project, session: r.session, turn: r.turn, tools: r.tools, input: r.input, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, output: r.output, reasoning: r.reasoning, costUsd: round(r.costUsd), durMs: r.durMs }));
  }
  if (flag('json')) console.log(JSON.stringify(out, null, 2));
  else if (out.length) {
    const cell = (v) => (/[",\n]/.test(v = v ?? '') ? `"${String(v).replaceAll('"', '""')}"` : v), cols = Object.keys(out[0]);
    console.log([cols.join(','), ...out.map((o) => cols.map((c) => cell(o[c])).join(','))].join('\n'));
  }
  process.exit(0);
}
if (process.argv.includes('--open') || process.argv.includes('--compact')) {
  // tb --open: full dashboard in your browser; tb --compact: small chromeless Edge window (the Now view), good for a second monitor
  const compact = process.argv.includes('--compact'), url = `http://127.0.0.1:${PORT}/` + (compact ? '?compact' : '');
  const up = () => fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
  if (!(await up())) {
    spawn(process.execPath, ['--no-warnings', SERVER], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 40 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const win = process.platform === 'win32', launch = (cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  if (compact && win) launch('cmd', ['/c', 'start', '', 'msedge', `--app=${url}`, '--window-size=520,760']); // shortcut: chromeless window is Windows+Edge only, other OSes get a normal tab
  else if (win) launch('cmd', ['/c', 'start', '', url]);
  else launch(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  console.log('opening ' + url);
  process.exit(0);
}
if (process.argv.includes('--watch')) {
  for (;;) { console.clear(); await show(); await new Promise((r) => setTimeout(r, 5000)); }
} else { await show(); process.exit(0); }
