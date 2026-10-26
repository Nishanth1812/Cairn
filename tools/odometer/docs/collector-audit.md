# Collector audit

Audited 2026-10-21 against the local read-only stores. Totals are prompt tokens (fresh input + cache read + cache write) plus output, with reasoning included in output.

| Source | Issue | Root cause | Fix | Evidence |
|---|---|---|---|---|
| OpenCode | Newer calls were a known coverage gap; overlap could double count. | The live DB has both legacy `message`/`part` and newer `session_message`; newer-only IDs are absent from the legacy table. | Read v2 assistant messages and legacy messages only where the ID is absent from `session_message`; dedupe copied fork history by request fingerprint. README now reflects this coverage. | Read-only SQLite census: `session_message` 66,261 rows, `message` 46,257; 46,154 overlapping IDs and 20,107 v2-only IDs. `session_part` does not exist. Latest collection: 49,721 Reqs / 5,157,438,530 tokens, all with duration. |
| OpenCode | Reasoning and request timing could be misreported. | Stored `tokens.output` excludes `tokens.reasoning`; `time.completed` may follow tool execution. | Add reasoning to output; prefer `time.streamed`, then last tool-call start, then completion for request duration. | First sample: 10,126 ms duration and tools `read`, `bash`; the overlapping row format was matched by identical IDs and token tuples. |
| OpenCode | Cached input must not be subtracted twice. | OpenCode's usage shape stores input separately from its cache counters, unlike OpenAI's inclusive `input_tokens`. | Preserve `tokens.input` as fresh input and expose `tokens.cache.read/write` separately. | Live sample had `input=786`, `cacheRead=19,712`, confirming the cache count is not a subset of `input` in this normalized log shape. |
| Codex | Cached input can be counted twice; repeated cumulative events can duplicate requests. | Codex `input_tokens` includes cached and cache-write input; logs contain repeated cumulative `token_count` events. | Subtract both cache fields from input; prefer per-response `token_usage_record.usage`; legacy fallback uses `last_token_usage` and skips unchanged cumulative totals. | Sample has fresh input 3,649 + cache 9,088 and output 221 (reasoning 44 is a subset). The self-test output shows the per-model totals below. |
| Codex | Inferred request durations could be zero or span unrelated wait/tool time. | A start marker could be reused, and event timestamps do not provide a dedicated request duration. | Clear the start marker after each request; set zero and intervals above 10 minutes to `null`. Version the cache so old inferred durations are recomputed. | Before the fix, 158/66,452 requests exceeded 10 minutes (maximum 46,258,197 ms). After: no zero or >10 minute durations; p95 47,217 ms, max 583,565 ms. |
| Codex | One prompt could appear under inconsistent turn IDs. | A user prompt can produce multiple model requests and tool calls. | Use the recorded `turn_id` for each response, falling back to the current turn/session only in older records. | One real session had 26 requests for `turn=019d22d2-b86f-78b0-83ca-635cf48ff25a`; all 26 shared that exact ID. |
| Antigravity | `durMs` could represent tool time and gaps between calls as if it were request wall time; one malformed row could discard the rest of a conversation. | Protobuf field `9.8` tracks the gap between calls (can include tool execution); row parsing was inside one conversation-level catch. | Report `durMs: null` because request start/end is unavailable; catch parse errors per `gen_metadata` row. | 214 Reqs / 21,933,652 tokens. A real user turn had 12 requests, all with turn `70d43f8c-f709-4cdb-a273-eb1befd27b59:0` and null duration. |
| Antigravity | Tools are missing from `tools[]`. | The decoded usage metadata identifies token counts and model, but the current protobuf mapping does not identify called tool names. | Not fixed: no verified tool-name field was available in the reverse-engineered schema. | All 214 collected requests currently have `tools: []`; docs/findings identify this as unextracted. |
| Antigravity | Native IDE request duration and project are unavailable. | Native rows omit the ACP timestamp/duration and `.meta` cwd fields. | Not fixed: no trustworthy per-request wall-time or project value can be derived from the fields currently decoded. | Native sample has empty project and null duration. ACP duration field is an inter-call gap, so it is not substituted. |
| Antigravity | Missing or disappearing conversation files could throw. | File enumeration and `statSync` are separate operations, so a database can disappear between them. | Catch missing-file errors before opening the temporary snapshot; absent roots already produce no rows. | `dbs()` skips unreadable roots and `readDb()` returns `[]` if the listed file is gone before its initial stat. |

## Self-test model token totals

- Codex self-test: 66,459 Reqs; total model token totals are recorded in the live snapshot below. The refreshed cache reports 65,401 durations, 0 zero durations, 0 over 10 minutes, p95 47,217 ms, max 583,565 ms.
- Antigravity: `gemini-3.8-flash-n` 1,600,280; `gemini-3.8-flash-high` 1,629,466; `gemini-3.8-flash-medium` 18,703,906.
- OpenCode: 60 provider/model combinations; 5,157,438,530 tokens total in the snapshot below.
- Turn check: a real OpenCode user-message turn had 27 requests, all sharing one turn ID; one Codex turn had 26; one Antigravity user step had 12.

## Limits

Token fields in Antigravity remain inferred from protobuf. The source has no verified tool-name mapping and no request-wall-time field for native rows. `durMs: null` is the contract-compliant value when wall time cannot be derived. OpenCode has no `session_part` table in the audited database; current v2 tool names come from `session_message.data.content`.

## Per-model token totals (live snapshot)

### Codex — 66462 requests, 7,591,964,757 tokens

