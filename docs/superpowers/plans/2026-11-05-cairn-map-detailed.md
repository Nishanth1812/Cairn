# Cairn Map Detailed Plan

**Decision:** Treat mapping as a capability of Cairn Context, not a separate index or product in the first release. Follow the [shared roadmap](2026-11-05-cairn-roadmap.md) and [Context plan](2026-11-05-cairn-context-detailed.md).

**User outcome:** Understand where a symbol is defined, where it is used, and which nearby code or tests may be affected without reading an entire repository.

## Current state and alternatives

Context already indexes symbols and reference sites and offers `search --refs`. `src/waymark/context/search.ts` can fall back to spelling-based reference matching; same-name declarations can cause false positives and dynamic relationships can be missed. Do not call this compiler-accurate. [Serena](https://oraios.github.io/serena/01-about/035_tools.html) uses language servers, and [Sourcegraph](https://sourcegraph.com/docs/code-navigation/precise-code-navigation) offers precise indexing when configured; compare with them and native editor search on the user's actual languages.

## Work packages

1. **Define the questions:** [ ] Collect real examples involving definitions, callers, imports, re-exports, tests and change impact. Include ambiguous names, dynamic behavior, multiple languages and empty results; identify the source evidence that would answer each.
2. **Measure current references:** [ ] Run current `--refs`, native search, and one suitable existing alternative on frozen examples. Score required sites found, false matches, time and follow-up calls. Explicitly label heuristic and stale results.
3. **Improve the current path:** [ ] Address the largest demonstrated gap inside the existing index/search boundary. Prefer existing symbol and reference sites; show path, line, kind and how the result was obtained. Ensure output can be expanded through existing reads.
4. **Optional precise source:** [ ] Only if measurements justify it, use an installed language server or a supported index for one relevant language. Keep heuristic search as a labeled fallback when it is unavailable. Do not install or run a server automatically. Specify how versions, workspace identity, failures and freshness are handled before adding it.
5. **Impact output:** [ ] Present potential affected sites as leads, not a complete list of runtime effects or required tests. Do not claim call hierarchy or dependency coverage outside what the data supports.

## Likely ownership

Existing owners are `src/waymark/core/referenceSites.ts`, `src/waymark/indexer/`, `src/waymark/context/search.ts`, and the CLI search output. Extend the actual responsible owner after tracing callers. Index schema changes need a migration and rollback plan; tests belong with existing reference and index tests in `tests/waymark/`.

## Verification and acceptance

- [ ] Test same-name symbols in separate files, imports/re-exports, comments and strings, unsupported languages, dynamic calls, no result, deleted/renamed files, and stale or absent index generations.
- [ ] If using precise data, test absent server, startup failure and conflicting heuristic results; the report identifies source and uncertainty.
- [ ] On held-out examples compare true sites found and false positives, elapsed time and follow-up reads. Do not trade away necessary callers merely to shorten output.
- [ ] Existing `search --refs` output remains compatible or has an explicit migration path.

**Stop:** Do not add a separate graph database, architecture diagram generator, or every-language parser unless the measured task needs it.
