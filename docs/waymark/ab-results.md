# Cairn default-hook controlled A/B

**Decision:** Cairn-on did not show an overall wall-time saving. Mean B−A was **+2.17 s** (95% CI −5.88 to +7.89 s). B used **31,694 more input tokens** (CI +9,852 to +55,561); its **$0.000456 lower mean cost** and **0.88 more turns** both have intervals crossing zero. The effect differs by repository: Playwright was slower under B; Django’s estimate was faster but noisy.

## Protocol and pilot

- HEAD: `ae00b4e5ba6d7824bf9c049f76b7eaa9f1c76229` on `feat/cairn-single`; snapshot `waymark.js` SHA-256: `6BBF4FDF8FE4BD532F9D5D31E1FC9DF512B49452252BA5144B550C3DD7DEECFC`. Frozen task SHA-256: `008CD8B4DDDE8771D98A2590EF92B8F6679FDD1692D2A73F077BA45010C8462E`. No task file was edited.
- B setup was generated from the snapshot in a fake HOME with the managed CLAUDE.md block. Its settings had exactly SessionStart, UserPromptSubmit, Stop, and PreCompact, with no PreToolUse. All 24 selected B runs invoked SessionStart, UserPromptSubmit, and Stop; PreCompact did not fire. A had empty settings and no guidance.
- Repositories were pre-indexed one at a time in isolated B state: Playwright 2,625 files / 25,341 symbols / 40,517 chunks; Django 5,702 / 45,337 / 66,037. H: had 8,400,760,832 bytes free before the initial indexing.
- The pilot passed: A had zero Cairn calls, zero hooks/output, zero denials. B had one successful context call with indexed paths, hook output, 3 successful expected hook invocations (2.037 s total), and zero denials. B’s Git Bash shim returned exit 0 with results when tested directly.

| Pilot, Playwright route-interception | Wall | API | Total input tokens | Cost | Turns | Tool calls | Cairn calls | Hooks / hook time | Denials |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A | 27.738 s | 26.186 s | 111,149 | $0.008492 | 14 | 13 | 0 | 0 / 0 s | 0 |
| B | 36.304 s | 25.251 s | 95,326 | $0.006411 | 6 | 5 | 1 / 2.037 s | 0 |

The B pilot’s observed hook events were SessionStart, UserPromptSubmit, and Stop; PreCompact was configured but not triggered by this task.

## Scored results

Each cell shows mean (median; sample SD). Deltas are B−A; correctness deltas are percentage points. CIs use 10,000 paired bootstrap samples, resampling task clusters and keeping each task’s three repetitions together (8 task clusters overall; 4 per repository).

### Overall (24 runs per arm)

| Measure | A mean (median; SD) | B mean (median; SD) | B−A mean [paired task bootstrap 95% CI] |
|---|---:|---:|---:|
| Wall time (s) | 30.90s (26.51s; 17.05s) | 33.07s (30.11s; 10.01s) | +2.17s [−5.88s, +7.89s] |
| API duration (s) | 29.14s (24.76s; 16.84s) | 27.45s (26.15s; 9.09s) | −1.69s [−9.43s, +3.62s] |
| Total input tokens | 114,386 (99,734; 61,964) | 146,080 (118,959; 72,465) | +31,694 [+9,852, +55,561] |
| Cost (USD) | $0.007333 ($0.007161; $0.002471) | $0.006877 ($0.006045; $0.002875) | −$0.000456 [−$0.001327, +$0.000539] |
| Turns | 9.42 (8.00; 4.23) | 10.29 (9.00; 4.42) | +0.88 [−0.13, +1.88] |
| Key facts correct | 91.7% (100.0%; 28.2%) | 95.8% (100.0%; 20.4%) | +4.2 pp [−12.5 pp, +25.0 pp] |
| File precision, exact path | 28.4% (18.8%; 29.6%) | 34.2% (27.5%; 25.9%) | +5.9 pp [+0.7 pp, +10.8 pp] |
| File recall, exact path | 49.7% (50.0%; 47.3%) | 71.2% (100.0%; 40.6%) | +21.5 pp [+9.4 pp, +31.3 pp] |
| File precision, suffix/basename | 65.8% (62.7%; 29.6%) | 58.3% (48.5%; 28.6%) | −7.5 pp [−15.1 pp, −1.7 pp] |
| File recall, suffix/basename | 84.4% (87.5%; 16.7%) | 85.8% (100.0%; 16.6%) | +1.4 pp [−4.2 pp, +8.3 pp] |
| Symbol precision | 6.0% (5.2%; 2.9%) | 6.0% (5.3%; 2.7%) | +0.0 pp [−0.3 pp, +0.4 pp] |
| Symbol recall | 94.4% (100.0%; 13.4%) | 93.6% (100.0%; 11.5%) | −0.8 pp [−4.0 pp, +2.3 pp] |

### Playwright (12 runs per arm)

