# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting: **Security → Report a vulnerability** on the
[Cairn repository](https://github.com/Nishanth1812/Cairn/security/advisories/new). Expect an acknowledgement within a week.

## What Cairn touches

- It reads files in git repos you query and stores chunks in a local SQLite database. It makes no network calls.
- Secrets found in code are redacted before storage and output; `.env*`, key files and similar paths are never indexed.
- `cairn waymark setup` edits `~/.claude/settings.json`, `CLAUDE.md` and `AGENTS.md` (managed blocks only) and `cairn waymark setup --uninstall` reverses it. Use `--dry-run` to preview.

In scope: secret leakage into the index or output, hook/instruction edits that damage your config, path traversal, command injection. Only the latest release is supported.
