# Changelog

## Unreleased

- Search finds words inside camelCase names (`invoice` finds `computeInvoiceTotal`) and matches word stems (`indexing` finds `index`). Existing repos re-index once, automatically. Benchmark 17 to 19 of 25.
- `search --json` returns the matched line instead of the whole chunk (about 6x smaller: on 40 real queries, the same build comparison went from 8,881 to 1,424 tokens on average; the printed text form stayed at about 620-640), and stats count the tokens a caller really received, including under `--json`.
- Result labels name the symbol the query is about, not the first symbol the chunk mentions. A search where no hit holds every word now says so and points at `--exact` and `--kind`.
- Every lookup mode (`search`, `--exact`, `--kind`, `context`) stops at `--budget` tokens (default 1500) and says how many results were left out, so a broad query can no longer return tens of thousands of tokens.
- README rewritten for first-time users; added CONTRIBUTING and SECURITY.
- Package renamed to `@nishanth1812/cairn` (the unscoped `cairn` name is taken on npm); the command is still `cairn`.

## 0.1.0

- Waymark: local code index, ranked `search`/`context`, exact and by-kind lookups, task checkpoints, hooks for Claude Code, instructions for Codex and OpenCode, `stats`, `feedback`, `doctor`, retrieval benchmark.
