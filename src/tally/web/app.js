const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TOOLS = { 'claude-code': 'Claude Code', opencode: 'OpenCode', codex: 'Codex', antigravity: 'Antigravity', gemini: 'Gemini CLI' };
const tcol = (t) => `var(--${TOOLS[t] ? t : 'other'})`;
const tname = (t) => TOOLS[t] || t;
const RANGES = { '1d': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, All: Infinity };
const STR = ['tool', 'provider', 'model', 'session', 'project', 'turn', 'agent'];

// ---------- formatting ----------
const fmtN = (n) => n == null || isNaN(n) ? '–' : n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n));
const fmtUsd = (n) => n == null ? '–' : n >= 100 ? '$' + Math.round(n).toLocaleString() : n >= 1 ? '$' + n.toFixed(2) : '$' + n.toFixed(3);
const fmtMs = (n) => n == null ? '–' : n < 1000 ? Math.round(n) + 'ms' : n < 60000 ? (n / 1000).toFixed(1) + 's' : Math.round(n / 60000) + 'm' + String(Math.round(n % 60000 / 1000)).padStart(2, '0') + 's';
const fmtP = (x) => x == null || isNaN(x) ? '–' : (x * 100).toFixed(x >= .995 || x < .1 ? 1 : 0) + '%';
const fmtT = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: false });
const fmtWhen = (ts) => { const d = new Date(ts), t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t; };
const fmtAgo = (ms) => ms < 6e4 ? Math.max(0, Math.round(ms / 1e3)) + 's' : ms < 36e5 ? Math.round(ms / 6e4) + 'm' : ms < 864e5 ? (ms / 36e5).toFixed(1) + 'h' : Math.round(ms / 864e5) + 'd';
const fmtDay = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
const sum = (a, f) => a.reduce((s, r) => s + (f(r) || 0), 0);
const groupBy = (rs, f) => { const m = new Map(); for (const r of rs) { const k = f(r); (m.get(k) || m.set(k, []).get(k)).push(r); } return m; };

// ---------- state ----------
const params = new URLSearchParams(location.search);
if (params.has('compact')) document.body.classList.add('compact');
const S = { range: localStorage.range in RANGES ? localStorage.range : '7d', metric: 'tokens' };
let D = { rows: [], now: Date.now(), status: {}, limits: {} }; // analysis window
let N = { rows: [], now: Date.now(), status: {}, limits: {} }; // last 24h, refreshed every poll
let lastOk = 0, pulled = 0, busy = false, queued = null;

async function fetchData(range, opts = '') {
  const res = await fetch(`/api/data?range=${range}${opts}`);
  if (!res.ok) throw new Error(await res.text());
  const d = await res.json();
  const rows = d.rows.map((r) => {
    const o = {};
    d.cols.forEach((c, i) => (o[c] = r[i]));
    for (const c of STR) o[c] = d.dict[o[c]];
    o.tools = o.tools ? o.tools.split(',') : [];
    o.ctx = o.input + o.cacheRead + o.cacheWrite;
    o.fresh = o.input + o.cacheWrite + o.output;
    o.tot = o.ctx + o.output;
    // speed only for calls with a real generation phase; durMs includes time to first token
    o.tps = o.durMs > 0 && o.output >= 30 ? o.output / (o.durMs / 1000) : null;
    return o;
  });
  return { rows, now: d.now, status: d.status || {}, limits: d.limits || {} };
}

// Replace a container's HTML only when it changed, so hover, selection and scroll survive a refresh.
function put(el, html) {
  if (el._h === html) return false;
  el._h = html; el.innerHTML = html; hideTip();
  return true;
}

// ---------- tooltip ----------
const tip = $('#tip');
function showTip(e, html) {
  tip.innerHTML = html; tip.style.opacity = 1;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, e.clientX + 14)) + 'px';
  tip.style.top = Math.max(8, Math.min(innerHeight - h - 8, e.clientY + 14)) + 'px';
}
function hideTip() { tip.style.opacity = 0; }
const tipRows = (rows) => rows.map(([c, l, v]) => `<div><span>${c ? `<i style="background:${c}"></i>` : ''}${l}</span><span>${v}</span></div>`).join('');

