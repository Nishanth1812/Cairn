# `weft stats --json`

Shape returned by `getStats` (in `src/telemetry/stats.ts`), printed as JSON when `--json` is passed (and included in the `data` field of every `stats`/`cache`/`sessions`/`costs` command result).

Top-level fields:

- `sessions` — number of sessions in the window
- `input` — total input tokens
- `output` — total output tokens
- `cached` — total cached input tokens
- `cacheWrite` — total cache-write tokens
- `cost` — total cost in micros (USD × 1e6), or `null` when unavailable
- `adoption` — `{ percent, sessionsUsingWeft, weftCalls, explorationCalls }`
  - `percent` — share of sessions whose tool list contains `weft_`
  - `sessionsUsingWeft` — sessions using Weft tools
  - `weftCalls` — calls to Weft tools
  - `explorationCalls` — calls to Grep/Glob/Read
- `toolTokens` — `{ calls, returned, baseline }` for non-hook tool calls (Weft's own `tool_calls` table)
- `promptHook` — `{ injections, returned, baseline }` for `hook_prompt` tool calls

Window: `--since` accepts `1d`, `7d`, `30d`, or `All` (default `7d`); omitted/`null` means all time.
