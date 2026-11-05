# Contributing

Thanks for helping. Cairn is small on purpose: prefer the simplest change that fully solves the problem.

## Setup

Node 24 or newer.

```sh
npm ci
npm run check    # lint, typecheck, build, tests; CI runs this on Linux and Windows
```

Tests use `node --test` and live in `tests/waymark/`. They run the built CLI, so run `npm run build` before `npm test` when you change `src/`.

## Before you open a PR

- Add or update a test for any behaviour change.
- Ranking or indexing change: run `cairn context bench retrieval` before and after and say what moved. A lower hit count needs a reason.
- Keep it local-only: no network calls, no telemetry that leaves the machine.
- Never log or store secrets; go through `src/waymark/core/security`.
- Add a line to `CHANGELOG.md` under "Unreleased".

## Bugs and ideas

Open an issue with the command you ran, the output, your OS and Node version, and `cairn doctor` output. For a bad lookup, include the query and what you expected (`cairn context feedback` records the same).

By contributing you agree your work is licensed under GPL-3.0-only.
