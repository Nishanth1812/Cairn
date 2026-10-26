# Integration contract

Other tools (Weft) read the Odometer through two stable outputs. Nothing is pushed; callers ask when they need it.

## `token-odometer-stats --json [--range=1d|7d|30d|All] [--no-start]`

Per request (omit `--by`): `time, tool, provider, model, project, session, turn, tools, input, cacheRead, cacheWrite, output, reasoning, costUsd, durMs`.

- `turn` groups every request that answered one prompt (subagents included).
- `tools` is a comma-joined list of the tool names the model called in that request (`""` if none).
- Cost is API-equivalent USD, computed per request from the rates file.

With `--by=day|tool|model|project`: one aggregate row per key (`requests, input, cacheRead, cacheWrite, output, costUsd`).

`--no-start` stops the CLI from launching a background server when none is running.

## `GET /api/data?range=...`

Gzipped JSON `{ cols, dict, rows, status, limits, now }` used by the dashboard. Rows are arrays in `cols` order; string columns (`tool, provider, model, session, project, turn, agent, tools`) are indexes into `dict`.

## `GET /api/weft`

Runs `weft stats --json` (`WEFT_BIN` or `weft` on PATH), cached 60 s. Returns `{ available: false }` when Weft is missing.