// ---------- aggregation ----------
function agg(rs) {
  const o = { n: rs.length, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, noCache: 0, costN: 0, estN: 0, tps: [], dur: [] };
  for (const r of rs) {
    o.input += r.input; o.cacheRead += r.cacheRead; o.cacheWrite += r.cacheWrite; o.output += r.output;
    if (r.costUsd != null) { o.cost += r.costUsd; o.costN++; if (r.est) o.estN++; }
    o.noCache += r.noCache ?? r.costUsd ?? 0;
    if (r.tps) o.tps.push(r.tps);
    if (r.durMs > 0) o.dur.push(r.durMs);
  }
  const sorted = {};
  o.q = (k, p) => { const a = (sorted[k] ??= Float64Array.from(o[k]).sort()); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null; };
  o.ctx = o.input + o.cacheRead + o.cacheWrite; o.tokens = o.ctx + o.output; o.fresh = o.input + o.cacheWrite + o.output;
  o.hit = o.ctx ? o.cacheRead / o.ctx : null;
  o.saved = o.noCache - o.cost;
  o.usd = !o.costN ? '–' : o.cost === 0 ? '$0' : (o.estN ? '~' : '') + fmtUsd(o.cost);
  return o;
}
const tps50 = (a) => { const v = a.q('tps', .5); return v ? Math.round(v) : '–'; };
const dot = (t) => `<span class="dot" style="--c:${tcol(t)}"></span>`;

// =====================================================================
// NOW
// =====================================================================
function renderNow() {
  const rows = N.rows, a = agg(rows), recent = agg(rows.filter((r) => r.ts >= Date.now() - 3e5));
  let who = '<span class="sub">No requests in the last 24 hours</span>';
  if (rows.length) {
    const last = rows[rows.length - 1], idle = Date.now() - last.ts;
    const st = idle < 9e4 ? ['run', 'working'] : idle < 18e5 ? ['idle', `idle ${fmtAgo(idle)}`] : ['', `quiet for ${fmtAgo(idle)}`];
    who = `${dot(last.tool)}<b>${tname(last.tool)}</b><span class="sub">${esc(last.project || '')}${last.project ? ' · ' : ''}${esc(last.model)}</span><span class="state ${st[0]}">${st[1]}</span>`;
  }
  const limits = Object.entries(D.limits).filter(([, v]) => v && v.usedPercent != null).map(([t, v]) => {
    const left = v.resetsAt - Date.now(), days = Math.round(v.windowMinutes / 1440);
    return `<div class="limit">${dot(t)}<span>${tname(t)}${v.planType ? ' ' + esc(v.planType) : ''}</span><span class="track" title="${v.usedPercent}% used"><i style="width:${Math.min(100, v.usedPercent)}%;background:${v.usedPercent >= 90 ? 'var(--bad)' : v.usedPercent >= 70 ? 'var(--warn)' : 'var(--good)'}"></i></span><span class="num">${v.usedPercent}%${days ? ` of ${days}-day window` : ''}</span><span class="sub">${left > 0 ? 'resets in ' + fmtAgo(left) : 'reset ' + fmtAgo(-left) + ' ago'}</span></div>`;
  }).join('');
  put($('#now'), `<div class="who">${who}</div>
    <div class="hero">
      <div><div class="big">${fmtN(a.tokens)}</div><div class="sub">tokens processed in the last 24 hours</div></div>
      <div class="rate"><span><b>${fmtN(recent.tokens)}</b> tokens in the last 5 min</span><span><b>${tps50(recent)}</b> tok/s median</span></div>
    </div>
    <div class="facts">
      <span><b>${fmtN(a.n)}</b> calls</span>
      <span><b>${a.usd}</b> API-equivalent</span>
      <span><b>${fmtP(a.hit)}</b> cache hit</span>
      <span><b>${fmtN(a.fresh)}</b> newly paid</span>
    </div>${limits}`);

  const feed = rows.slice(-10).reverse();
  put($('#feed'), feed.length ? `<thead><tr><th class="l">Time</th><th class="l">Model</th><th>Context</th><th class="hm">Output</th><th>Cache</th><th class="hm">tok/s</th><th class="hm">Took</th></tr></thead><tbody>` + feed.map((r) =>
    `<tr><td class="l n">${fmtWhen(r.ts)}</td><td class="l">${dot(r.tool)}${esc(r.model)}<span class="tag">${tname(r.tool)}${r.agent === 'subagent' ? ' · sub' : ''}</span></td><td class="n">${fmtN(r.ctx)}</td><td class="n hm">${fmtN(r.output)}</td><td class="n">${fmtP(r.ctx ? r.cacheRead / r.ctx : null)}</td><td class="n hm">${r.tps ? Math.round(r.tps) : '–'}</td><td class="n hm">${fmtMs(r.durMs)}</td></tr>`).join('') + '</tbody>' : '');
}

