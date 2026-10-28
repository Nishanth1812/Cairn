# Integration contract

Other tools (Waymark) read Tally through two stable outputs. Nothing is pushed; callers ask when they need it.

## `cairn tally --json [--range=1d|7d|30d|All] [--no-start]`

Per request (omit `--by`): `time, tool, provider, model, project, session, turn, tools, input, cacheRead, cacheWrite, output, reasoning, costUsd, durMs`.

- `turn` groups every request that answered one prompt (subagents included).
- `tools` is a comma-joined list of the tool names the model called in that request (`""` if none).
- Cost is API-equivalent USD, computed per request from the rates file.

With `--by=day|tool|model|project`: one aggregate row per key (`requests, input, cacheRead, cacheWrite, output, costUsd`).

`--no-start` stops the CLI from launching a background server when none is running.

## `GET /api/data?range=...`

Gzipped JSON `{ cols, dict, rows, status, limits, now }` used by the dashboard. Rows are arrays in `cols` order; string columns (`tool, provider, model, session, project, turn, agent`) are indexes into `dict`; `tools` is a plain comma-joined string.

## `GET /api/waymark`

Runs `cairn waymark stats --json`, cached 60 s. Returns `{ available: false }` when Waymark is missing.

## Per-response cost line (Claude Code)

`cairn tally --last` prints the latest turn (tokens, cost, cache hit, request count) plus today's total; add `--session=<id>` to pin a session.
`--stop-hook` is the same line as a Claude Code `Stop` hook (`{"systemMessage": ...}`, session id read from stdin). It stays quiet unless the turn cost at least `$TALLY_MIN_USD` (default 0.25) or today's total crossed another $5.

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "cairn tally --stop-hook --no-start" }] }] } }
```
