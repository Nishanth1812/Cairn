# Cairn

One command for the developer tools I use every day with AI coding agents. Everything runs from the same package and the same process.

| Command | What it does | Source |
|---|---|---|
| `cairn waymark` | Local-first code index for coding agents (CLI; an MCP server comes back later), with hooks, task checkpoints and cost stats (was Weft) | [src/waymark](src/waymark) |
| `cairn tally` | Tokens, cache, speed and cost across Claude Code, Codex, OpenCode and Antigravity, as a CLI line and a dashboard (was Token Odometer) | [src/tally](src/tally) |

```sh
npm ci && npm run build
node bin/cairn.mjs waymark context "where is auth handled"
node bin/cairn.mjs tally --last          # last turn's tokens and cost
node bin/cairn.mjs tally serve           # dashboard on http://127.0.0.1:4747
node bin/cairn.mjs doctor                # check the setup
```

`npm link` puts `cairn` on your PATH. Node 24 or newer.

## Layout

```
bin/cairn.mjs   the command; runs a tool in-process
src/waymark/    TypeScript, bundled to dist/waymark.js
src/tally/      plain ESM, no dependencies, runs as is
tests/          Waymark tests
```

## Licence

GPL-3.0-only (Waymark). Tally's original MIT licence is kept in [src/tally/LICENSE-MIT](src/tally/LICENSE-MIT).
