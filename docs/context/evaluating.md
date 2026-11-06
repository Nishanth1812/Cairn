# Is Cairn Context helping?

Cairn Context does not estimate savings; it reports only what it observed. Read `cairn context stats --since 7d` weekly:

| Signal | Healthy | Act when |
|---|---|---|
| Adoption | rising or steady above ~70% | falling: agents are ignoring it |
| Read a returned file after a lookup | rising, or steady above ~50% | low: results are not what agents open; compare with the `miss` queries |
| Fell back to a sweep after a lookup | falling | above ~30%: results are missing what agents need; run `cairn context feedback list --since 7d` and read the `miss` queries |
| Feedback `miss` / `bad_output` / `error` | few, and shrinking | a repeated query: fix ranking or indexing for it |
| Cairn Context returned tokens per call | a few hundred to ~1.5k | creeping up: output is bloating |

These show Cairn Context is used and answers. They do not show that your work got faster or cheaper, because Claude Code's own token use is outside this database. To check that:

1. Pick 3-5 repeatable tasks (for example "find where X is handled and change it").
2. Run each once with Cairn Context on and once with it off (`cairn context doctor` shows hooks; remove them for the control run, then restore with `cairn context setup`).
3. Compare total tokens/cost from the harness's own usage report, turns taken, and whether the result was right.

Judge it on those task comparisons plus the fallback rate, not on adoption alone.

## Retrieval regression check

`cairn context bench retrieval` (run from this repo) replays `tests/cairn/golden/queries.json` and reports whether an expected file appears in the top 1, 3 or 5 results. Run it before and after any ranking or indexing change. On 2026-11-04, the local tuning set had 47/67 hits at 1, 57/67 at 3 and 62/67 at 5. The benchmark runs against this repo's own code, so changes to the corpus or queries can shift the results.

These are tuning queries, not independent evidence of performance on other repositories. The fixture also has held-out queries for `p-limit`; register a checkout named `p-limit`, then run `cairn context bench retrieval --repo p-limit` from this repo to evaluate them. Inspect misses before changing ranking, and compare held-out results rather than tuning only to this fixture.
