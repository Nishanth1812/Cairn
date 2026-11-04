# Cairn

Cairn is a toolbox for working with AI coding agents. Its first tool, **Waymark**, is a local code index
that answers "where is X handled?" in a few hundred tokens, so the agent stops grepping and reading whole files.

- **Ranked lookups.** `cairn waymark context "where is auth handled"` returns ranked, line-ranged snippets and definitions, not a pile of files, packed to a token budget (typically a few hundred to ~1k tokens).
- **Measured, not promised.** In controlled A/Bs with a small model on Playwright and Django, agents using Cairn were not faster (about +2 to +7 s per task) and not clearly cheaper. See [docs/waymark/ab-results.md](docs/waymark/ab-results.md). Try it on your own repo and check `cairn waymark stats`.
- **Local only.** Everything runs on your machine in a SQLite database. Nothing is uploaded, and the code makes no network calls. Cairn excludes common sensitive paths and redacts recognised secrets, but detection is not exhaustive; avoid indexing repositories containing secrets you cannot safely store locally.
- **Honest numbers.** `cairn waymark stats` reports only what it observed (adoption, follow-through, fallbacks), not estimated savings. See [docs/waymark/evaluating.md](docs/waymark/evaluating.md).

## Install

Needs Node 24 or newer.

```sh
git clone https://github.com/Nishanth1812/Cairn.git
cd Cairn && npm ci && npm run build && npm link   # puts `cairn` on your PATH
cairn waymark init                                # create config and state directories
cairn waymark setup                               # managed instructions for Claude Code, Codex, OpenCode
                                                  #   (--dry-run to preview, --harness claude-code,codex to pick)
                                                  #   pass --hooks to opt into Claude Code lifecycle hooks
cairn doctor                                      # verify the setup
```

Release tarballs are attached to each [GitHub release](https://github.com/Nishanth1812/Cairn/releases) (`npm i -g <tarball>`).

## Use

Run these from any git repo. The first lookup indexes it; later lookups refresh only what changed.

```sh
cairn waymark context "where is auth handled"      # ranked snippets packed to a token budget
cairn waymark search "retryRequest"                # ranked hits
cairn waymark search --exact "TODO(auth)"          # case-insensitive literal matches, file:line (not regex)
cairn waymark search --kind function "*"           # definitions by kind
cairn waymark search --refs retryRequest           # functions and methods that use a symbol
cairn waymark search "class definitions in backend" # matching class symbols in the backend path
cairn waymark task start "migrate billing"         # name a long task; checkpoints are saved automatically
cairn waymark health                               # stale branches, dirty files
cairn waymark stats --since 7d                     # is it helping?
```

Add `--json` for machine output. `cairn waymark --help` lists every command.

## How it works

1. **Index.** Files are chunked along symbol boundaries and split above 60 lines or about 600 tokens. SQLite FTS5 weights file paths and symbol names above body mentions. Ignored files, binaries, and sensitive paths (`.env*`, keys) are skipped.
2. **Rank.** BM25 plus boosts for exact symbol definitions, path matches, referenced definitions and intent notes; tests, docs and import-only chunks are demoted unless the query asks for them. Class or function definition queries return matching symbols; route and page queries use file paths.
3. **Hooks.** Claude Code setup installs the managed instruction block only. Pass `--hooks` to `cairn waymark setup --harness claude-code --hooks` to install SessionStart, UserPromptSubmit, Stop and PreCompact hooks for session guidance, matched-location injection and checkpoints. Add `--tool-hints` to also install the per-tool PreToolUse hint; it implies `--hooks`. Hooks are advisory-only; tools stay available and feedback remains optional. Re-running setup without these flags removes Cairn hooks and preserves other tools' hooks.

State lives in the OS state directory (`%LOCALAPPDATA%\weft\state` on Windows, `$XDG_STATE_HOME/weft` elsewhere). `cairn waymark clean --yes` prunes stale index data; `cairn waymark setup --uninstall` removes the hooks and managed instruction blocks.

## Develop

```sh
npm ci
npm run check    # lint, typecheck, build, tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities per [SECURITY.md](SECURITY.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Licence

GPL-3.0-only.
