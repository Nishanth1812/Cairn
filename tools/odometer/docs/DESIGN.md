# Design notes

One page, one column. The top is what happened in the last 24 hours; below it is history. It is a tool you
leave open on a second monitor, so nothing should compete for attention except the big number.

## Rules

1. **One loud element.** The tokens-processed-in-24-hours number is the only large type on the page.
   Next to it, a 5-minute burn rate shows whether work is happening now.
2. **No cards.** Sections are separated by whitespace and a hairline rule, tables by hairlines.
3. **Colour means something.** Colour is only used for tool identity and status (good / warn /
   bad). Chrome is greyscale; `--accent` is used for focus rings and the gauge mark.
4. **Numbers are monospaced.** `Cascadia Mono` with tabular figures, so columns line up and a
   changing digit does not shift the layout.
5. **Say the unit.** `tok/s`, `ms`, `$`, `tokens`, and the exact definition in the "How these
   numbers are measured" footer or a column tooltip.
6. **Dark only.** There is no light theme and no toggle.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--bg` | `#12151a` | page |
| `--ink` / `--ink2` / `--mute` | `#e7eaee` / `#b2b9c2` / `#7e8792` | text levels |
| `--rule` / `--soft` | `#2a3039` / `#1d2229` | section rules / table rows |
| `--accent` | `#7da2ff` | focus, links, mark |

Tool identity: Claude Code, OpenCode, Codex and Antigravity each have one colour (see
`web/style.css`).

## Behaviour

- Containers are rewritten only when their HTML changes (`put()` in `web/app.js`), so hover,
  text selection, focus and scroll survive a refresh. Nothing is rebuilt on a timer for show.
- One poll loop: the last 24 hours every 5 seconds (Last 24 hours), the chosen range at most every 30
  seconds (History), never two requests at once. A failed poll keeps what is on screen and the
  live dot turns "stale".
- The usage chart is an inline SVG sized from its container's width at a fixed 220px height, so
  nothing shifts when it redraws.
- The chosen range is remembered in `localStorage`.

## Interaction

- Range (1d / 7d / 30d / All) and the chart metric (Tokens / Cost) are the only controls, plus Rescan.
- `?compact` shows only the Last 24 hours block, for a narrow side window (`stats.mjs --compact`).
- `prefers-reduced-motion` is respected: the UI has no animation.
