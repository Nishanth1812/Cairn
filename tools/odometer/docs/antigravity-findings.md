# Antigravity usage data: findings

Verdict: real per-request token counts exist locally. `collectors/antigravity.mjs` emits them (214 Reqs at time of writing; no estimation needed).

## Where (both read-only, copied to a temp dir because of live WAL)
- Native IDE: `~/.gemini/antigravity/conversations/<id>.db`
- T3 Code's Antigravity provider: `~/.t3/userdata/providers/antigravity/<hash>/antigravity-acp/conversations/<id>.db` (+ `<id>.meta` JSON with `cwd`)

Tables: `gen_metadata` (one protobuf row per LLM call), `steps` (one row per step; `step_type` 14 = user input, 15 = planner response), `trajectory_meta`, `executor_metadata`.

## gen_metadata protobuf (reverse-engineered, unofficial)
`row.1` = message. Inside it:
- `4` usage: `2` fresh input, `3` output (= `9` thinking + `10` response), `4` cache write (never seen non-zero), `5` cache read. Verified: call N's input equals call N+1's cache read.
- `19` / `21` model (`21` = actual served model, e.g. `gemini-3.8-flash-high`; native IDE rows only have `19`, e.g. `gemini-3.8-flash-n`).
- `9.4` Timestamp (s + ns) on ACP rows only; native rows fall back to the `steps` row timestamp at `last_step_index`.
- `9.8` Duration; tracks the gap between consecutive calls (may include tool time). Absent on native rows -> `durMs` null.
- `20` key/value pairs: `last_step_index`, `request_id`, `trajectory_id`, `model_enum`.

## Availability
- Tokens: yes (input, output, thinking, cache read). Cache write: field exists, always 0.
- Timestamps: yes (ms on ACP, seconds on native).
- Model: yes. Latency: ACP only, approximate. Cost: no. Tool names: not extracted (in `steps`, not needed yet).
- Turn: derived from the latest `step_type` 14 at or before `last_step_index`.
- Caveats: field meanings are inferred, not documented. The `.meta` file gives project only for T3 conversations; native IDE conversations get project `''`.

## Dead ends
- T3 provider logs `~/.t3/userdata/logs/provider/events.*.log`: Antigravity lines (provider `antigravity`) are JSON-RPC `session/prompt` started/succeeded only, payloads redacted to `{valueType, fieldCount}`. No tokens, no model. Usable only for per-prompt wall time.
- `conversation_summaries.db`, `agyhub_summaries_proto.pb`, `antigravity_state.pbtxt`: titles/previews/step counts only.
- `%APPDATA%\Antigravity` (Electron caches): not searched in depth.

## T3 Code's own store (future collector?)
`~/.t3/userdata/statev2.sqlite` (about 6 GB) table `orchestration_v2_projection_provider_turns`, JSON `payload_json.tokenUsage` = `{usedTokens, maxTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, updatedAt}`.
- Present on 1342/1361 claudeAgent, 488/491 codex, 570/630 opencode turns; 0/25 antigravity turns.
- It is one snapshot per provider turn, and `usedTokens` looks like context size (a final or latest snapshot), not a sum of per-request usage. Good as a cross-check or fallback for harnesses with no native logs, but coarser than the native collectors. `orchestration_v2_events` is empty.
- Not useful for Antigravity; use the conversation DBs above.
