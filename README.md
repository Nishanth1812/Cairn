# Cairn

A home for the developer tools I build and use day to day. Each tool lives in its own folder under `tools/`, has its own README, and can be used on its own or alongside the others.

Everything here is Node and TypeScript.

| Tool | What it does | Folder |
|---|---|---|
| Weft | Local-first code index and MCP server for AI coding assistants, with hooks, task checkpoints and token cost stats | [tools/weft](tools/weft) |
| Token Odometer | Local dashboard for tokens, cache, speed and cost across Claude Code, Codex, OpenCode and Antigravity | [tools/odometer](tools/odometer) |

## The `cairn` command

```sh
npm run install:all && npm run build
node bin/cairn.mjs waymark context "where is auth handled"   # code index (Weft today)
node bin/cairn.mjs tally --last                              # last turn's tokens and cost (Token Odometer today)
node bin/cairn.mjs dashboard                                 # open the usage dashboard
node bin/cairn.mjs doctor                                    # check both
```

`cairn` only forwards to the tools, so each still works on its own. Names are moving to Waymark (Weft) and Tally (Token Odometer).

## Using a tool

Clone the repo and work from the tool's folder. Each one installs and runs by itself:

```sh
cd tools/weft && npm install && npm run build
cd tools/odometer && npm start
```

## Adding a tool

Add a folder under `tools/`, give it a README, and add a row to the table above.