| Measure | A mean (median; SD) | B mean (median; SD) | B−A mean [paired task bootstrap 95% CI] |
|---|---:|---:|---:|
| Wall time (s) | 33.06s (32.55s; 5.60s) | 40.96s (41.97s; 7.87s) | +7.90s [+4.48s, +11.31s] |
| API duration (s) | 31.00s (30.20s; 6.24s) | 34.80s (35.70s; 6.63s) | +3.80s [+1.57s, +6.03s] |
| Total input tokens | 161,450 (146,889; 53,606) | 200,946 (207,750; 63,207) | +39,496 [−3,329, +82,321] |
| Cost (USD) | $0.009092 ($0.008804; $0.002129) | $0.009218 ($0.009480; $0.002005) | +$0.000126 [−$0.001411, +$0.001708] |
| Turns | 12.83 (12.50; 3.24) | 13.33 (13.50; 4.19) | +0.50 [−1.17, +2.67] |
| Key facts correct | 83.3% (100.0%; 38.9%) | 91.7% (100.0%; 28.9%) | +8.3 pp [−25.0 pp, +50.0 pp] |
| File precision, exact path | 10.4% (0.0%; 23.8%) | 15.6% (17.9%; 15.4%) | +5.2 pp [−2.4 pp, +10.8 pp] |
| File recall, exact path | 18.8% (0.0%; 38.6%) | 47.9% (50.0%; 45.8%) | +29.2 pp [+25.0 pp, +33.3 pp] |
| File precision, suffix/basename | 52.5% (44.2%; 19.4%) | 42.2% (41.4%; 8.4%) | −10.3 pp [−23.1 pp, +0.8 pp] |
| File recall, suffix/basename | 77.1% (75.0%; 15.5%) | 77.1% (75.0%; 15.5%) | +0.0 pp [+0.0 pp, +0.0 pp] |
| Symbol precision | 4.3% (4.2%; 1.1%) | 4.4% (4.7%; 0.9%) | +0.1 pp [−0.2 pp, +0.4 pp] |
| Symbol recall | 97.2% (100.0%; 9.6%) | 97.2% (100.0%; 9.6%) | +0.0 pp [+0.0 pp, +0.0 pp] |

### Django (12 runs per arm)

| Measure | A mean (median; SD) | B mean (median; SD) | B−A mean [paired task bootstrap 95% CI] |
|---|---:|---:|---:|
| Wall time (s) | 28.75s (23.27s; 23.79s) | 25.19s (24.39s; 3.47s) | −3.56s [−16.26s, +4.50s] |
| API duration (s) | 27.28s (21.87s; 23.37s) | 20.10s (19.35s; 3.31s) | −7.19s [−20.22s, +0.93s] |
| Total input tokens | 67,322 (59,483; 17,935) | 91,213 (84,095; 20,408) | +23,891 [+15,000, +32,783] |
| Cost (USD) | $0.005574 ($0.005227; $0.001219) | $0.004535 ($0.004691; $0.001143) | −$0.001039 [−$0.001621, −$0.000419] |
| Turns | 6.00 (5.50; 1.21) | 7.25 (7.50; 1.76) | +1.25 [+0.83, +1.67] |
| Key facts correct | 100.0% (100.0%; 0.0%) | 100.0% (100.0%; 0.0%) | +0.0 pp [+0.0 pp, +0.0 pp] |
| File precision, exact path | 46.3% (50.0%; 23.6%) | 52.9% (60.0%; 20.3%) | +6.5 pp [+0.0 pp, +13.3 pp] |
| File recall, exact path | 80.6% (100.0%; 33.2%) | 94.4% (100.0%; 13.0%) | +13.9 pp [−5.6 pp, +33.3 pp] |
| File precision, suffix/basename | 79.0% (100.0%; 32.8%) | 74.3% (90.0%; 32.8%) | −4.7 pp [−9.3 pp, −1.0 pp] |
| File recall, suffix/basename | 91.7% (100.0%; 15.1%) | 94.4% (100.0%; 13.0%) | +2.8 pp [−8.3 pp, +16.7 pp] |
| Symbol precision | 7.7% (7.7%; 3.1%) | 7.7% (6.9%; 2.9%) | −0.1 pp [−0.6 pp, +0.8 pp] |
| Symbol recall | 91.7% (100.0%; 16.3%) | 90.0% (100.0%; 12.4%) | −1.7 pp [−7.5 pp, +4.6 pp] |

**Noise check.** Overall wall, cost, turns, key-fact score, lenient file recall, and symbol precision/recall intervals include zero. Input-token increase and strict-path file precision/recall intervals exclude zero. Playwright wall time increased by 7.90 s (CI +4.48 to +11.31 s); Django’s −3.56 s estimate crosses zero (CI −16.26 to +4.50 s).

## Hook and tool measurements

- A/B tool calls by type: A Read 117, Grep 83, Glob 2 (202 total); B Bash 58, Grep 59, Read 106 (223 total). Permission denials: 0 in both arms.
- B ran 72 hooks across 24 runs (3/run), totaling 29.381 s (1.224 s/run): SessionStart 24, UserPromptSubmit 24, Stop 24. No PreToolUse events fired.
- Selected B transcripts contained 31 Bash tool uses with Cairn commands and 36 Cairn invocations. All 36 were replayed through the isolated Git Bash shim with pipefail; all exited 0 and returned indexed results. No B Cairn harness failures.
- Wall decomposition from stream timing: API duration changed −1.69 s/run; measured tool wait changed +4.35 s/run; remaining wall outside those measures changed −0.48 s/run, summing to the +2.17 s wall delta. Within B, debug logs measured 1.22 s/run in hooks and tool timestamps measured 2.61 s/run waiting on Cairn Bash commands. These are sub-measures with overlapping timing boundaries and should not be added again to the decomposition.

