// Gemini CLI session logs: ~/.gemini/tmp/<project>/chats/session-*.json (older: one JSON document, newer: JSON Lines).
// Written from the documented format; unverified against real logs on the author's machine (none installed), so it is labelled experimental.
import { readdir, stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

const root = join(homedir(), '.gemini', 'tmp');
export const meta = { id: 'gemini', label: 'Gemini CLI', root, watch: [{ path: root, recursive: true, match: /\.jsonl?$/ }] };

const MEM = new Map(); // file -> { sig, reqs }: an unchanged file is never re-read

async function* walk(dir) {
  let es;
  try { es = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/^session-.*\.jsonl?$/.test(e.name)) yield p;
  }
}

// Whole-file JSON first (a session object), then line by line; a line may be a message or a session wrapper.
function messages(text) {
  try { const d = JSON.parse(text); if (Array.isArray(d?.messages)) return { sid: d.sessionId, msgs: d.messages }; } catch {}
  const msgs = []; let sid;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { const d = JSON.parse(l); sid ??= d.sessionId; if (d.type) msgs.push(d); else if (Array.isArray(d.messages)) msgs.push(...d.messages); } catch {}
  }
  return { sid, msgs };
}

function parse(text, file) {
  const { sid, msgs } = messages(text);
  const session = sid || basename(file).replace(/\.jsonl?$/, ''), project = basename(join(file, '..', '..'));
  const out = []; let turn = session;
  for (const m of msgs) {
    if (m.type === 'user') { turn = `${session}:${m.id || m.timestamp}`; continue; }
    const t = m.tokens, ts = Date.parse(m.timestamp);
    if (m.type !== 'gemini' || !t || !m.model || !(ts > 0)) continue;
    const cached = t.cached || 0;
    out.push({
      id: `gemini:${session}:${m.id || ts}`, tool: 'gemini', provider: 'google', model: m.model, session, project, turn, ts,
      durMs: null, // no request start time is logged
      input: Math.max(0, (t.input || 0) - cached), // Gemini's prompt count includes the cached part
      cacheRead: cached, cacheWrite: 0,
      output: (t.output || 0) + (t.thoughts || 0), // thinking tokens are reported apart from the answer
      reasoning: t.thoughts || 0, costUsd: null,
      tools: (m.toolCalls || []).map((c) => c.name).filter(Boolean), agent: 'main',
    });
  }
  return out;
}

export async function collect({ since = 0 } = {}) {
  const seen = new Set(), all = [];
  for await (const f of walk(root)) {
    let st; try { st = await stat(f); } catch { continue; }
    seen.add(f);
    const sig = `${st.size}:${st.mtimeMs}`;
    let e = MEM.get(f);
    if (e?.sig !== sig) {
      let reqs = []; try { reqs = parse(await readFile(f, 'utf8'), f); } catch {}
      MEM.set(f, e = { sig, reqs });
    }
    for (const r of e.reqs) if (r.ts >= since) all.push(r);
  }
  for (const f of MEM.keys()) if (!seen.has(f)) MEM.delete(f);
  return all.sort((a, b) => a.ts - b.ts);
}

if (import.meta.filename === process.argv[1]) {
  const rs = await collect({});
  console.log(rs.length, 'reqs'); console.log(rs.slice(0, 2));
  const by = {};
  for (const r of rs) by[r.model] = (by[r.model] || 0) + r.input + r.cacheRead + r.output;
  console.log(by);
}
