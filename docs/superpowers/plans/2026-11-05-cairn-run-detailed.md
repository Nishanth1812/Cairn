# Cairn Run Detailed Plan

**Decision:** Do not build a standalone task runner now. Use commands and runners already owned by each project; Verify can report and explicitly invoke them. Follow the [shared roadmap](2026-11-05-cairn-roadmap.md) and [Verify plan](2026-11-05-cairn-verify-detailed.md).

**User outcome:** An assistant knows how to perform the project's checks without requiring the user to maintain a second task configuration.

## Existing options

This project already has npm scripts in `package.json`; other projects may use Make, Task, Nx, or their platform's native commands. [Nx](https://nx.dev/docs/features/run-tasks) already provides pipelines, caching and affected tasks. Cairn's existing verification runner accepts an explicit command and records its result; it is not a general task engine.

## Work packages

1. **Inventory:** [ ] Identify the real commands used in the user's projects, where they are documented, whether they have side effects, and which are already discoverable by the assistants. Avoid executing anything during discovery.
2. **Read-only reporting:** [ ] Where a demonstrated gap exists, show documented or project-configured commands and their source. Unknown commands remain unknown; do not infer that a command is safe or a successful test.
3. **Explicit execution:** [ ] For requested checks, use the existing verification execution path or the native runner. Show the exact command and working directory. Preserve arguments, environment, exit code, full failure diagnostics and timeout behavior. Never automatically perform setup, install, deploy, migrations or other side-effecting actions merely because a task is listed.
4. **Comparison:** [ ] Compare time and errors in command discovery and execution against normal agent behavior. If existing instructions and native runners solve the problem, ship documentation or no change.
5. **Revisit a wrapper only if needed:** [ ] Before adding a cross-project command, demonstrate a repeated failure that existing runners cannot address, specify how it delegates, and provide a compatibility and cleanup plan. No new task DSL, build graph, or cache by default.

## Likely ownership

Project scripts and existing documentation are the authority; `src/waymark/verification/runner.ts` owns current explicit execution. Any change touches its CLI caller, checkpoint records, and relevant `tests/waymark/` tests. Do not change the meaning of project-owned scripts or overwrite user configuration.

## Verification and acceptance

- [ ] Discovery does not execute a project command; missing or ambiguous scripts are reported as unknown.
- [ ] Explicit execution preserves cwd, argument boundaries, quoted Windows paths, exit status, cancellation and timeout behavior.
- [ ] Full failed output is available if a new capture path is implemented; no failure is presented as a pass.
- [ ] A project without npm or without a configured runner remains usable. Scripts with side effects are not run automatically.
- [ ] Compare the resulting workflow with directly invoking the existing project runner; stop if Cairn adds no measurable benefit.
