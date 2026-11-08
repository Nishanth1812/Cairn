# Cairn Meter Detailed Plan

**Decision:** Provide measurement through the Optimize experience; do not build a separate dashboard by default. Evaluate an existing local meter before implementing readers. Follow the [shared roadmap](2026-11-05-cairn-roadmap.md).

**User outcome:** Understand where time and observable usage go across Codex, Claude Code, and OpenCode, and whether a change improves completed work before a subscription limit is reached.

## Current behavior and alternatives

`src/waymark/telemetry/toolCalls.ts` and existing stats observe Cairn lookups, not full assistant sessions, usage limits, or subscription costs. [Token Meter](https://github.com/splunk/token-meter) already reports local usage across several assistants; validate its Windows support, versions, coverage, privacy, and output against the user's installations before duplicating it. Provider session schemas and subscription reporting vary, and OpenCode may use different providers.

## Work packages

1. **Inventory:** For each installed host and version, identify documented local or exported metrics: session identifiers, timestamps, tool events, input/output/cache counts, model, and limit status. Record permission requirements and unknowns. Do not read private histories until the user opts in.
2. **Compare existing meters:** Test whether an existing tool can supply the needed report without sending data externally. Check license, Windows behavior, available exports, malformed or partial sessions, and whether it reports subscriptions accurately. Record gaps and reproducible evidence.
3. **Read-only pilot if needed:** Start with the single host and metric that fills the largest gap. Parse only the needed fields from user-selected local files or documented exports. Never modify host databases or depend on hidden credentials. Add a second or third adapter only after the first is reliable.
4. **Normalize cautiously:** Keep host, version, session, time, metric name, unit, provenance, and whether each number is actual, estimated, unavailable, or incomplete. Deduplicate events only with source-supported identity; incomplete data remains unknown. Do not add across different units or report API-equivalent prices as the user's bill.
5. **Report:** Show task/session time and observed calls and usage where available; let the user compare like-for-like tasks and export/delete Cairn-owned data. Do not claim exact remaining allowance without authoritative data.

## Ownership and interfaces

- Keep existing Cairn lookup stats intact. If a pilot needs code, put source-specific readers and reporting under a distinct Optimize area, and use a minimal shared observation type only after two sources justify it.
- Local storage, if necessary, must define retention, access permissions, migration and deletion first. Avoid copying full transcripts, prompts, credentials, or raw output. Store aggregate facts where possible.
- Windows paths, non-ASCII paths, partial files, rotated logs, duplicated observations, and concurrent writers must be handled without modifying source data.

## Verification and acceptance

- [ ] Exercise source fixtures with consented synthetic data, absent fields, malformed records, partial writes, duplicate events, unsupported versions, and no data; do not treat missing as zero.
- [ ] Verify no network traffic, no host data writes, no secrets in reports, and explicit deletion of Cairn-owned state.
- [ ] Compare sample reports with each host's own visible numbers, documenting discrepancies and unavailable metrics.
- [ ] Demonstrate the report supports the roadmap's baseline comparison. If an existing tool already answers the user's questions, integrate through documented exports or recommend it and stop.

**No first-release commitment:** live quotas, billing totals, cross-provider cost conversion, and a web UI require an authoritative source and demonstrated need. [Codex pricing](https://developers.openai.com/codex/pricing) explicitly separates subscription usage from API token prices.
