# Token accounting research

Verified 2026-10-21 against official docs (URLs inline). "Total prompt" = every input token the model saw.

## 1. Token accounting per vendor

| Vendor / field | Cache read | Cache write | Fresh input | Total prompt |
|---|---|---|---|---|
| Anthropic `usage.cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens` | separate field | separate field (`cache_creation.ephemeral_5m/1h_input_tokens` sum to it) | `input_tokens` = tokens after last cache breakpoint, EXCLUDES cache | `read + creation + input_tokens` |
| OpenAI `usage.input_tokens_details.cached_tokens` (chat API: `prompt_tokens_details`) | subset of `input_tokens` | GPT-5.6+: `cache_write_tokens` (+`cache_write_tokens_details.ttl_30m/12h`), also INSIDE `input_tokens`; older models: no write field/fee | `input_tokens - cached - cache_write` | `input_tokens` |
| Gemini `usageMetadata.cachedContentTokenCount` | subset of `promptTokenCount` | explicit cache creation billed at creation + storage; not in usage | `promptTokenCount - cachedContentTokenCount` | `promptTokenCount` |
| OpenRouter `usage.prompt_tokens_details.cached_tokens` / `.cache_write_tokens` | subset of `prompt_tokens` | only for models with explicit caching | `prompt_tokens - cached - cache_write` (assumed same convention as OpenAI) | `prompt_tokens` |

Output: Anthropic `output_tokens` already includes thinking (`output_tokens_details.thinking_tokens` is a subset, seen in Claude Code logs). OpenAI `output_tokens` includes `reasoning_output_tokens`. Gemini is the exception: `thoughtsTokenCount` is reported SEPARATELY from `candidatesTokenCount` (output = candidates + thoughts; billed at output rate). OpenRouter `completion_tokens` includes `completion_tokens_details.reasoning_tokens`.
Gemini `toolUsePromptTokenCount` is extra prompt tokens (tool results) and not part of `promptTokenCount`.

### Price multipliers (x base input price)

| Vendor | Read | Write | Notes |
|---|---|---|---|
| Anthropic | 0.1x (Opus 5.5 / Sonnet 5.5: 0.05x; Fable 5.1 / Mythos 5.1: 0.025x) | 5m: 1.25x, 1h: 2x | per Anthropic footnotes; LiteLLM file has `cache_creation_input_token_cost_above_1hr` |
| OpenAI GPT-5.6+ | 0.1x (GPT-6.1 Sol: 0.05x) | 30m: 1.25x, 12h: 2.5x | "not an additive fee": each token is billed at exactly one of uncached / cached / write rate. Min cacheable 1,024 tokens |
| OpenAI older | model-specific cached rate | none | |
| Gemini | implicit cache hits passed through automatically; discount % not stated on the caching page | explicit: storage fee | implicit min prompt 4,096 tokens on newer Flash/Pro |
| OpenRouter | provider's rate | provider's rate | `usage.cost` is the authoritative charge in credits (USD) |

Sources:
- Anthropic: https://platform.claude.com/docs/en/build-with-claude/prompt-caching ("total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens")
- OpenAI: https://developers.openai.com/api/docs/guides/prompt-caching (cost helper: ordinary input = `input_tokens` - `cached_tokens` - `cache_write_tokens`)
- Gemini usage: https://ai.google.dev/api/generate-content#UsageMetadata ("promptTokenCount ... includes cached content") ; caching: https://ai.google.dev/gemini-api/docs/caching
- OpenRouter: https://openrouter.ai/docs/use-cases/usage-accounting (`cost`, `cached_tokens`, `cache_write_tokens`, `reasoning_tokens`, `cost_details.upstream_inference_cost`)

Not verified from docs (inferred): OpenRouter `prompt_tokens` includes cached (follows OpenAI shape); Gemini thoughts-separate rule is from the API field list, confirm on first real Antigravity sample.

## 2. Formulas

Per request, after normalising to the CONTRACT (`input` fresh, `cacheRead`, `cacheWrite`, `output`):

- Total prompt `P = input + cacheRead + cacheWrite`
- Cache hit rate (token-weighted) `= cacheRead / P`. Aggregate by summing numerator and denominator, never by averaging per-request rates.
- Request hit rate (optional) `= count(cacheRead > 0) / count(requests)`.
- Cost `C = input*p_in + cacheRead*p_read + cacheWrite*p_write + output*p_out` (pricing.mjs `cost()`; reasoning is already in `output`).
- No-cache baseline `C0 = (input + cacheRead + cacheWrite) * p_in + output*p_out`.
- Cache savings `S = C0 - C = cacheRead*(p_in - p_read) - cacheWrite*(p_write - p_in)`. Can be negative for a session that writes a lot and never reads (a write costs 1.25x-2x). Report net, and optionally gross read savings and write premium separately.
- Savings % `= S / C0`.
- Prefer tool-reported `costUsd` when present (OpenRouter `usage.cost`, OpenCode `cost`); use the estimate only as fallback, and mark which is which. OpenCode logs `cost: 0` for subscription/Copilot models, so 0 is not a real price: treat `0` with tokens > 0 as "unknown" and estimate.
- Rate caveats: LiteLLM has long-context tiers (`*_above_200k/272k_tokens`), batch, flex and priority tiers; `pricing.mjs` uses the base tier only, so very large prompts are under-estimated. Subscription plans (Claude Max, ChatGPT, Copilot) are not billed per token: the figure is "API-equivalent value".

