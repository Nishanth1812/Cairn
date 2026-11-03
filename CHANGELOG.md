# Changelog

## Unreleased

- Claude Code setup now installs SessionStart, UserPromptSubmit, Stop and PreCompact hooks by default; per-tool PreToolUse hints require `--tool-hints`. Re-running setup removes old Cairn PreToolUse entries while preserving other tools' hooks, and stats mark unobserved native sweeps as unavailable.
- Claude Code PreToolUse hooks are advisory-only: they never deny tool calls, and at most two optional hints are shown per session for broad searches in indexed repos. Feedback is optional and unlocks nothing.
- Concurrent first-use registration and index refreshes now share one writer; SQLite constraint errors are no longer reported as disk-full failures.
- Lookups refresh file changes before answering, wait a bounded time for an active index writer, and label last-generation results if that wait expires.
- FTS search no longer stores per-chunk copies of search text and symbol names; indexing estimates free space, reports storage failures clearly, and rolls back failed generations.
- `search --refs <symbol>` lists individual import, re-export, call, and module-level sites grouped by file and enclosing symbol; capped lookup modes report omitted result counts. Reference matching uses identifier spelling, so same-name collisions can add results.

## 0.1.1

- FTS gives file paths and symbol names their own weighted fields; migration v9 rebuilds the index while preserving existing chunks. Oversized symbol chunks split at blank lines or statement boundaries, and reference edges back `search --refs <symbol>` plus a small ranking boost for popular definitions.
- Retrieval benchmark reports hit@1/3/5, packed-token mean/max, index time and DB size for 67 Cairn tuning queries and 10 held-out public `p-limit` queries, excluding its own golden file from retrieval. Cairn improved from 64.2%/85.1%/91.0% to 71.6%/89.6%/95.5%; mean/max packed tokens fell from 604/1,513 to 527/1,194. The public suite moved from 30%/100%/100% to 40%/100%/100%; mean/max tokens fell from 386/918 to 363/538. Forced indexing median rose from 622 ms to 1,146 ms; fresh single-repo DB size fell from 2.92 MB to 209 KB.
- Structural class and function definition queries now return matching symbols, and exact-match excerpts keep the match visible on long lines.
- Search finds words inside camelCase names (`invoice` finds `computeInvoiceTotal`) and matches word stems (`indexing` finds `index`). Existing repos re-index once, automatically. Benchmark 17 to 19 of 25.
- `search --json` returns the matched line instead of the whole chunk (about 6x smaller: on 40 real queries, the same build comparison went from 8,881 to 1,424 tokens on average; the printed text form stayed at about 620-640), and stats count the tokens a caller really received, including under `--json`.
- Result labels name the symbol the query is about, not the first symbol the chunk mentions. A search where no hit holds every word now says so and points at `--exact` and `--kind`.
- `context` shows a window around the match when a hit is bigger than the budget (one long function used to be dropped, so the answer could come back empty). A rebuild no longer leaves `dist` missing while hooks run.
- Every lookup mode (`search`, `--exact`, `--kind`, `context`) stops at `--budget` tokens (default 1500) and says how many results were left out, so a broad query can no longer return tens of thousands of tokens.
- README rewritten for first-time users; added CONTRIBUTING and SECURITY.
- Package renamed to `@nishanth1812/cairn` (the unscoped `cairn` name is taken on npm); the command is still `cairn`.

## 0.1.0

- Waymark: local code index, ranked `search`/`context`, exact and by-kind lookups, task checkpoints, hooks for Claude Code, instructions for Codex and OpenCode, `stats`, `feedback`, `doctor`, retrieval benchmark.
