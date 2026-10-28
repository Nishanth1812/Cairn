#!/usr/bin/env node
// cairn <tool> [args]: one front door for the tools in this repo. It only forwards, so each tool still works on its own.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (...p) => fileURLToPath(new URL(p.join('/'), new URL('..', import.meta.url)));
// Each tool: the script to run and any fixed arguments before the user's. `usage` with no args shows today's table.
const TOOLS = {
  waymark: { script: at('tools/weft/dist/cli/index.js'), build: 'npm --prefix tools/weft run build' },
  tally: { script: at('tools/odometer/stats.mjs'), pre: ['--no-warnings'] },
};
const ALIAS = { code: 'waymark', weft: 'waymark', usage: 'tally', odometer: 'tally' };
const HELP = `cairn <tool> [args]

  waymark (code)   code index, search and task memory      e.g. cairn waymark context "where is auth"
  tally   (usage)  tokens, cost and cache across agents    e.g. cairn tally --last
  dashboard        open the Tally dashboard                 (starts it if needed)
  doctor           check both tools

Run \`cairn <tool> --help\` for that tool's own options.`;

const run = (script, args, pre = []) => spawnSync(process.execPath, [...pre, script, ...args], { stdio: 'inherit' }).status ?? 1;
const [cmd, ...args] = process.argv.slice(2);
const name = ALIAS[cmd] ?? cmd;

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); process.exit(0); }
if (cmd === '--version' || cmd === '-v') { console.log((await import('../package.json', { with: { type: 'json' } })).default.version); process.exit(0); }
if (cmd === 'dashboard') process.exit(run(TOOLS.tally.script, ['--open'], TOOLS.tally.pre));
if (cmd === 'doctor') {
  const a = run(TOOLS.waymark.script, ['doctor']);
  const b = run(TOOLS.tally.script, ['--line', '--no-start'], TOOLS.tally.pre);
  process.exit(a || b);
}
const tool = TOOLS[name];
if (!tool) { console.error(`cairn: unknown command "${cmd}"\n\n${HELP}`); process.exit(2); }
if (!existsSync(tool.script)) { console.error(`cairn: ${name} is not built yet. Run: ${tool.build ?? 'npm install'}`); process.exit(1); }
process.exit(run(tool.script, args, tool.pre));