## 3. Tokens/sec caveats

- `output / durMs` is NOT decode speed. Wall time = queue + TTFT (prefill, which grows with prompt size; large cache hits shorten it) + decode + any streaming stalls. For agent loops the wall time between two logged messages also includes tool execution and user wait.
- Use only a request's own duration when the log has it (Claude Code `durationMs`, OpenCode `time.created/completed`). Never derive from the gap between consecutive messages.
- Reasoning tokens are generated but often not streamed: tokens/sec including reasoning is the honest decode rate, tokens/sec of visible text understates it.
- No TTFT is logged by any of these tools, so a pure decode rate cannot be computed. Show "effective output tok/s" and label it so; skip requests with `output < ~50` (dominated by fixed latency) and `durMs` outliers.
- Parallel tool calls/subagents overlap in time: summing durations over-counts wall clock. Compute per-turn span as `max(ts) - min(ts - durMs)` when a "time spent" figure is needed.
- Codex `token_count` events are cumulative plus `last_token_usage`; use `last_token_usage` or the per-response `token_usage_record.usage` (has `response_id`) to avoid double counting.

## 4. Local log sources

| Tool | Location | Format | Records | Does NOT record |
|---|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd-slug>/<session>.jsonl` (+ subagent files) | JSONL; assistant lines have `message.usage` (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_5m/1h_input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`, `service_tier`), `message.model`, tool_use blocks, `durationMs` on tool results/system lines | exact per-request tokens, model, cwd, session, tool names, 5m vs 1h write split | cost, TTFT; streaming may write the same message id several times (dedupe by message id / requestId, keep last); `~/.claude/stats-cache.json` is aggregate only |
| Codex (also T3 Code) | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (+ `archived_sessions`) | JSONL; `event_msg/token_count` (`total_token_usage`, `last_token_usage`, `model_context_window`, `rate_limits`), `token_usage_record` (per `response_id`, `turn_id`), `session_meta` (cwd, cli_version), `turn_context` carries model | input (includes cached), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, turn ids | cost; per-request wall time (only event timestamps); provider is implicit (OpenAI). Fresh input must subtract BOTH cached and `cache_write_input_tokens` |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite; tables `message`, `part`, `session`) | `message.data` JSON for assistant rows: `modelID`, `providerID`, `tokens{input,output,reasoning,cache{read,write}}`, `cost`, `time{created,completed}`, `path.cwd`, `agent`, `parentID` | per-message tokens across providers (OpenRouter, GitHub Copilot, ...), start/finish time, agent | `cost` is 0 for Copilot / free models; unclear if `input` already excludes cache (OpenCode normalises to Anthropic-style, verify per provider); empty/zero-token rows exist (aborted calls) |
| Antigravity | `~/.gemini/antigravity/conversations/<id>.db` (SQLite: `trajectory_meta`, `steps`, `gen_metadata`, `executor_metadata`), `conversation_summaries.db` (titles, workspace, step counts), `brain/`, `annotations/` | protobuf blobs inside SQLite; metadata columns are opaque | conversation/step structure, titles, timestamps, workspace | token counts, cache counts and model names are NOT in plain columns; any usage must be decoded from protobuf `gen_metadata` (unconfirmed). Treat Antigravity as "bytes + steps" unless a decoder proves otherwise (hence `Req.bytes`) |
| Rates | `%USERPROFILE%\.t3\userdata\usage-model-rates.json` | `{fetchedAtMs, document{model->LiteLLM entry}}` | USD/token incl. cache read/creation | tiers beyond base are present but unused |

## 5. Model-name resolution (pricing.mjs against the rates file)

Resolved: claude-sonnet-5-5, claude-opus-5-5, claude-haiku-5-5, claude-haiku-4-5-20251001, claude-haiku-4.5, anthropic/claude-opus-4.8, openrouter/anthropic/claude-opus-4.8, github-copilot/claude-haiku-4.5, gpt-6-luna, gpt-6-sol, gpt-5.5, gemini-3.8-flash.

Unresolved (add to `OVERRIDES` in pricing.mjs once you know the real model):
- `codex-auto-review` (Codex internal reviewer alias; no rate key contains it)

The rates file has no `openrouter/` keys at all: OpenRouter ids resolve through the underlying vendor name, so any OpenRouter model whose vendor key is absent will be null. Prefer OpenRouter `usage.cost` where logged.
