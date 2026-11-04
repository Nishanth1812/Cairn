# Changelog

## 0.1.0

- Uninstall preserves user instruction text surrounding Cairn's managed blocks.
- Indexed `search --refs` sites; 15-run warm median/p95 ms on pinned clones (8975eb9→current): Playwright 7,348/8,653→254/328, Django 1,541/1,829→350/410. 40 interleaved Playwright `context` runs (31fd5bb→current): 332/473→337/435. All 16 compared reference output hashes matched.
- Warm lookup benchmark (15 runs, median/p95 ms; base 31fd5bb → current): Playwright search 433/893→409/613, context 369/503→421/627, --refs 5,275/5,913→3,823/4,853; Django search 505/841→404/431, context 560/991→375/455, --refs 2,286/2,683→1,908/3,260. Reference results were identical; retrieval hit@1/3/5 remained 70.15/89.55/95.52.
- The default context budget is 1,000 tokens; hit@1/3/5 stayed at 70.15/89.55/95.52 on the clean retrieval corpus. Context combines adjacent excerpts from the same file, and text search skips comment-only matches and blank rows. Hooks skip prompts without a named code entity, and SessionStart leaves indexing to lookups.
- Claude Code setup now installs only the managed instruction block by default; `--hooks` opts into lifecycle hooks, and `--tool-hints` also installs the PreToolUse hint. Re-running setup without either flag removes Cairn hooks and preserves other tools' hooks. Stats mark unobserved native sweeps as unavailable.
- Context now leads with a matching symbol definition and caller locations before supporting snippets; JSON exposes the same answer fields.
- Claude Code PreToolUse hooks are advisory-only: they never deny tool calls, and at most two optional hints are shown per session for broad searches in indexed repos. Feedback is optional and unlocks nothing.
- Concurrent first-use registration and index refreshes now share one writer; SQLite constraint errors are no longer reported as disk-full failures.
- Lookups refresh file changes before answering, wait a bounded time for an active index writer, and label last-generation results if that wait expires.
- FTS search no longer stores per-chunk copies of search text and symbol names; indexing estimates free space, reports storage failures clearly, and rolls back failed generations.
- `search --refs <symbol>` lists individual import, re-export, call, and module-level sites grouped by file and enclosing symbol; capped lookup modes report omitted result counts. Reference matching uses identifier spelling, so same-name collisions can add results.

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

- Waymark: local code index, ranked `search`/`context`, exact and by-kind lookups, task checkpoints, hooks for Claude Code, instructions for Codex and OpenCode, `stats`, `feedback`, `doctor`, retrieval benchmark.