// =====================================================================
// HISTORY
// =====================================================================
const niceMax = (m) => { if (m <= 0) return 3; const p = 10 ** Math.floor(Math.log10(m / 3)), f = m / 3 / p; return 3 * p * ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => x >= f - 1e-9) || 10); };
const STEPS = [3e5, 6e5, 36e5, 216e5, 864e5, 6048e5];
function buckets(rs, lo, hi) {
  lo ??= rs[0].ts; hi ??= rs[rs.length - 1].ts;
  const step = STEPS.find((s) => (hi - lo) / s <= 90) || STEPS[5];
  const off = -new Date(lo).getTimezoneOffset() * 6e4, start = Math.floor((lo + off) / step) * step - off, n = Math.floor((hi - start) / step) + 1;
  const b = Array.from({ length: n }, (_, i) => ({ t: start + i * step, rs: [] }));
  for (const r of rs) { const i = Math.floor((r.ts - start) / step); if (b[i]) b[i].rs.push(r); }
  return { step, b };
}
const fmtBucket = (t, step) => step >= 864e5 ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }) : fmtT(t);
const stepName = (s) => s >= 864e5 ? Math.round(s / 864e5) + '-day' : s >= 36e5 ? Math.round(s / 36e5) + '-hour' : Math.round(s / 6e4) + '-minute';
const METRICS = {
  tokens: { val: (g) => sum(g, (r) => r.tot), fmt: fmtN, label: 'tokens processed' },
  cost: { val: (g) => sum(g, (r) => r.costUsd), fmt: fmtUsd, label: 'API-equivalent cost' },
};

function stats(rs) {
  const a = agg(rs), k = (v, l, s) => `<div class="stat"><b>${v}</b><span>${l}</span><small>${s}</small></div>`;
  put($('#stats'),
    k(fmtN(a.tokens), 'tokens processed', `${fmtN(a.n)} requests, ${fmtN(a.fresh)} newly paid`) +
    k(a.usd, 'API-equivalent cost', a.saved > .005 ? `${fmtUsd(a.saved)} saved by caching` : 'at list prices') +
    k(fmtP(a.hit), 'cache hit', `${fmtN(a.cacheRead)} tokens reused`) +
    k(tps50(a), 'tokens/sec', `median, p90 ${Math.round(a.q('tps', .9) || 0) || '–'} · latency ${fmtMs(a.q('dur', .5))}`));
}

