# Cairn Optimize Detailed Plan

**Decision:** Build a local, opt-in audit first. Add automatic optimizations only after they demonstrate benefit on the user's work. Meter supplies observations as described in [its plan](2026-11-05-cairn-meter-detailed.md); Context owns retrieval and Recall owns handoff. Follow the [shared roadmap](2026-11-05-cairn-roadmap.md).

**User outcome:** Discover and remove avoidable work across Codex, Claude Code, and OpenCode without losing the information an agent needs.

## Problem and evidence

Repeated reads, large outputs, redundant instructions, and repeated exploration are plausible sources of waste, but their share of this user's sessions is unknown. The existing Cairn A/B did not prove an overall speed or cost win. [RTK](https://github.com/rtk-ai/rtk) already filters commands; [compression research](https://arxiv.org/abs/2607.12161) shows that fewer output tokens can lead to higher total cost or extra work. The first decision is which problem actually matters here.

## Milestone 1: Audit without changing behavior

- [ ] Inventory the three installed host versions and their documented export, event and plugin support. Create a per-host coverage matrix: observable, estimated, unavailable, and unsupported. Distinguish application type and local/cloud orchestration.
- [ ] Evaluate an existing meter using the Meter plan. If it meets the need, consume a documented local export or recommend it instead of duplicating a reader.
- [ ] For a proven gap, implement a read-only, consented audit for one supported host. Rank only observed opportunities: repeated reads/searches when content identity and time are known; large tool outputs when size is available; instruction size when actual loaded content is accessible. Show evidence and unknowns, not a calculated quota saving.
- [ ] Record baseline and audit overhead using the shared protocol. No hooks that add model context or alter tool calls are installed in this milestone.
- [ ] Verify absent, truncated, malformed, rotated, inaccessible and concurrent session data; audit failure leaves the assistant's session and files unchanged.

**Exit:** A report for one verified host identifies actual, inspectable opportunities; otherwise stop and use existing tools. Expand to other hosts only when their data can be reliably obtained.

## Milestone 2: Select one intervention

- [ ] Rank opportunities by observed frequency, likely user impact, correctness risk, and integration coverage. Pick a single intervention for an experiment.
- [ ] Compare the intervention against native behavior and a mature existing alternative on frozen tasks. Count total task time, retries, accepted outcomes, and provider-reported usage when available; include all agent turns and failure recovery.
- [ ] Implement only the smallest intervention that outperforms the alternatives on the user's workload. Choose its responsible boundary after tracing the host integration. No blanket rewrite of tool output, prompt history, or instruction files.

Candidate experiments, not promised features:

1. **Output:** For known command types, compact successful output while preserving exit code and a user-accessible original. Complete failures stay available. Never rerun a command to reconstruct output; unknown or interrupted commands pass through.
2. **Repeated reads:** Suggest a range or delta only when session identity and exact file state are known. Changed, deleted, unreadable, or uncertain files fall back to full current content; full reads remain available.
3. **Context:** Use the existing Context packer and expansion path; do not create a second ranker or independent budget implementation.

## Integration, safety, and implementation boundaries

- The public entry point is `bin/cairn.mjs`; existing Context is under `src/waymark/`. Add a distinct Optimize command only after the pilot justifies it, without changing existing commands. Build, packaging, help, setup and uninstall must be considered together.
- Verify the installed version of [Codex hooks](https://developers.openai.com/codex/hooks), [Claude hooks](https://code.claude.com/docs/en/hooks), and [OpenCode plugins](https://opencode.ai/docs/plugins) separately. Event availability does not imply safe replacement of arbitrary output. Treat unsupported surfaces as unsupported.
- Default to local, explicit opt-in; collect minimal data, preserve source provenance, and offer deletion. Redact known secrets but never claim comprehensive secret detection.
- Optional integrations must fail open, preserve permissions and security decisions, avoid rerunning side-effecting commands, and leave existing user hooks intact on install/uninstall.

## Verification and acceptance

- [ ] Synthetic fixtures establish correct counts, unknown states, redaction and no host-file mutation; exercise Windows and concurrent session isolation.
- [ ] For a chosen intervention, prove that source information and failures remain accessible, command exit behavior is preserved, and disabled/unavailable integrations have no effect.
- [ ] Compare at least the roadmap pilot's representative tasks with no intervention, current Cairn, and the chosen intervention; report distributions, sample size, failures and missing subscription data.
- [ ] Enable by default only after a separate measured decision shows meaningful benefit without an accepted-quality regression. Otherwise keep it optional or remove it.

## Stop condition

The first deliverable is an audit that answers an observable question with clear coverage. There is no commitment to write a compressor, cache, daemon, proxy, or generic token-savings dashboard.
