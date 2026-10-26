// Price lookup from the LiteLLM-format rates file T3 keeps locally. USD per token.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';

const RATES = process.env.TOKEN_BURNING_RATES || join(homedir(), '.t3', 'userdata', 'usage-model-rates.json');

// Obvious aliases (normalised name -> normalised name). Add yours here.
export const OVERRIDES = {
  // 'codex-auto-review': 'gpt-5.5',   // uncomment once you know what it actually runs
};

// Source-provider prefixes we strip from logged names and from rate keys.
const STRIP = ['openrouter/', 'github-copilot/', 'github_copilot/', 'anthropic/', 'openai/', 'google/', 'vertex_ai/', 'gemini/', 'azure_ai/', 'chatgpt/'];

let idx; // Map<normalised name, entry>
function load() {
  if (idx) return idx;
  idx = new Map();
  let doc;
  try { doc = JSON.parse(readFileSync(RATES, 'utf8')).document; } catch { return idx; }
  if (!doc) return idx;
  // pass 1: bare keys (first-party), pass 2: provider-prefixed keys fill gaps
  for (const [k, v] of Object.entries(doc)) if (!k.includes('/') && v?.input_cost_per_token != null) idx.set(k.toLowerCase(), v);
  for (const [k, v] of Object.entries(doc)) {
    if (v?.input_cost_per_token == null) continue;
    const p = STRIP.find(s => k.startsWith(s));
    if (!p) continue;
    const n = k.slice(p.length).toLowerCase().replace(/@.*$/, '');
    if (!n.includes('/') && !idx.has(n)) idx.set(n, v);
  }
  return idx;
}

function norm(model) {
  let m = String(model || '').toLowerCase().trim();
  for (let again = true; again;) { again = false; for (const s of STRIP) if (m.startsWith(s)) { m = m.slice(s.length); again = true; } }
  m = m.replace(/@.*$/, '').replace(/-\d{8}$/, '');
  return OVERRIDES[m] || m;
}

const memo = new Map();
function resolve(model) {
  const m = norm(model);
  if (memo.has(m)) return memo.get(m);
  const ix = load();
  // dot<->dash only between digits (4.5 <-> 4-5), so 'gpt-5.5' <-> 'gpt-5-5' but not 'a-b'
  const cands = [m, m.replace(/(\d)\.(\d)/g, '$1-$2'), m.replace(/(\d)-(\d)(?!\d)/g, '$1.$2')];
  let hit = cands.find(c => ix.has(c));
  if (!hit) { // longest key that is a prefix of the name (claude-opus-4-7-foo -> claude-opus-4-7)
    for (const c of cands) for (const k of ix.keys()) if (c.startsWith(k) && (!hit || k.length > hit.length)) hit = k;
  }
  const r = hit ? { name: hit, e: ix.get(hit) } : null;
  memo.set(m, r);
  return r;
}

export function price(model, provider) {
  const r = resolve(model);
  if (!r) return null;
  const e = r.e, i = e.input_cost_per_token;
  const claude = /claude/.test(r.name) || provider === 'anthropic';
  return {
    in: i,
    out: e.output_cost_per_token ?? 0,
    cacheRead: e.cache_read_input_token_cost ?? (claude ? i * 0.1 : i),
    cacheWrite: e.cache_creation_input_token_cost ?? (claude ? i * 1.25 : i),
  };
}

// 1h cache writes bill at 2x input (5m = 1.25x); the rates file carries it as cache_creation_input_token_cost_above_1hr.
const write1h = (model) => { const r = resolve(model); return r ? r.e.cache_creation_input_token_cost_above_1hr ?? r.e.input_cost_per_token * 2 : 0; };

// USD split of a request. cacheWrite is the total; cacheWrite1h (optional) is the 1h-TTL part of it.
// shortcut: ignores long-context (>200k/272k) and priority/batch tiers, upgrade if totals look low on huge-prompt models
export function costParts(req) {
  const p = price(req.model, req.provider);
  if (!p) return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
  const w = req.cacheWrite || 0, w1 = Math.min(req.cacheWrite1h || 0, w);
  const input = (req.input || 0) * p.in, cacheRead = (req.cacheRead || 0) * p.cacheRead, output = (req.output || 0) * p.out;
  const cacheWrite = (w - w1) * p.cacheWrite + (w1 ? w1 * write1h(req.model) : 0);
  return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output };
}

export const cost = (req) => costParts(req).total;

export function models() { return [...new Set([...memo.values()].filter(Boolean).map(r => r.name))]; }

if (import.meta.filename === process.argv[1]) {
  const ours = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5-20251001', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.5',
    'codex-auto-review', 'gemini-3.8-flash', 'anthropic/claude-opus-4.8', 'openrouter/anthropic/claude-opus-4.8', 'claude-haiku-4.5', 'github-copilot/claude-haiku-4.5'];
  const bad = ours.filter(m => !price(m));
  console.log('unresolved:', bad);
  for (const m of ours) { const p = price(m); console.log(m.padEnd(40), p ? `${resolve(m).name}  in=${p.in * 1e6} out=${p.out * 1e6} cr=${p.cacheRead * 1e6} cw=${p.cacheWrite * 1e6} $/Mtok` : 'null'); }
  if (!load().size) { console.log('rates file missing; price() => null'); assert.equal(price('claude-sonnet-5-5'), null); process.exit(0); }
  const p = price('claude-sonnet-5-5', 'anthropic');
  assert.ok(p && p.in > 0 && p.out > p.in && p.cacheRead < p.in && p.cacheWrite > p.in);
  assert.deepEqual(price('anthropic/claude-opus-4.8'), price('claude-opus-4-8'));
  assert.deepEqual(price('claude-haiku-4-5-20251001'), price('claude-haiku-4-5'));
  assert.equal(price('definitely-not-a-model'), null);
  const req = { model: 'claude-sonnet-5-5', provider: 'anthropic', input: 1000, cacheRead: 100000, cacheWrite: 5000, output: 2000 };
  const exp = 1000 * p.in + 100000 * p.cacheRead + 5000 * p.cacheWrite + 2000 * p.out;
  assert.ok(Math.abs(cost(req) - exp) < 1e-12);
  const r1 = { ...req, cacheWrite1h: 2000 }, p1 = costParts(r1);
  assert.ok(Math.abs(p1.cacheWrite - (3000 * p.cacheWrite + 2000 * (resolve(r1.model).e.cache_creation_input_token_cost_above_1hr ?? 2 * p.in))) < 1e-12);
  assert.ok(Math.abs(p1.total - (p1.input + p1.cacheRead + p1.cacheWrite + p1.output)) < 1e-12 && p1.total > cost(req));
  assert.deepEqual(costParts({ model: 'definitely-not-a-model', output: 5 }).total, 0);
  console.log('sample cost', cost(req).toFixed(4), 'USD for', JSON.stringify(req));
  console.log('models():', models());
}
