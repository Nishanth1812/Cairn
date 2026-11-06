# Cairn Optimize

A read-only, opt-in audit of local coding-assistant session data. It helps answer one question: where is avoidable work actually happening in real sessions? It observes; it does not change assistant behavior.

Status and scope: this release ships audit readers for three hosts — Claude Code, Codex and OpenCode — selected with `--host` (Claude Code stays the default). Later interventions stay evidence-gated per the plans in `docs/superpowers/plans/2026-11-05-cairn-optimize-detailed.md` and the shared roadmap.

## What it does

- `cairn optimize coverage` - per-host inventory of what session data each installed host exposes locally: observations (session transcripts, tool events, provider-reported token counts, tool output sizes), estimates (data that exists but cannot be relied on), and unavailable data (such as subscription limit status). It reads no private data - only checks that host directories exist. It also distinguishes application type and local/cloud orchestration. Codex honors `CODEX_HOME`; OpenCode honors `XDG_DATA_HOME` and `OPENCODE_DB`, and those overrides are named in the per-field detail.
- `cairn optimize audit --consent --host codex|opencode|claude-code` - once consent is given, reads the selected host's local session data and reports the ranked evidence, e.g.:
- `cairn optimize compare --baseline <report.json> --current <report.json>` - compares two audit reports supplied by the user. It reads only those JSON files and does not scan host data or save a baseline. Matching host, project and coverage allow descriptive metric deltas; mismatches show each report's observed metrics side by side and omit deltas. Capped, malformed or usage-incomplete reports are labeled partial. Optional outcomes and elapsed times are included only when supplied explicitly.

```
Cairn Optimize audit - claude-code - read-only; provenance and limits listed below.
Scanned 500 session(s) across 38 of 38 project directorie(s), 134 skipped or beyond cap.
Provider-reported usage covers 500 session(s).
Large tool outputs: 377 result(s) at 20k+ chars ...
Top repeated reads (reads / identical re-reads):  <project> :: <path> - 69 reads, 46 seeing unchanged content (fingerprinted)
```

Every number in the report has a provenance label in `--json` mode:

- **Provider-reported** token counts are taken verbatim from rows the host writes: per assistant message for Claude Code and OpenCode, and the latest cumulative snapshot per session for Codex (never a sum of snapshots; per-response deltas only attribute them to models). Cache reads and cache writes are kept separate. These are token accounting, not subscription billing - `cairn optimize` never converts them to quota, dollar or "plan percentage" figures.
- **Observed** opportunities are ranked only on evidence found in transcripts: repeated reads (with content fingerprints to separate identical re-reads from re-reads after change), repeated identical searches, and large tool outputs at or above a fixed 20,000-character threshold. Codex has no verified per-file read event (file access goes through opaque shell commands), so repeated reads and searches are simply not reported for it rather than fabricated.
- **Estimated** token counts use the project's `chars/4 x 1.1` estimator and are always labeled as estimates.
- **Unknown** data is never turned into a zero. Sessions that could not be read are skipped and reported with their error; unparseable lines are counted; sessions without provider usage are flagged so their token totals are treated as estimates only.

Host data locations (each named in the consent prompt before anything is read):

| Host | Location | Format |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` | JSONL transcripts |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl` (`CODEX_HOME` overrides) | JSONL rollouts |
| OpenCode | `~/.local/share/opencode/opencode.db` (`XDG_DATA_HOME` / `OPENCODE_DB` override) | SQLite (v1 or v2 tables) |

## Privacy and safety model

- Explicit consent: the audit refuses to run without `--consent` and exactly describes which host location it would read before it does. No private data is read by `coverage` or before consent.
- Read-only: host files are opened for reading only. The OpenCode database is opened in SQLite immutable mode; when a live journal/WAL sidecar is present, the database and its sidecars are first copied to a private temporary snapshot directory and the snapshot is opened instead, so opening never creates the database or any journal/WAL/SHM sidecar next to the source and the source is never checkpointed, written or deleted. Data read is a point-in-time snapshot - data still only in an uncheckpointed WAL is invisible, never wrong - and if the source changes during the copy or read, the audit fails rather than reporting stale data. Nothing is installed, no hooks are added, and no host file is modified. Uninstalling means removing the package; there is nothing else to reverse.
- Local only: no network calls, no uploads. Reports contain file paths, search patterns, sizes, and truncated content fingerprints - never file content or tool output content. Shell commands are reported by executable name only: arguments are dropped entirely because they can hold credentials, and pattern-matching redaction cannot recognize every secret shape. Any incidental secret that slips into the remaining text fields goes through the project's best-effort redaction, which is a best effort, not a guarantee.
- Isolation: reads and searches are ranked per session. Nothing is proposed across sessions, because cross-session reuse is not safely serviceable without verified session identity.
- Project scoping fails closed: `--project` must name one project (exact, or a unique suffix of the name). An ambiguous hint, the fallback `unknown` bucket, or a misspelled flag is an error rather than a wider scan.
- Deletion of session data remains in the host's hands. Cairn stores nothing; its only copy is the private temporary OpenCode snapshot described above, removed after each read.

