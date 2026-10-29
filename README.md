# Cairn

One command for the developer tools I use every day with AI coding agents.

| Command | What it does | Source |
|---|---|---|
| `cairn waymark` | Local-first code index for coding agents (CLI; an MCP server comes back later), with hooks and task checkpoints (was Weft) | [src/waymark](src/waymark) |

```sh
npm ci && npm run build
node bin/cairn.mjs waymark context "where is auth handled"
node bin/cairn.mjs doctor                # check the setup
```

`npm link` puts `cairn` on your PATH. Node 24 or newer.

## Layout

```
bin/cairn.mjs   the command; runs a tool in-process
src/waymark/    TypeScript, bundled to dist/waymark.js
tests/          Waymark tests
```

## Licence

GPL-3.0-only.
