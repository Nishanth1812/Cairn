# Cairn Verify Detailed Plan

**Decision:** Build a focused report of changes, observed checks, and remaining uncertainty. Reuse existing project runners and task checkpoints. Follow the [shared roadmap](2026-11-05-cairn-roadmap.md) and [Run plan](2026-11-05-cairn-run-detailed.md).

**User outcome:** Quickly see what an agent changed, what evidence exists, and which important checks have not run, even after switching assistants.

## Current state

`src/waymark/verification/runner.ts` runs an explicitly supplied command, records its exit code, duration, changed paths and a redacted output tail, and handles timeout. `src/waymark/memory/taskManager.ts` retains recent records in checkpoints. A successful command does not establish that all required checks ran or that it covers the current diff. The stored tail is not a complete log.

## Work packages

1. **Trace and report:** [ ] Trace the existing verify command, shell invocation, output capture, timeout, task attachment, fingerprint, and callers. Add a read-only report that shows current changed paths and each observed command, time, exit status and associated source state. Say `not run` or `unknown` rather than `passed` when evidence is absent or stale.
2. **Evidence freshness:** [ ] Associate verification evidence with an explicit repo/worktree and revision plus enough working-tree state to detect subsequent edits. If a reliable match is unavailable, show unknown/stale rather than asserting the check covers the diff. Preserve compatibility with old records.
3. **Recommendations:** [ ] Detect only existing, documented project check commands and optionally suggest them with the reason. Use native affected-test support when the project already has it, e.g. [Jest](https://jestjs.io/docs/cli) or [Nx](https://nx.dev/docs/features/run-tasks). Uncertain dependency graphs, config changes, lockfiles and global effects must recommend a broader check, not a false all-clear.
4. **Execution:** [ ] Run checks only on explicit user/agent request, with a visible exact command, timeout, exit status and project context. Preserve the current behavior and surface errors. Do not run deployment, destructive commands, or install dependencies as a side effect of a report.
5. **Full failures:** [ ] If adding output capture, keep full failed output locally retrievable with explicit location, retention and deletion. Avoid exposing secrets; respect that redaction is incomplete. Do not claim the existing 4 KiB tail is a full log, and do not rerun failed commands merely to obtain it.

## Likely files and boundaries

Extend `src/waymark/verification/runner.ts`, task checkpoint storage, and existing CLI formatting where warranted. Review `src/waymark/core/gitstate/`, `src/waymark/storage/`, and every caller when changing the verification record. Add targeted black-box cases under `tests/waymark/`. Schema changes require a versioned, reversible compatibility plan and preservation of existing records.

## Verification and acceptance

- [ ] A successful, failed, timed-out and missing command are reported accurately; complete failure diagnostics are accessible if the new capture path is implemented.
- [ ] Changes after a check, different worktrees, untracked files, dirty trees and interrupted commands do not produce a false current pass.
- [ ] Unknown test mapping, no test configuration, global configuration changes and no applicable tests produce explicit uncertainty or a broader suggestion.
- [ ] Reports do not execute commands. Explicit execution preserves shell/exit semantics and works with paths containing spaces on Windows.
- [ ] A user can inspect the report and identify what to run next; compare time-to-review and missed checks against the current workflow.

**Stop:** Do not promise a complete proof of correctness or implement a new universal test selector. Existing tools retain responsibility for their own dependency graphs.
