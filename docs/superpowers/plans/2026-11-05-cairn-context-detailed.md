# Cairn Context Detailed Plan

**Decision:** Improve the existing Context tool. Map is a related capability described in [its own plan](2026-11-05-cairn-map-detailed.md). Follow the [shared roadmap](2026-11-05-cairn-roadmap.md), constraints, and measurement protocol.

**User outcome:** An agent can locate the relevant code, inspect evidence, and expand it quickly without repeatedly exploring the same repository.

## Existing behavior and boundary

`src/waymark/indexer/` maintains repository indexes; `src/waymark/context/search.ts`, `ranker.ts`, and `packer.ts` retrieve, rank, and fit snippets into an estimated budget. The CLI exposes context, ranked search, exact search, definitions, and references. The current `estimateTokens` is a character-based estimate, and references may use spelling-based heuristics. `src/waymark/bench/retrieval.ts` measures file hits and packed size, not completed coding tasks. Preserve existing flags, redaction, index freshness and stale-generation warnings.

## Scope and deliverables

1. **Baseline:** Collect representative lookup tasks: exact identifiers, natural-language discovery, multiple related files, tests, references, no match, and recently edited files. Freeze repository revisions and expected evidence. Compare native agent search with current Cairn using the shared protocol.
2. **Diagnose:** Record ranking misses, incomplete snippets, duplicated exploration, index refresh time, command startup, and agent follow-up calls. Separate retrieval problems from assistant behavior and hook overhead.
3. **Implement one proven improvement:** Extend the existing responsible layer. Candidate improvements include better selection of multi-file evidence, clearer clipped/omitted markers, or reducing measured refresh/startup overhead; choose based on the baseline rather than shipping every candidate.
4. **Expansion:** Ensure results expose paths, line ranges, freshness and estimated-budget status; use existing exact search and targeted file reads for more detail. Do not silently hide failures or invent semantic certainty.
5. **Host setup:** Verify generated Codex, Claude, and OpenCode guidance points to supported installed commands. Preserve user-owned instruction content and avoid forcing every lookup through Cairn.

## Boundaries and likely files

- Retrieval and budget behavior: `src/waymark/context/` and `src/waymark/core/estimate/`; indexing/freshness: `src/waymark/indexer/`.
- CLI and output compatibility: `src/waymark/cli/`, `bin/cairn.mjs`; host instructions: `src/waymark/integrations/`.
- Extend existing tests under `tests/waymark/` and retrieval fixtures under `tests/waymark/golden/`; update `src/waymark/bench/retrieval.ts` only for an explicit new metric.
- Public commands or JSON fields require compatibility review; exact filenames and changes follow the demonstrated issue, not a new independent index.

## Verification and acceptance

- [ ] Demonstrate existing exact, kind, reference and context flows remain compatible.
- [ ] Cover no results, multiple symbols with the same name, long chunks, edited/deleted files, concurrent refresh, sensitive paths, and an unavailable index. Explicitly label heuristic references.
- [ ] Compare retrieval recall and precision, elapsed time, follow-up calls and task success against the baseline on held-out tasks. Include missed required evidence; smaller output alone is not success.
- [ ] Run focused black-box tests and the checks required for changed files; preserve full failure output. An optimization remains opt-in or is discarded if the data does not demonstrate benefit.

## Do not build yet

Do not add embeddings, a persistent graph service, a new tokenizer, or mandatory assistant hooks without evidence that the existing approach fails and the alternative improves the end-to-end task. [Aider's repo map](https://aider.chat/docs/repomap) and [Serena's language-server tools](https://oraios.github.io/serena/01-about/035_tools.html) are comparison points.
