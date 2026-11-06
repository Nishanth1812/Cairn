---
type: optimize-audit
title: Optimize audit and per-host coverage
description: The read-only, consent-gated `cairn optimize` audit — coverage matrix for all three hosts, transcript reader for Claude Code, provenance rules for observed, estimated and unavailable data, CLI entry, and its black-box verification.
tags: [optimize, audit, coverage, claude-code, privacy, verification]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-05T11:43:19.037Z
sources:
  - id: openwiki-source-46564453a25d10329ebb69fa
    resource: repo://bin/cairn.mjs
  - id: openwiki-source-97a29712907bdf5f2cd43c6f
    resource: repo://rolldown.config.mjs
  - id: openwiki-source-1be5e4596ae39d893f018a54
    resource: repo://src/cairn/cli/optimizeCommand.ts
  - id: openwiki-source-c5d923eee586a426ac8e5c4e
    resource: repo://src/cairn/optimize/audit.ts
  - id: openwiki-source-8586bc725ec0edf818dfa019
    resource: repo://src/cairn/optimize/claudeTranscript.ts
  - id: openwiki-source-7abb93202debfc665a0a4b1e
    resource: repo://src/cairn/optimize/hosts.ts
  - id: openwiki-source-668c20b53105fc5d6c673b0c
    resource: repo://tests/cairn/optimize-audit.test.mjs
generated: { by: "opencode", at: "2026-11-05T11:43:19.037Z" }
---

# Optimize audit and per-host coverage

`cairn optimize` is the first release of the Optimize capability: a local, opt-in, strictly read-only audit that reports where avoidable work is actually observable in assistant sessions. It changes nothing — it installs no hooks, rewrites no tool calls, and stores nothing. It exists to rank observed opportunities with honest provenance so that any later intervention has to beat evidence, not a hypothesis.

## Responsibility and entry points

- `bin/cairn.mjs` routes `optimize` in-process (argv is rewritten, nothing is spawned) to `dist/optimize.js`, a second bundle built from `src/cairn/cli/optimizeCommand.ts` alongside the `dist/context.js` context tool. An unknown top-level command exits 2; a missing bundle exits 1 with a build hint.
- `src/cairn/cli/optimizeCommand.ts` is self-runnable (its main guard lives in the same module), parses its own `--json/--quiet/--verbose` flags, and never imports the context command router or any indexing/storage code. That keeps the audit's module load cheap and removes any chance of the audit mutating context state.
- Subcommands: `coverage` (inventory, no private reads, no consent needed) and `audit` (the consented transcript audit). `cairn optimize --help` prints usage; unknown subcommands exit 2.
- `docs/optimize.md` is the user-facing documentation for both subcommands.

## The coverage inventory (observation versus guessing)

`hostCoverage(home)` in `src/cairn/optimize/hosts.ts` is a static, honest inventory for the three installed hosts (Claude Code, Codex, OpenCode). For each host it records app type, orchestration (local versus cloud-only), the local data root, a detector, and per-category statuses:

- **observable** — locally readable and verified by this release (Claude Code sessions, tool events, provider usage, output sizes, re-read identity).
- **estimated** — the source exists but this release has no reader or cannot yet rely on the layout (Codex and OpenCode sessions/usage; instruction-file loading for all hosts).
- **unavailable** — the host does not store it locally (subscription limit and quota status on every host; output sizes and re-read identity for Codex and OpenCode until their layouts are verified).

The only I/O the inventory performs is `existsSync` detection (`~/.claude/projects` or `~/.claude/settings.json`; `~/.codex`; `~/.config/opencode` or `~/.local/share/opencode`), so `coverage` can run without consent. Only Claude Code has `reader: 'implemented'`; the other two explicitly say `not implemented` rather than implying coverage.

## The consent gate

`runOptimize` resolves the host home from `--home` or the environment, then requires an explicit `--consent` flag before instantiating any reader. Without it the audit throws `OptimizeError` with exit code 3 (`missing_resource`) and a message that states exactly which directory would be read and that nothing would be written. No transcript is listed or opened before consent.

## The transcript reader (Claude Code only)

`src/cairn/optimize/claudeTranscript.ts` implements the one verified host reader:

