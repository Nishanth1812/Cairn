# Collector contract

Each collector is an ES module `collectors/<name>.mjs` (Node 24, zero npm deps, `node:` builtins only; `node:sqlite` is available for SQLite).
It exports `export async function collect({ since })` -> `Promise<Req[]>` where `since` is a ms-epoch lower bound (ignore older data). Must NEVER throw if the source dir is missing (return `[]`), must never write to the source, must be read-only and tolerate malformed lines/rows (skip them).
Must also export `export const meta = { id, label, root }`.

One `Req` = one model API request (one assistant response / LLM call), NOT one user prompt.

```
Req = {
  id:        string,   // unique & stable: `${tool}:${something}`
  tool:      string,   // harness: 'claude-code' | 'codex' | 'opencode' | 'antigravity' | 'gemini'
  provider:  string,   // who served it: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'github-copilot' | ...
  model:     string,   // as logged (strip no prefixes)
  session:   string,   // session/conversation id
  project:   string,   // cwd / project basename if known, else ''
  turn:      string,   // id of the user prompt this request belongs to (same value for all requests answering one prompt). If unknowable use session.
  ts:        number,   // ms epoch when the request COMPLETED (or was logged)
  durMs:     number|null, // wall time of the request if derivable, else null
  input:     number,   // fresh (uncached) input tokens
  cacheRead: number,   // input tokens served from cache
  cacheWrite:number,   // input tokens written to cache
  output:    number,   // output tokens INCLUDING reasoning
  reasoning: number,   // subset of output spent on reasoning/thinking (0 if unknown)
  costUsd:   number|null, // cost reported by the tool, else null (we estimate later)
  tools:     string[], // names of tools the model called in this response ([] if none)
  agent:     string    // 'main' | 'subagent' | agent name if known
}
```
`bytes` (size of the logged payload) is no longer surfaced: the dashboard does not show data volume. Collectors may still fill it in; the store ignores it.
Normalisation rules: OpenAI-style `input_tokens` INCLUDES cached tokens -> convert: input = input_tokens - cached. Anthropic `input_tokens` excludes cache -> use as is. Never double count. If a tool logs cumulative totals, emit deltas per request.
Each collector also gets a `node collectors/<name>.mjs` self-test: when run directly (check `import.meta.url`), print count, first 2 Reqs, and total tokens by model.

## Resource contract (so the dashboard stays cheap)
- `meta.watch` (optional): array of `{ path, recursive, match }` where `match` is a RegExp tested against the changed file name. The store rescans the source only when one of these fires (min gap 5-30 s, plus a 10-minute safety rescan). Without it the source is polled every 60 s.
- `collect()` is called often, so a call with nothing new must be cheap: keep parsed data in a module-level variable, stat files instead of re-reading them, and write your disk cache only when something changed.
- Do not copy or open large files (SQLite, JSONL) unless their size/mtime changed.
