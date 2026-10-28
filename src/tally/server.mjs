#!/usr/bin/env node
// cairn tally serve [port]  |  node --no-warnings server.mjs [port]  ->  http://127.0.0.1:4747
if (+process.versions.node.split('.')[0] < 24) { console.error(`Tally needs Node 24 or newer (node:sqlite); this is ${process.version}.\nGet it from https://nodejs.org or run: npx node@24 server.mjs`); process.exit(1); }
process.removeAllListeners('warning'); // node:sqlite's experimental notice; collectors load after this line, so npx users need no flag
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { setPriority, constants } from 'node:os';
import { execFile } from 'node:child_process';
import { createStore } from './store.mjs';

try { setPriority(constants.priority.PRIORITY_BELOW_NORMAL); } catch {} // never compete with the tools it is measuring

const here = import.meta.dirname;
const PORT = +(process.argv[2] || process.env.PORT || 4747);
const store = createStore();
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
// browsers ask for /favicon.ico on their own; we ship the same gauge as an .ico
const ALIAS = { '/favicon.ico': '/assets/favicon.ico' };

// Waymark's own numbers (savings, adoption), fetched on demand and cached 60 s. Never throws: no Waymark just means no panel.
let waymark = { at: 0, body: '{"available":false}' };
const waymarkStats = () => Date.now() - waymark.at < 6e4 ? waymark.body : new Promise((done) => {
  execFile(process.execPath, [join(here, '..', '..', 'dist', 'waymark.js'), 'stats', '--json'], { timeout: 3000 }, (err, out) => {
    let body = '{"available":false}';
    try { if (!err) body = JSON.stringify({ available: true, ...JSON.parse(out).data }); } catch {}
    waymark = { at: Date.now(), body }; done(body);
  });
});

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/data') {
      const q = url.searchParams;
      await store.touch({ force: q.has('refresh'), live: q.has('live') });
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'cache-control': 'no-store' });
      return res.end(store.payload(q.get('range') || '7d'));
    }
    if (url.pathname === '/api/waymark') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(await waymarkStats());
    }
    const p = ALIAS[url.pathname] || (url.pathname === '/' ? '/index.html' : url.pathname);
    if (p.includes('..')) throw new Error('bad path');
    const file = p.startsWith('/assets/') || p.startsWith('/docs/') ? join(here, p) : join(here, 'web', p);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' ? 404 : 500).end(String(e.message));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Tally on http://127.0.0.1:${PORT}`);
  store.touch().then(() => console.log('ready'));
});