## Coverage matrix (this release)

| Data | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Session transcripts | observable | observable | observable |
| Tool events | observable | observable | observable |
| Provider usage | observable | observable | observable |
| Output sizes | observable | observable | observable |
| Re-read identity | observable | unavailable | observable |
| Limit/quota status | unavailable | unavailable | unavailable |
| Instruction size | estimated | estimated | estimated |

Run `cairn optimize coverage` on your machine for the full matrix with per-field detail, the detection probe used, and each host's local data root. Codex compressed (`.zst`) rollouts and archived sessions, OpenCode release-channel databases (`opencode-<channel>.db`) and the frozen pre-SQLite flat-file layout are excluded rather than guessed, and OpenCode sessions visible only in an uncheckpointed WAL are unavailable rather than zero.

## Options and exit codes

```
cairn optimize coverage              no consent needed; checks host directories only
cairn optimize audit --consent       local audit (Claude Code is the default host)
  --host <host>                      claude-code (default), codex or opencode
  --project <dir|name>               audit one project (default: every project; `.` means current directory)
  --sessions <n>                     override the 500-session cap (largest files first by default)
  --recent                           prioritize recent files (Claude/Codex mtime estimate; OpenCode session activity)
  --home <dir>                       alternate host home (tests, alternate installs)
  --json                             full machine-readable report with provenance labels
Global flags: --json --quiet --verbose; `cairn optimize --help` for details

cairn optimize compare --baseline <report.json> --current <report.json>
  --baseline-outcome completed|not-completed|unknown
  --current-outcome completed|not-completed|unknown
  --baseline-elapsed-ms <n> --current-elapsed-ms <n>  explicitly supplied values only
```

Exit codes follow the project convention: 0 success, 2 invalid arguments, 3 missing resource (no consent, or no session data found), 1 unexpected error. Failed runs still emit a JSON envelope in `--json` mode (`ok: false`, `status`, `errors`) in addition to a stderr line. Malformed or truncated transcript lines and unreadable sessions degrade the report's completeness and are always counted in the report - never silently dropped and never counted as zeros.

## Known limitations

- All three host layouts are verified against upstream source but are not documented stable APIs; a version change of a host can change what is observable, and unknown shapes degrade to fewer observations instead of a false report. Agent transcripts nested under per-session subdirectories are covered for Claude Code; their layout is also an undocumented host detail.
- Overhead is real and reported in every run (`overhead.elapsedMs`): reading a full multi-gigabyte history takes on the order of a minute. Use `--project` to focus the scan.
- The 500-session cap is applied after project selection. By default all hosts select larger files first. With `--recent`, Claude Code and Codex order by file modification time, which is only a recency estimate; OpenCode uses stored session activity timestamps. Reports count sessions skipped at the cap, so capped runs are partial and are not a representative sample by default.
- Usage attribution is limited by what each host records: Claude Code counts each message+request identity once (later snapshots replace earlier ones); Codex attributes each response delta to the model named by the most recent `turn_context` line; OpenCode multi-step v1 messages can be undercounted because upstream overwrites their tokens per step, and v2 compaction-message tokens are excluded.
- The audit answers what is observable in local session data. `compare` works only from two user-supplied reports and cannot verify that they describe the same task or time window. It labels matching-scope metric differences as descriptive, never as savings; cross-host or different-project/coverage reports are shown side by side without deltas. Task outcomes and elapsed times remain `unknown` unless explicitly supplied for both reports. Subscription prompt-caching economics, limit states, and cloud-only data remain unavailable.
- No intervention ships: nothing rewrites outputs, suggest deltas during sessions, or caches anything. Milestone 2 requires separate measured evidence before any intervention exists.