function timeline(rs) {
  const el = $('#timeline'), note = $('#timeline-note');
  if (!rs.length) { put(el, '<div class="empty">No requests in this range.</div>'); note.textContent = ''; return; }
  const M = METRICS[S.metric], span = RANGES[S.range], tools = [...new Set(rs.map((r) => r.tool))].sort();
  const { step, b } = buckets(rs, span === Infinity ? undefined : D.now - span, span === Infinity ? undefined : D.now);
  const W = Math.max(280, el.clientWidth), H = 220, m = { l: 46, r: 4, t: 6, b: 22 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const data = b.map((x) => ({ t: x.t, rs: x.rs, per: tools.map((t) => M.val(x.rs.filter((r) => r.tool === t))) }));
  const tot = (d) => d.per.reduce((a, c) => a + c, 0), max = niceMax(Math.max(...data.map(tot), 1)), bw = iw / data.length, y = (v) => m.t + ih - v / max * ih;
  let s = '';
  for (let i = 0; i <= 3; i++) { const v = max * i / 3; s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${M.fmt(v)}</text>`; }
  data.forEach((d, i) => {
    let acc = 0;
    d.per.forEach((v, j) => {
      if (!v) return;
      const y0 = y(acc + v), h = Math.max(1, y(acc) - y0 - (acc ? 1.5 : 0)); acc += v;
      s += `<rect x="${m.l + i * bw + 1}" y="${y0}" width="${Math.max(1, bw - 2)}" height="${h}" style="fill:${tcol(tools[j])}"/>`;
    });
  });
  const every = Math.ceil(data.length / Math.max(2, Math.floor(iw / 110)));
  data.forEach((d, i) => { if (i % every === 0) s += `<text x="${m.l + i * bw}" y="${H - 4}">${fmtBucket(d.t, step)}</text>`; });
  s += `<rect class="hov" fill="none" rx="2" style="display:none"/><rect class="cap" x="${m.l}" y="0" width="${iw}" height="${H}" fill="transparent"/>`;
  const legend = `<div class="legend">${tools.map((t) => `<span>${dot(t)}${tname(t)}</span>`).join('')}</div>`;
  if (put(el, `${legend}<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Stacked bars of ${M.label} over time by tool">${s}</svg>`)) {
    const svg = el.querySelector('svg'), hov = svg.querySelector('.hov'), cap = svg.querySelector('.cap');
    cap.onmousemove = (e) => {
      const bx = svg.getBoundingClientRect(), i = Math.max(0, Math.min(data.length - 1, Math.floor(((e.clientX - bx.left) * (W / bx.width) - m.l) / bw))), d = data[i], a = agg(d.rs);
      hov.setAttribute('x', m.l + i * bw); hov.setAttribute('y', m.t); hov.setAttribute('width', bw); hov.setAttribute('height', ih); hov.style.display = '';
      showTip(e, `<b>${fmtBucket(d.t, step)}</b>` + tipRows([...tools.map((t, j) => [tcol(t), tname(t), M.fmt(d.per[j])]), [null, 'calls', d.rs.length], [null, 'cache hit', fmtP(a.hit)]]));
    };
    cap.onmouseleave = () => { hideTip(); hov.style.display = 'none'; };
  }
  const top = data.reduce((p, c) => (tot(c) > tot(p) ? c : p));
  note.textContent = `Each bar is a ${stepName(step)} slot. Busiest: ${fmtBucket(top.t, step)} with ${M.fmt(tot(top))} ${M.label}.`;
}

function models(rs) {
  const rows = [...groupBy(rs, (r) => r.tool + '\u0001' + r.model)].map(([k, g]) => { const [t, model] = k.split('\u0001'); return { t, model, a: agg(g) }; }).sort((x, y) => y.a.tokens - x.a.tokens).slice(0, 12);
  put($('#models'), rows.length ? `<thead><tr><th class="l">Model</th><th>Requests</th><th>Tokens</th><th title="cache read ÷ all input">Cache hit</th><th title="median output tokens per second">tok/s</th><th class="hm" title="median wall time per request">Latency</th><th title="at list prices; ~ = partly estimated">API $</th></tr></thead><tbody>` +
    rows.map(({ t, model, a }) => `<tr><td class="l">${dot(t)}${esc(model)}<span class="tag">${tname(t)}</span></td><td class="n">${fmtN(a.n)}</td><td class="n">${fmtN(a.tokens)}</td><td class="n">${fmtP(a.hit)}</td><td class="n">${tps50(a)}</td><td class="n hm">${fmtMs(a.q('dur', .5))}</td><td class="n">${a.usd}</td></tr>`).join('') + '</tbody>' : '');
}

function turns(rs) {
  const all = [...groupBy(rs, (r) => r.tool + '\u0001' + r.turn)].map(([, g]) => {
    let start = Infinity, end = 0;
    for (const r of g) { start = Math.min(start, r.ts - (r.durMs || 0)); end = Math.max(end, r.ts); }
    return { a: agg(g), tool: g[0].tool, project: g[0].project, start, wall: end - start };
  }).sort((x, y) => y.a.tokens - x.a.tokens).slice(0, 10);
  put($('#turns'), all.length ? `<thead><tr><th class="l">When</th><th class="l">Tool</th><th class="l hm">Project</th><th>Requests</th><th>Tokens</th><th class="hm">Cache hit</th><th>Wall time</th><th>API $</th></tr></thead><tbody>` +
    all.map((t) => `<tr><td class="l n">${fmtT(t.start)}</td><td class="l">${dot(t.tool)}${tname(t.tool)}</td><td class="l hm">${esc(t.project || '–')}</td><td class="n">${t.a.n}</td><td class="n">${fmtN(t.a.tokens)}</td><td class="n hm">${fmtP(t.a.hit)}</td><td class="n">${fmtMs(t.wall)}</td><td class="n">${t.a.usd}</td></tr>`).join('') + '</tbody>' : '');
}

// Weft panel: its own savings and adoption (/api/weft, hidden when Weft is absent), plus cost per turn with vs without Weft calls from the rows we already have.
let weftData = null, weftAt = 0;
async function weftPanel(rs) {
  if (Date.now() - weftAt > 6e4) { weftAt = Date.now(); weftData = await fetch('/api/weft').then((r) => r.json()).catch(() => null); }
  const w = weftData, el = $('#weft');
  el.hidden = !w?.available;
  if (el.hidden) return;
  const turnCost = new Map();
  for (const r of rs) { const k = r.tool + '' + r.turn, t = turnCost.get(k) || turnCost.set(k, { usd: 0, weft: false }).get(k); t.usd += r.costUsd || 0; t.weft ||= r.tools.some((n) => n.includes('weft_')); }
  const avg = (on) => { const t = [...turnCost.values()].filter((x) => x.weft === on); return t.length ? { n: t.length, usd: t.reduce((s, x) => s + x.usd, 0) / t.length } : null; };
  const [yes, no] = [avg(true), avg(false)], a = w.adoption, saved = w.toolTokens.baseline - w.toolTokens.returned;
  put($('#weft-body'),
    `Adoption ${a.percent}% of sessions (${fmtN(a.weftCalls)} Weft calls vs ${fmtN(a.explorationCalls)} Grep/Glob/Read). Tokens returned ${fmtN(w.toolTokens.returned)} vs ${fmtN(w.toolTokens.baseline)} reading whole files: ${fmtN(saved)} saved.` +
    (yes && no ? ` Average API cost per turn: ${fmtUsd(yes.usd)} with Weft calls (${fmtN(yes.n)} turns) vs ${fmtUsd(no.usd)} without (${fmtN(no.n)}). Correlation, not proof: turns that call Weft tend to be code-heavy.` : ''));
}

function renderHistory() {
  const rs = D.rows;
  stats(rs); timeline(rs); models(rs); turns(rs); weftPanel(rs);
  const st = Object.entries(D.status).map(([k, v]) => v.ok ? `${tname(k)}: ${fmtN(v.n)} requests${v.first ? `, ${fmtDay(v.first)} → ${fmtDay(v.last)}` : ''}` : `${tname(k)}: ${esc(v.error)}`).join(' · ');
  put($('#sources'), st ? `Scanned: ${st}. Antigravity token fields are inferred from its protobuf logs.` : '');
}

// =====================================================================
// controls, render, polling
// =====================================================================
function seg(el, opts, key, cb) {
  put(el, opts.map(([v, l]) => `<button aria-pressed="${S[key] === v}" data-v="${v}">${l}</button>`).join(''));
  el.onclick = (e) => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (v == null || v === S[key]) return;
    S[key] = v; seg(el, opts, key, cb); cb();
    el.querySelector(`[data-v="${v}"]`).focus();
  };
}
const render = () => { renderNow(); renderHistory(); };
const setLive = () => { const on = Date.now() - lastOk < 20000; $('#live').classList.toggle('on', on); $('#live span').textContent = on ? 'live' : 'stale'; };

