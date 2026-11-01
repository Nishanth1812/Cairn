# Is Waymark helping?

Waymark does not estimate savings; it reports only what it observed. Read `cairn waymark stats --since 7d` weekly:

| Signal | Healthy | Act when |
|---|---|---|
| Adoption | rising or steady above ~70% | falling: agents are ignoring it |
| Read a returned file after a lookup | rising, or steady above ~50% | low: results are not what agents open; compare with the `miss` queries |
| Fell back to a sweep after a lookup | falling | above ~30%: results are missing what agents need; run `cairn waymark feedback list --since 7d` and read the `miss` queries |
| Feedback `miss` / `bad_output` / `error` | few, and shrinking | a repeated query: fix ranking or indexing for it |
| Waymark returned tokens per call | a few hundred to ~1.5k | creeping up: output is bloating |

These show Waymark is used and answers. They do not show that your work got faster or cheaper, because Claude Code's own token use is outside this database. To check that:

1. Pick 3-5 repeatable tasks (for example "find where X is handled and change it").
2. Run each once with Waymark on and once with it off (`cairn waymark doctor` shows hooks; remove them for the control run, then restore with `cairn waymark setup`).
3. Compare total tokens/cost from the harness's own usage report, turns taken, and whether the result was right.

Judge it on those task comparisons plus the fallback rate, not on adoption alone.

## Retrieval regression check

`cairn waymark bench retrieval` (run from this repo) replays `tests/waymark/golden/queries.json` and reports how many queries return an expected file. Run it before and after any ranking or indexing change. Baseline on 2026-11-01: 18 of 25 queries hit before the lookup module was added. A change that lowers that number needs a reason.

The benchmark runs against this repo's own code, so adding files shifts its numbers. Re-record the baseline when the code changes materially; the current one is 17 of 25 (2026-11-01).
