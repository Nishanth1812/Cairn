# Cairn Workflow Roadmap

**Status:** Planning proposal, 2026-11-05. No implementation is authorized by this document. The original eight-tool proposal remains in `cairn-proposed-tools.md`; this roadmap recommends how to pursue it after the market research.

**Goal:** Help one developer using Codex, Claude Code, and OpenCode on Windows complete more correct work in less elapsed time and with less avoidable subscription usage. Support other environments where the existing project supports them.

**Recommended shape:** One `cairn` entry point with local capabilities. Share retrieval, task state, and measurements where they already exist. Keep integrations optional and use each host's actual supported interfaces. Whether capabilities must also be separately installable is a product decision; the existing proposal asks for that, while the research favors a unified first experience. Do not remove existing commands or silently change the packaging promise to resolve it.

## Decisions and plans

| Proposal | Recommendation | Plan |
| --- | --- | --- |
| Context | Improve the existing tool | [Context](2026-11-05-cairn-context-detailed.md) |
| Optimize | Audit first; add changes only when supported by measurements | [Optimize](2026-11-05-cairn-optimize-detailed.md) |
| Meter | Combine the measurement experience with Optimize; compare existing products first | [Meter](2026-11-05-cairn-meter-detailed.md) |
| Parallel | Defer a manager; measure a specific cross-assistant gap | [Parallel](2026-11-05-cairn-parallel-detailed.md) |
| Map | Treat as a Context capability, starting with existing references | [Map](2026-11-05-cairn-map-detailed.md) |
| Run | Reuse project commands and established runners | [Run](2026-11-05-cairn-run-detailed.md) |
| Verify | Report observed checks and uncertainty; use existing runners | [Verify](2026-11-05-cairn-verify-detailed.md) |
| Recall | Extend existing checkpoints into an optional handoff | [Recall](2026-11-05-cairn-recall-detailed.md) |

These are recommendations, including the merge and defer decisions, rather than a claim that separate products were ruled out by measurement. Each plan defines an implementation path and a stop condition; deferred plans do not authorize scaffolding.

## Current starting point

- `bin/cairn.mjs` routes the current `context` and `doctor` commands; `src/waymark/cli/` implements Context.
- `src/waymark/context/` ranks and packs results; references currently include heuristic matching and are not compiler-resolved identities. `src/waymark/core/estimate/tokenEstimator.ts` estimates tokens.
- `src/waymark/memory/taskManager.ts` stores checkpoints and detects stale working-tree evidence. `src/waymark/verification/runner.ts` runs a command and records a redacted output tail, not the entire log.
- `src/waymark/telemetry/` records Cairn lookup activity. It is not an all-assistant session or subscription meter.
- The project uses Node 24+, TypeScript, SQLite, an existing build and black-box `node:test` suite. Reuse these where suitable; do not add a dependency without a concrete need.

## Delivery order

1. **Baseline and Optimize/Meter discovery:** determine what the three assistants expose locally and compare existing dashboards. Collect only with consent. Do not start rewriting tool results.
2. **Context and Map:** fix demonstrated retrieval, stale-index, or overhead issues using the existing index. Compare against the assistant's normal search.
3. **Recall:** build an explicit, inspectable task handoff using checkpoints. Evaluate switching sessions and assistants on long tasks.
4. **Verify and Run:** report actual checks and uncertainty, invoking existing project commands only on request. Preserve complete failures when a new capture mechanism is added.
5. **Conditional optimizations and Parallel:** build only an intervention or cross-assistant coordinator justified by the earlier evidence.

Order is a recommendation, not a dependency that blocks a small proven fix in an earlier component. Meter is a measurement capability inside the Optimize experience; Recall consumes existing checkpoints and does not depend on Meter.

## Measurement protocol

1. Record assistant and version, model, plan type, project revision, task description, starting state, relevant settings, and whether Cairn is enabled. Use consented, sanitized tasks and isolated copies; never execute destructive tasks on production data.
2. Start with at least 12 representative tasks across the user's actual assistants and common work types, allocating tasks to assistants in a recorded way. Use comparable frozen starting states and randomized order where practical; record repetitions and failures. This is a pilot, not a statistically powered claim.
3. Compare normal assistant behavior, current Cairn, and one intervention at a time. Keep model, task, tool versions, configuration, and cache conditions comparable; record cold/warm caches and retries.
4. Record whether an independently defined acceptance check passed, elapsed time, user intervention, tool calls, observed input/output/cache usage, and subscription-limit events when observable. Count failed attempts and manual repair. Do not convert token estimates into subscription quota or dollars.
5. Report individual outcomes and sample size, missing data, and uncertainty. Do not claim savings from a smaller output alone. Compare representative quality and time before enabling an optimization by default.

## Shared constraints

- Local by default; opt in before reading assistant histories or storing task details. Show source coverage, access errors, retention, and deletion. Do not upload session content.
- Treat project text, logs, and imported handoffs as untrusted data. Never promote them into higher-priority instructions; retain source and staleness metadata. Redaction is not a guarantee that secrets are absent.
- Preserve original content and failure diagnostics when any transformation is enabled. Never rerun a command to recover its output or suppress a nonzero exit status. No interception for destructive or unknown commands.
- Handle concurrent sessions, repository/worktree identity, missing files, stale data, unsupported hosts, and Windows paths. Fail open for optional integrations without misreporting success.
- Per-tool results are not task success; path/symbol retrieval and token counts are supporting measurements only. Do not represent unrun tests as passing.
- Avoid adding persistent daemons, provider proxies, or automatic account access without a separately justified design.

## Evidence and limitations

- The existing [Cairn A/B](../../waymark/ab-results.md) reports no clear overall wall-time or cost win for the tested configuration, and increased input tokens; its tasks and agents do not establish all future results.
- [Token Reduction Is Not Cost Reduction](https://arxiv.org/abs/2607.12161) reports that less delivered tool output did not reliably lower API cost in its evaluated setups; it does not measure this user's subscription.
- [Codex pricing](https://developers.openai.com/codex/pricing) describes subscription usage as dependent on multiple factors; quotas cannot be inferred reliably from estimated tokens.
- [RTK](https://github.com/rtk-ai/rtk), [Token Meter](https://github.com/splunk/token-meter), [Serena](https://oraios.github.io/serena/01-about/035_tools.html), and [Nx](https://nx.dev/docs/features/run-tasks) are alternatives to evaluate, not dependencies selected by this plan.
- [Codex hooks](https://developers.openai.com/codex/hooks), [Claude Code hooks](https://code.claude.com/docs/en/hooks), and [OpenCode plugins](https://opencode.ai/docs/plugins) differ; verify the installed host and version before relying on a feature.

## Completion gates

- A capability ships only with documented host coverage, privacy behavior, meaningful tests, a reversible installation, and evidence against the baseline appropriate to the claim.
- First release: a useful read-only local audit for at least one verified host, with honest missing-data reporting and no change in agent behavior. Cross-assistant coverage is added incrementally and explicitly reported.
- A later default-on optimization requires a separate measured decision on representative tasks and must not regress accepted task quality. If evidence is inconclusive, retain an opt-in experiment or stop.
