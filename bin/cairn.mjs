#!/usr/bin/env node
// cairn <tool> [args]: the one command. Each tool runs in this process (argv is rewritten to what the tool expects), nothing is spawned.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const WAYMARK = at('../dist/waymark.js');
const HELP = `cairn <tool> [args]

  waymark   code index, search and task memory                   cairn waymark context "where is auth"
  doctor    check the install

Run \`cairn <tool> --help\` for a tool's own options.`;

// Hand the process to a tool script: it reads process.argv[1] (its own path) and everything after it.
const enter = async (script, args) => {
  if (!existsSync(script)) { console.error(`cairn: ${script} is missing${script === WAYMARK ? ' (run npm run build)' : ''}`); process.exit(1); }
  process.argv = [process.argv[0], script, ...args];
  process.removeAllListeners('warning'); // node:sqlite's experimental notice
  await import(pathToFileURL(script).href);
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') console.log(HELP);
else if (cmd === '--version' || cmd === '-v') console.log((await import('../package.json', { with: { type: 'json' } })).default.version);
else if (cmd === 'waymark') await enter(WAYMARK, args);
else if (cmd === 'doctor') await enter(WAYMARK, ['doctor']);
else { console.error(`cairn: unknown command "${cmd}"\n\n${HELP}`); process.exitCode = 2; }
