# `cairn waymark stats --json`

Shape returned by `getStats` (in `src/waymark/telemetry/stats.ts`), printed as JSON when `--json` is passed (and included in the `data` field of the `stats` command result). Counts come from the `tool_calls` table, written by real calls only: `search` and `context` when the CLI runs, `Read`, `Grep` and `Glob` from the PreToolUse hook in an indexed repo, and `hook_prompt` when the prompt hook injects locations.

Top-level fields:

- `adoption` — `{ percent, weftCalls, nativeCalls }`
  - `percent` — share of code lookups that went through Waymark: `weftCalls / (weftCalls + nativeCalls)`, rounded; `null` when there were no lookups
  - `weftCalls` — `search` and `context` calls
  - `nativeCalls` — `Read`, `Grep` and `Glob` calls. Counted before the hook's early returns, so ranged reads and the sweep the trial denies both count.
- `toolTokens` — `{ calls, returned }` for `search` and `context`; `returned` is the estimated tokens of the output the agent received
- `promptHook` — `{ injections, returned }` for `hook_prompt`

Window: `--since` accepts a duration such as `1d`, `7d` or `30d`. Omitting it applies no time filter.
