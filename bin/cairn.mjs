#!/usr/bin/env node
// cairn <tool> [args]: the one command. Each tool runs in this process (argv is rewritten to what the tool expects), nothing is spawned.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const CONTEXT = at('../dist/context.js');
const OPTIMIZE = at('../dist/optimize.js');
const HELP = `cairn <tool> [args]

  context   code index, search and task memory                   cairn context "where is auth"
  optimize  read-only, opt-in audit of assistant session data    cairn optimize audit --consent
  doctor    check the install

Run \`cairn <tool> --help\` for a tool's own options.`;

// Hand the process to a tool script: it reads process.argv[1] (its own path) and everything after it.
const enter = async (script, args) => {
  if (!existsSync(script)) { console.error(`cairn: ${script} is missing${script === CONTEXT || script === OPTIMIZE ? ' (run npm run build)' : ''}`); process.exit(1); }
  process.argv = [process.argv[0], script, ...args];
  process.removeAllListeners('warning'); // node:sqlite's experimental notice
  await import(pathToFileURL(script).href);
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') console.log(HELP);
else if (cmd === '--version' || cmd === '-v') console.log((await import('../package.json', { with: { type: 'json' } })).default.version);
else if (cmd === 'context') await enter(CONTEXT, args);
else if (cmd === 'optimize') await enter(OPTIMIZE, args);
else if (cmd === 'doctor') await enter(CONTEXT, ['doctor']);
else { console.error(`cairn: unknown command "${cmd}"\n\n${HELP}`); process.exitCode = 2; }
