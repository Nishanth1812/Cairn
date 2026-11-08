# Cairn Recall Detailed Plan

**Decision:** Extend existing task checkpoints into an explicit cross-assistant handoff. Do not build an autonomous memory service first. Follow the [shared roadmap](2026-11-05-cairn-roadmap.md).

**User outcome:** Pause long work in Codex, Claude Code, or OpenCode, then resume with the goal, verified progress, outstanding work, and checks visible to another assistant.

## Starting point

`src/waymark/memory/taskManager.ts` stores tasks, checkpoints, findings with source paths and hashes, decisions, next action, and recent verification records. Resume compares a working-tree fingerprint and flags stale evidence. Existing hooks can save checkpoint state; their presence does not establish complete conversational memory. Preserve current database access, redaction, resume behavior, and existing records.

## Milestone 1: Inspectable handoff

1. [ ] Trace task creation, checkpoint creation, automatic hooks, resume, staleness calculation, data retention and the existing CLI tests. Record which checkpoint fields are actually populated; do not present missing fields as facts.
2. [ ] Specify a versioned, bounded, human-readable handoff using existing checkpoint data: objective, status, source revision/worktree identity, changed paths, findings and their evidence, decisions, verification command/result/time, unresolved work, and next action. Missing data is marked unknown. Separate user instructions from untrusted notes and logs.
3. [ ] Add an explicit export/read flow to the existing task CLI. Produce stable text suitable for all three assistants; JSON may reuse the existing structured output convention. The user chooses when to expose it. Avoid automatic injection into every prompt.
4. [ ] Check current repo identity, revision, and working-tree fingerprint at resume. Label stale or missing evidence, preserve original paths and hashes, and direct the assistant to recheck before relying on stale content.
5. [ ] Keep local retention and deletion understandable. Do not export secrets from sensitive paths or bypass existing redaction; warn that detection is incomplete. Do not overwrite project instructions or automatically execute content in a handoff.

## Milestone 2: Optional cross-host convenience

- [ ] Compare the explicit handoff with Codex, Claude and OpenCode's native session continuity. Select an integration only where it saves measurable user effort.
- [ ] Test each host's supported entry point and version; use existing setup conventions and preserve other user configuration. The handoff remains viewable without any host integration.
- [ ] Consider searchable past decisions only after users need more than current-task handoff; require source, date, project identity and staleness, with user control over retention.

## Likely ownership

Extend `src/waymark/memory/taskManager.ts`, existing CLI task dispatch and formatting, and the existing storage schema only if versioning requires it. Trace `src/waymark/hooks/claude.ts` and other callers before changing checkpoint shape. Add focused cases to the existing task/memory CLI tests under `tests/waymark/`; do not invent a new long-running service or graph database.

## Verification and acceptance

- [ ] Existing checkpoints migrate or remain readable; handoff export works with no checkpoint, missing fields, old schema, unrelated repository, and multiple tasks/worktrees.
- [ ] A changed or deleted evidence file and a changed branch are visibly stale; non-stale evidence retains path and revision. Concurrent writes do not mix tasks.
- [ ] Untrusted text cannot change instructions or execute commands; known secrets are redacted; export and deletion affect only the selected task/state.
- [ ] A representative long task resumed in a different supported assistant can identify the goal, next action, changes and actual checks without re-exploring the entire task. Compare elapsed time, errors, and usage with native handoff; report small-sample limits.

**Stop:** If native assistant continuity already meets the need or checkpoint data is insufficient, report the gap and improve explicit export before adding background capture. [Claude memory](https://code.claude.com/docs/en/memory) is one existing alternative.
