# Cairn Parallel Detailed Plan

**Decision:** Defer a standalone coordinator. First use the parallel features already provided by the assistants; build a cross-assistant aid only for a measured gap. Follow the [shared roadmap](2026-11-05-cairn-roadmap.md).

**User outcome:** Run genuinely independent work concurrently without losing track of changes, consuming unnecessary subscription capacity, or risking uncommitted work.

## Current alternatives

[Codex worktrees](https://developers.openai.com/codex/app/worktrees) isolate concurrent chats; [Claude Code](https://code.claude.com/docs/en/agents) offers several parallel modes; OpenCode capabilities depend on the installed version and configured plugins. Git worktrees isolate checkout files, but not shared external resources, databases, network services, or the costs of multiple model sessions.

## Work packages

1. **Observe real tasks:** [ ] Record which user tasks are truly independent, which assistants are used, how work is started and reviewed, and where status or handoff becomes difficult. Compare elapsed time, accepted work, retries, human coordination and subscription-limit events against serial work.
2. **Capability matrix:** [ ] Verify installed versions and documented features for status, cancellation, worktree identity and result retrieval. Do not assume a CLI or host can monitor or control another host. Use only authorized local metadata.
3. **Small read-only aid if justified:** [ ] If the gap is visibility, report user-selected task, assistant, repository/worktree, branch, state and last-known result from supported sources. Mark inaccessible or stale state unknown. Do not launch agents or mutate checkouts for a status report.
4. **Optional orchestration design:** [ ] Only after a measured need, specify a supported host-specific launch and cancellation method, explicit concurrency and usage boundaries, failure recovery, and a clear owner for each task. A new host or separate checkout requires its own supported integration; do not silently route to another provider or model.
5. **Safe isolation and review:** [ ] Before any mutation verify resolved repository/worktree paths and branch ownership. Never overwrite uncommitted work, remove a worktree automatically, merge, push, or cancel a user's work without the relevant authorization. Shared services and files outside the checkout remain the user's responsibility.

## Likely ownership

No new package or implementation is required until the visibility pilot has a verified gap. If one is justified, the unified CLI entry point and a small integration module can report supported metadata; reuse existing git-state helpers. Do not duplicate native host process managers or invent a general multi-agent framework.

## Verification and acceptance

- [ ] Status distinguishes running, completed, failed, canceled and unknown only when the host exposes those states; two tasks and repositories cannot be mixed.
- [ ] Exercise missing host, version mismatch, unavailable worktree, user-owned dirty work, changed branch, concurrent sessions, Windows paths, and host shutdown. A status operation makes no mutations.
- [ ] Any future launch/cancel path has explicit authorization, a tested recovery path, and no destructive cleanup of user data.
- [ ] A controlled representative trial shows improved elapsed time or review effort without reducing accepted work or causing unacceptable usage. Otherwise continue with native tools.

**Stop:** Do not build a scheduler, agent marketplace, automatic model switching, or worktree cleanup service for the first release.