- gpt-5.6-luna: 30,788 requests; 3,751,218,968 tokens
- gpt-6-luna: 22,442 requests; 2,553,549,079 tokens
- gpt-5.6-sol: 3,430 requests; 359,389,219 tokens
- gpt-5.6-terra: 3,053 requests; 294,855,720 tokens
- gpt-6.1-sol: 1,680 requests; 175,629,859 tokens
- codex-auto-review: 1,681 requests; 123,101,429 tokens
- gpt-5.5: 897 requests; 85,683,066 tokens
- gpt-6-sol: 591 requests; 70,939,053 tokens
- gpt-5.4-mini: 727 requests; 64,960,800 tokens
- gpt-5.4: 517 requests; 46,667,735 tokens
- unknown: 353 requests; 38,364,484 tokens
- gpt-6-astra: 302 requests; 27,575,003 tokens
- gpt-reserve: 1 requests; 30,342 tokens

### OpenCode — 49721 requests, 5,157,438,530 tokens

- stealth/space-bunny-alpha: 4,540 requests; 666,794,998 tokens
- space-bunny-free: 4,042 requests; 595,300,404 tokens
- deepseek-v4-flash-free: 6,904 requests; 547,712,773 tokens
- thinkingmachines/inkling:free: 4,994 requests; 503,653,908 tokens
- muse-spark-1.2-contributor-free: 2,357 requests; 471,356,986 tokens
- muse-spark-1.3-contributor-free: 3,217 requests; 362,547,196 tokens
- deepseek-v4.1-flash-free: 3,410 requests; 277,770,768 tokens
- big-pickle: 2,987 requests; 193,131,935 tokens
- inclusionai/ling-3.0-flash:free: 1,254 requests; 157,607,572 tokens
- minimax-m3.1-flash-free: 575 requests; 137,288,403 tokens
- qwen/qwen3.7-flash: 928 requests; 92,122,701 tokens
- nvidia/nemotron-3.5-super-vl-120b-a12b: 751 requests; 92,108,516 tokens
- fledge-alpha-free: 1,336 requests; 87,639,115 tokens
- mimo-v2.5-free: 1,109 requests; 82,738,506 tokens
- glm-5.3-flash-free: 1,065 requests; 71,832,909 tokens
- ling-3.1-flash-free: 541 requests; 56,970,469 tokens
- gpt-5.4-mini: 650 requests; 56,234,350 tokens
- inclusionai/ling-3.0-flash-vl:free: 566 requests; 55,076,505 tokens
- stealth/union-alpha: 953 requests; 55,025,731 tokens
- cat-jam-free: 1,095 requests; 48,580,000 tokens
- nemotron-3.5-super-vl-free: 662 requests; 48,551,597 tokens
- openai/gpt-5.6-luna: 243 requests; 48,098,838 tokens
- minimax/minimax-m3: 552 requests; 44,901,654 tokens
- apodex/apodex-1.1-mini:free: 554 requests; 44,413,098 tokens
- inclusionai/ling-3.1-flash: 412 requests; 43,804,520 tokens
- hy3-free: 552 requests; 34,873,056 tokens
- x-preview-f-free: 469 requests; 29,789,405 tokens
- nvidia/nemotron-3.5-lightning:free: 172 requests; 28,977,007 tokens
- z-ai/glm-5.3-flash: 239 requests; 26,278,517 tokens
- openrouter/free: 325 requests; 23,039,032 tokens
- mimo-v2.6-flash-free: 251 requests; 22,135,277 tokens
- openai/gpt-5.6-luna-pro: 64 requests; 21,743,961 tokens
- north-mini-code-free: 460 requests; 20,256,783 tokens
- cohere/north-mini-code:free: 204 requests; 18,348,486 tokens
- nvidia/nemotron-3.5-super-vl:free: 228 requests; 16,028,550 tokens
- nvidia/nemotron-3-ultra-550b-a55b:free: 175 requests; 14,105,561 tokens
- poolside/laguna-s-2.1:free: 90 requests; 11,350,910 tokens
- minimax/minimax-m3:free: 114 requests; 10,872,739 tokens
- longcat-2.5-preview-free: 82 requests; 8,270,225 tokens
- claude-haiku-4.5: 153 requests; 6,980,228 tokens
- nvidia/nemotron-3-super-120b-a12b:free: 46 requests; 3,896,489 tokens
- union-alpha: 93 requests; 3,702,157 tokens
- nex-agi/nex-n2.5-pro:free: 33 requests; 2,775,083 tokens
- ling-3.0-flash-free: 22 requests; 2,765,344 tokens
- beam-free: 55 requests; 2,607,853 tokens
- dots-studio/dots-3-note-preview:free: 55 requests; 2,087,000 tokens
- z-ai/glm-5.2: 12 requests; 1,244,826 tokens
- step-5-preview-free: 36 requests; 1,239,554 tokens
- poolside/laguna-m.1:free: 10 requests; 1,016,854 tokens
- deepseek-ai/deepseek-v4.1-flash: 24 requests; 384,121 tokens
- longcat-2.0-free: 11 requests; 315,481 tokens
- z-ai/glm-5.3: 12 requests; 313,970 tokens
- stealth/ox-alpha: 14 requests; 296,172 tokens
- moonshotai/kimi-k3: 10 requests; 171,150 tokens
- nemotron-3-ultra-free: 3 requests; 87,539 tokens
- openai/gpt-oss-20b:free: 3 requests; 67,834 tokens
- liquid/lfm-2.5-2.6b:free: 1 requests; 67,555 tokens
- minimax-m2.5-free: 4 requests; 47,914 tokens
- laguna-s-2.1-free: 2 requests; 38,445 tokens

### Antigravity — 214 requests, 21,933,652 tokens

- gemini-3.8-flash-medium: 144 requests; 18,703,906 tokens
- gemini-3.8-flash-high: 43 requests; 1,629,466 tokens
- gemini-3.8-flash-n: 27 requests; 1,600,280 tokens