## Comparison with earlier hook sets

| Setup | Wall A→B; B−A | Input tokens A→B; B−A | Cost A→B; B−A | Turns A→B; B−A | B hooks/run; hook time/run |
|---|---|---|---|---|---|
| ab3 strict per-tool hooks (24/arm) | 41.2→53.4 s; +12.2 s [−3.9,+24.8] | 122,929→251,973; +129,043 [+76,911,+184,247] | $0.00761→$0.00931; +$0.00170 [+$0.00056,+$0.00291] | 10.2→15.0; +4.8 | 17.5; 5.91 s |
| ab5 advisory per-tool hooks (16/arm) | 30.8→35.3 s; +4.5 s [−2.7,+12.8] | 146,727→125,168; −21,559 [−60,962,+13,275] | $0.00850→$0.00663; −$0.00187 [−$0.00300,−$0.00092] | 12.3→9.4; −2.9 | 11.4; 2.89 s |
| ab6 default hooks (24/arm) | 30.90→33.07 s; +2.17 s [−5.88,+7.89] | 114,386→146,080; +31,694 [+9,852,+55,561] | $0.007333→$0.006877; −$0.000456 [−$0.001327,+$0.000539] | 9.42→10.29; +0.88 [−0.13,+1.88] | 3.0; 1.22 s |

The default set cut measured hook time versus ab5 and removed its PreToolUse calls, but did not produce a statistically clear overall wall or cost saving.

## Transcript findings and product changes

1. **Trim broad retrieval results.** Playwright tracing B averaged 78,845 more input tokens, 3.67 more turns, and 10.35 s more wall time per task repetition, without improving the frozen fact score. Return a compact joined trace for multi-file questions and keep verbose chunks out of the prompt unless requested.
2. **Keep hook startup cheap.** The default’s three fired hooks used 1.224 s/run on average, alongside 2.608 s/run waiting on Cairn Bash queries. Reduce process startup or combine work within the existing events while keeping the same default event set.
3. **Preserve literal facts and paths.** In Playwright download rep 1, B omitted the frozen literal `GUID` while A included it; across all runs key-fact scores were 95.8% B vs 91.7% A with a wide interval. Add answer guidance that retains explicitly required identifiers and names paths consistently.

Scoring was blind string matching. Strict file matching requires an exact normalized full path; lenient matching also accepts a shortened suffix or basename. This matters: strict file recall improved 21.5 pp, while lenient recall changed only 1.4 pp. Symbols were scored from identifier mentions and facts from normalized literal substrings, not semantic review.

## Validity, spend, and cleanup

- The original Playwright tracing r3 A run had `wall_ms=300000` but `actual_wall_ms=3834596` (63m 54.6s), consistent with the machine-sleep interval. Its entire original A/B pair was excluded. That pair was rerun once as a fresh pair; the selected retry had both arms exit 0, match wall/actual wall, and finish below 300 s. The interrupted initial Django bulk-create r1 B attempt had a debug log but no completed output/metadata; its original A was paired with a completed B retry. The final Django middleware r2 pair used a symmetric $0.04 per-run cap rather than $0.05 to keep the global spend bound below $0.55; both returned costs stayed below $0.01, so the lower cap did not bind.
- Selected analysis: 48 scored runs (24 pairs), 3 reps per task/arm, all with `wall_ms == actual_wall_ms` and ≤300 s. The original over-cap pair and the interrupted B attempt are excluded. No selected run timed out or errored.
- New spend including pilot and all retries: $0.36567740 reported, plus at most $0.10 for the two runs without returned costs; conservative upper bound **$0.46567740**, below the $0.55 cap.
- H: free space was 8,400,760,832 bytes before initial indexing and 8,064,581,632 bytes after cleanup (−336,179,200 bytes net). Cleanup removed the isolated homes/configs, credential copies, state/cache, shim, temp files, and dist snapshot; verification found zero remaining credential files and no cleanup targets. Raw run results, reports, scripts, and the frozen task copy remain under `.test-tmp\ab6`.
- No source or test files were edited; no commit, push, merge, or publish. `npm run check` was not run because no repository code change was made.

## Reproducibility artifacts

- `results.json`: per-run metrics, correctness scores, summaries, and bootstrap intervals.
- `meta.jsonl`, `schedule.json`, `analysis-pairs.json`, `replacement-pairs.json`: run ledger and selected pairing.
- `run-once.ps1`, `run-resume.ps1`, `analyze-ab6.mjs`, `replay-selected.ps1`: execution, analysis, and Cairn-call replay.
- `pilot-report.json`, `replay-status.jsonl`, `cleanup-status.json`: pilot, replay, and cleanup evidence.
