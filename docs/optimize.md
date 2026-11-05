# Cairn Optimize

A read-only, opt-in audit of local coding-assistant session data. It helps answer one question: where is avoidable work actually happening in real sessions? It observes; it does not change assistant behavior.

Status and scope: this first release ships an audit reader for one verified host (Claude Code) and a coverage matrix for all three hosts (Claude Code, Codex, OpenCode). Later interventions stay evidence-gated per the plans in `docs/superpowers/plans/2026-11-05-cairn-optimize-detailed.md` and the shared roadmap.

## What it does

- `cairn optimize coverage` — per-host inventory of what session data each installed host exposes locally: observations (session transcripts, tool events, provider-reported token counts, tool output sizes), estimates (data that exists but with no reader yet), and unavailable data (such as subscription limit status). It reads no private data — only checks that host directories exist. It also distinguishes application type and local/cloud orchestration.
- `cairn optimize audit --consent` — once consent is given, reads the local Claude Code transcripts and reports the ranked evidence, e.g.:

```
Cairn Optimize audit — claude-code — read-only; provenance and limits listed below.
Scanned 500 session(s) across 38 of 38 project directorie(s), 134 skipped or beyond cap.
Provider-reported usage covers 500 session(s).
Large tool outputs: 377 result(s) at 20k+ chars ...
Top repeated reads (reads / identical re-reads):
  <project> :: <path> — 69 reads, 46 seeing unchanged content (fingerprinted)
```

Every number in the report has a provenance label in `--json` mode:

- **Provider-reported** token counts (input, output, cache read, cache creation) are taken verbatim from rows the host writes per assistant message. Cache reads and cache writes are kept separate. These are token accounting, not subscription billing — `cairn optimize` never converts them to quota, dollar or "plan percentage" figures.
- **Observed** opportunities are ranked only on evidence found in transcripts: repeated reads (with content fingerprints to separate identical re-reads from re-reads after change), repeated identical searches, and large tool outputs at or above a fixed 20,000-character threshold.
- **Estimated** token counts use the project's `chars/4 x 1.1` estimator and are always labeled as estimates.
- **Unknown** data is never turned into a zero. Sessions that could not be read are skipped and reported with their error; unparseable lines are counted; sessions without provider usage are flagged so their token totals are treated as estimates only.

## Privacy and safety model

- Explicit consent: the audit refuses to run without `--consent` and exactly describes what it would read before it does.
- Read-only: host files are opened for reading only. Nothing is installed, no hooks are added, and no host file is modified. Uninstalling means removing the package; there is nothing else to reverse.
- Local only: no network calls, no uploads. Reports contain file paths, search patterns, sizes, and truncated content fingerprints — never file content or tool output content. Any incidental secret that slips into those text fields goes through the project's best-effort redaction, which is a best effort, not a guarantee.
- Isolation: reads and searches are ranked per session. Nothing is proposed across sessions, because cross-session reuse is not safely serviceable without verified session identity.
- Deletion of session data remains in the host's hands — Cairn copies or stores nothing.

## Coverage matrix (first release)

| Data | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Session transcripts | observable | estimated | estimated |
| Tool events | observable | estimated | estimated |
| Provider usage | observable | estimated | estimated |
| Output sizes | observable | unavailable | unavailable |
| Re-read identity | observable | unavailable | unavailable |
| Limit/quota status | unavailable | unavailable | unavailable |
| Instruction size | estimated | estimated | estimated |

The Codex and OpenCode columns are honest about what has not been verified: their session files exist locally, but no reader ships in this release and their layouts must be verified before anything is claimed. Run `cairn optimize coverage` on your machine for the full matrix with per-field detail, the detection probe used, and each host's local data root.

## Options and exit codes

```
cairn optimize coverage              no consent needed; reads no private data
cairn optimize audit --consent       full local transcript audit
  --project <dir|name>               audit one project directory (default: every project)
  --sessions <n>                     override the 500-session cap (largest sessions first)
  --home <dir>                       alternate host home (tests, alternate installs)
  --json                             full machine-readable report with provenance labels
Global flags: --json --quiet --verbose; `cairn optimize --help` for details
```

Exit codes follow the project convention: 0 success, 2 invalid arguments, 3 missing resource (no consent, or no session data found), 1 unexpected error. Malformed or truncated transcript lines and unreadable sessions degrade the report's completeness and are always counted in the report — never silently dropped and never counted as zeros.

## Known limitations

- The Claude Code transcript layout is undocumented; a version change of the host can change what is observable. Agent transcripts nested under per-session subdirectories are covered too, but their layout is also an undocumented host detail.
- Overhead is real and reported in every run (`overhead.elapsedMs`): reading a full multi-gigabyte history takes on the order of a minute. Use `--project` to focus the scan.
- The audit answers what is observable in transcripts. It does not see prompt-caching economics for the user's subscription, limit states, cloud-only data, or time and task success — those need the measurement protocol in the roadmap and remain future work.
- No intervention ships: nothing rewrites outputs, suggest deltas during sessions, or caches anything. Milestone 2 requires separate measured evidence before any intervention exists.
