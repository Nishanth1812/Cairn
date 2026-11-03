# `cairn waymark stats --json`

Shape returned by `getStats` (in `src/waymark/telemetry/stats.ts`), printed as JSON when `--json` is passed (and included in the `data` field of the `stats` command result). Counts come from the `tool_calls` table, written by real calls only: `search` and `context` when the CLI runs, `Read`, `Grep` and `Glob` from the PreToolUse hook in an indexed repo, and `hook_prompt` when the prompt hook injects locations.

Top-level fields:

- `adoption` — `{ percent, weftCalls, nativeCalls }`
  - `percent` — share of code lookups that went through Waymark: `weftCalls / (weftCalls + nativeCalls)`, rounded; `null` when there were no lookups
  - `weftCalls` — `search` and `context` calls
  - `nativeCalls` — sweeps only: `Grep`, `Glob`, grep/rg/find in Bash, and whole-file reads of large files. Counted whether or not the optional advisory is shown. Ranged `Read`s are the intended follow-up to a search and are not counted.
- `toolTokens` — `{ calls, returned }` for `search` and `context`; `returned` is the estimated tokens of what the caller receives: the text the CLI prints (`formatSearch` / `formatContext`), or the JSON payload under `--json`
- `promptHook` — `{ injections, returned }` for `hook_prompt`
- `quality` — whether Waymark answered, from rows already written
  - `followThroughPercent` — of the lookups that returned files (in a known session), the share followed by a `Read` of one of those files before the session's next lookup; `null` until lookups with recorded paths exist. Higher is better. The returned and read paths are stored in `tool_calls.paths`.
  - `fallbackPercent` — share of `search`/`context` calls (in a known session) after which the same session ran a sweep before its next Waymark lookup; `null` when there were none. Lower is better.
  - `feedback` — `{ miss, bad_output, error }` counts from `cairn waymark feedback`
- `byRepo` — up to ten `{ repo, lookups, returned }` rows, most-used first, for `search` and `context`

`cairn waymark feedback list [--since 7d] [--limit N]` prints the filed feedback, newest first.

Window: `--since` accepts a duration such as `1d`, `7d` or `30d`. Omitting it applies no time filter.