// One loop: the last 24h every 5s (Now), the chosen range at most every 30s (History), never two requests at once.
async function poll(force = '') {
  if (busy) { queued = force; return; } // a click mid-request runs right after it
  if (document.hidden && !force) return;
  busy = true;
  try {
    const range = S.range, wantD = force || Date.now() - pulled > 30000;
    const [n, d] = await Promise.all([fetchData('1d', force || '&live'), wantD ? fetchData(range, force) : null]);
    N = n;
    if (d && range === S.range) { D = d; pulled = Date.now(); }
    lastOk = Date.now();
    render();
  } catch { /* server restarting or first scan failed: keep what is on screen, the dot turns stale */ }
  busy = false;
  setLive();
  if (queued != null) { const f = queued; queued = null; await poll(f); }
}

seg($('#range'), Object.keys(RANGES).map((k) => [k, k]), 'range', () => { localStorage.range = S.range; pulled = 0; poll('&'); });
seg($('#metric'), [['tokens', 'Tokens'], ['cost', 'Cost']], 'metric', () => timeline(D.rows));
$('#refresh').onclick = async () => { const b = $('#refresh'); b.disabled = true; b.textContent = 'Scanning…'; await poll('&refresh'); b.textContent = 'Rescan'; b.disabled = false; };
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => timeline(D.rows), 150); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

render();
poll();
setInterval(poll, 5000);
setInterval(setLive, 1000);
