# Cairn Optimize Plan

> Earlier product outline. The updated scope and implementation gates are in [Cairn Optimize](2026-11-05-cairn-optimize-detailed.md) and the [Cairn roadmap](2026-11-05-cairn-roadmap.md).

**Goal:** Build one local tool that helps developers using multiple coding assistants reduce wasted context while maintaining task quality.

**Approach:** Start with an audit, measure the largest sources of waste in real sessions, and implement optimizations in order of demonstrated value. Provide one shared CLI and add small assistant integrations as their supported capabilities are verified. Reuse Cairn Context for code retrieval and token budgeting.

**Status:** Product plan. The audit is the first implementation milestone; later milestones depend on its findings. Proposed commands and integrations require design and verification before implementation.

## Principles

- Keep data local by default; collect session information only with the user's consent and make stored data inspectable and removable.
- Preserve task quality, complete errors, exit status, and access to original output. An integration failure must not block the normal workflow.
- Report measured values separately from estimates. Do not equate fewer output tokens with lower costs, faster tasks, or better answers.
- Support multiple assistants through a shared core; do not assume their hooks expose the same data or can rewrite the same outputs.
- Use existing Cairn functionality and evaluate existing tools before duplicating their features.

## Milestones

### 1. Audit and baseline

- [ ] Identify which local session data and usage statistics each selected assistant actually exposes, including permissions and limitations.
- [ ] Provide an opt-in audit that identifies available sources of context use, such as instructions, repeated file reads and searches, large command outputs, and compactions. Mark unavailable categories as unknown.
- [ ] Show token estimates as estimates; display actual provider usage and cache data only when available. Do not present subscription usage as a calculated API bill.
- [ ] Establish a baseline from representative real tasks: task success, elapsed time, repeated calls, usage, and cost where available.
- [ ] Verify privacy, missing or malformed session data, and operation with no supported session data.

**Deliverable:** A local report that points to the largest observable opportunities without changing assistant behavior.

### 2. Compact command output

- [ ] Compare existing options, including RTK, against the baseline before deciding whether Cairn needs its own implementation.
- [ ] If a gap remains, start with the command types that account for the most waste: for example, summarize successful test runs, repeated log lines, or long file listings.
- [ ] Preserve complete failure output and exit status; make original output retrievable when a successful result is compacted.
- [ ] Verify unsupported commands, failures, interrupted commands, and a disabled or failed integration preserve normal behavior.

**Deliverable:** An optional, reversible optimization for measured command-output waste.

### 3. Reduce repeated reads

- [ ] Detect repeated reads only where an assistant exposes reliable session and file information.
- [ ] Offer relevant lines or a change since the previous read when the file state can be verified; otherwise provide the full current content.
- [ ] Keep the full current content accessible on request, and isolate tracking by session and repository.
- [ ] Verify changed, deleted, renamed, and unreadable files, plus separate sessions and repositories.

**Deliverable:** Optional assistance for repeated reads without hiding changes or preventing full reads.

### 4. Focused code context

- [ ] Reuse Cairn Context's ranking, overlap handling, and budgeted packing instead of creating another retrieval pipeline.
- [ ] Return source paths and line numbers and make it clear when results are omitted or clipped; support requesting more context.
- [ ] Evaluate retrieval quality alongside output size, including tasks that need multiple files and cases with no useful result.
- [ ] Consider retrieval caching only if profiling shows it helps; include repository state and other result-affecting inputs in invalidation.

**Deliverable:** Budgeted, traceable code context that can be expanded when needed.

### 5. Compare results and integrate assistants

- [ ] Present a simple local report comparing baseline and optimized tasks: success, elapsed time, repeated calls, usage, and actual cost when available.
- [ ] Compare like-for-like tasks and assistant settings; account for provider cache reads and writes where reported. Explain when sample size or missing data prevents a conclusion.
- [ ] Add integrations one assistant at a time, based on the user's most-used assistants and verified hook capabilities; document which features work in each environment.
- [ ] Run representative tasks with and without each enabled optimization. Keep an optimization enabled by default only after evidence shows it helps without a meaningful loss of task quality.

**Deliverable:** A cross-assistant workflow whose benefits and coverage are visible rather than assumed.

## Existing starting points

- `cairn-proposed-tools.md` describes Optimize as one tool in the Cairn ecosystem.
- `src/waymark/context/packer.ts` already selects and clips ranked results to an estimated token budget.
- `src/waymark/core/estimate/tokenEstimator.ts` provides an approximate token count, not a model tokenizer.
- `src/waymark/bench/retrieval.ts` measures retrieval hits and packed output size; it does not establish end-to-end task success or savings.
- `bin/cairn.mjs` is the current unified CLI entry point. Any new command and packaging changes need to preserve existing commands.

## Research to revisit during implementation

- [RTK](https://github.com/rtk-ai/rtk) provides command-output filtering for several assistants.
- [Distil](https://github.com/dshakes/distil) reports mixed benchmark results for compression and illustrates why total cost per task matters.
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) depends on stable matching prefixes; measure cache effects rather than assuming a shorter prompt is cheaper.
- [Codex hooks](https://developers.openai.com/codex/hooks) describe supported events and environment limitations; confirm the installed version before relying on a hook.

## Stop condition

The first release is useful when the user can run an audit locally, understand its coverage and limitations, and use it to decide which optimization to try. Subsequent features ship only when they improve a measured workflow and preserve task quality.