- `listClaudeProjects(home)` walks `~/.claude/projects/<project>` recursively, so agent transcripts stored in per-session subdirectories are covered as separate sessions. File sizes that cannot be statted are `null`, never zero — unreadable metadata stays unknown.
- Per file, `ClaudeTranscript.read()` parses JSONL line by line. It absorbs assistant lines (model, `usage.input_tokens/output_tokens/cache_read_input_tokens/cache_creation_input_tokens` when the host records them, and `tool_use` inputs such as `file_path`, `pattern`, `path`, `command`) and pairs them with user `tool_result` records by `tool_use_id`. Unparseable lines (including the line being written while the file is read) are counted as `malformedLines` and skipped; unknown shapes never fail the file.
- Read identity uses `identityKey`: separators normalize to `/` and, on Windows, case is folded away, so the same file read with different path spellings is one file. Result content is fingerprinted as a truncated SHA-1; two reads of the same path with the same fingerprint count as one identical re-read. Error results are excluded from read identity. Tool output larger than the fixed `LARGE_OUTPUT_CHARS` threshold (20,000 chars) is tallied by size alone. File content and result text are never retained or emitted — only paths, patterns, sizes, and fingerprints.
- Per-file read errors propagate out of `read()` without any retry or write; the audit layer reports them and moves on.

## The audit orchestration

`runAudit` in `src/cairn/optimize/audit.ts`:

- caps the scan at 500 sessions, largest first; sessions beyond the cap are counted and reported in the limitations ("rerun with --project to focus scope instead of inferring from partial data"), never silently truncated. `--sessions` overrides the cap.
- separates provenance: sessions with provider-reported usage contribute their verbatim token sums per model (cache read and cache creation kept separate); sessions without usage are counted and their token side is flagged as estimate-only, using the project estimator (`chars/4 * 1.1`). The report is explicit that these are API token accounting and never converts them to subscription quota or cost.
- ranks only observed opportunities as per-session rows (keyed by project, session, and path/pattern — sessions are never merged): `repeatedReads` (reads, distinct versions, identicalRepeats), `repeatedSearches` (identical tool+pattern+path calls), and `largeToolOutputs` (count, chars, estimate, size-ranked samples whose targets are clipped to 80 characters).
- reports bounds (`sessionsScanned`, `sessionsSkipped`, `bytesRead`, `linesRead`, `malformedLines`), its own `overhead.elapsedMs`, a snapshot of the Claude Code coverage categories, and a limitations list that names the undocumented transcript layout, the estimate method, the "report contains paths/sizes/fingerprints, never content" guarantee, and any read failures with their OS error.

`runOptimize` prints a uniform JSON envelope (`schema_version`, `command`, `ok`, `status`, `data`, `warnings`, `errors`) through `redactDeep` in `--json` mode, and a compact human summary (redacted strings) otherwise. Content never reaches either path.

## Safety and invariants

- Read-only by construction: the reader opens files for reading only; the CI-verified invariant is that session files' sizes and mtimes are identical before and after an audit run.
- Consent enforced before any private read; `coverage` never tunes into private data.
- Failures degrade into counts and messages: missing data root, empty projects, unreadable sessions, unparseable lines, and out-of-cap sessions each surface individually and are never promoted into zeros or silent omission.
- Windows realities are handled inside `identityKey` (case) and path handling; the read-only test compares exact stat snapshots.

## Verification

`tests/cairn/optimize-audit.test.mjs` black-boxes the built CLI against synthetic `~/.claude` fixtures (spawned through `bin/cairn.mjs`, so routing, bundling and exit codes are exercised):

- help/unknown-subcommand exit codes; coverage lists all three hosts, marks Codex/OpenCode readers `not implemented`, and refuses quota observability on every host.
- audit without consent exits 3 and reads nothing; audit with consent scans the fixture sessions (including a nested agent transcript), detects repeated reads (separating the case-insensitive same-path reads on Windows, and identical-versus-changed content), repeated searches, one large tool output, provider usage sums per model, estimate-only sessions, malformed/truncated lines, and the per-session session cap.
- asserts no fixture content or seeded canary string appears in stdout or stderr, session files are byte-identical after the run, and compact mode prints the human summary without content.
