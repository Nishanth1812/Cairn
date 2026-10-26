# FAQ

Answers grounded in the code: docs/CONTRACT.md (the request record), web/app.js (the metrics),
store.mjs + pricing.mjs (windows and list prices), collectors/*.mjs (per source), tools/selftest.mjs.

### 1. What exactly is a "request"? Why does one prompt of mine become many requests?
A request is one model API call — one assistant response — *not* one of your prompts (docs/CONTRACT.md).

Agents work in a loop: the model replies with a tool call, the harness runs the tool, and the tool
result goes back as a new API call, over and over until the model answers. Reads, edits and every
subagent spawn are separate requests, so one prompt of yours may be hundreds. The Turns view
expands a turn into every request inside it.

### 2. Why are most of my tokens cache reads instead of fresh input?
Every request re-sends the whole conversation so far, and the provider serves the prefix seen
before from its cache. In `web/app.js` cache hit is `cacheRead / (fresh input + cache read + cache write)`.
Late in a long session almost all of the context was already sent, so reuse dominates — that is
caching working for you, not an accounting error.

### 3. What is the difference between "tokens processed" and "newly paid"?
*Processed* = fresh input + cache read + cache write + output: everything passing through the API.
*Newly paid* = fresh input + cache write + output: the tokens the provider bills as new, since
cache reads are re-sends billed at a discount (see the footer of the page).
The gap between the two numbers is what caching saved you.

### 4. What is the API-equivalent dollar figure, and why does it not match my subscription bill?
It is what this usage would have cost on the pay-as-you-go API at list prices (`pricing.mjs`,
rates from `~/.t3/userdata/usage-model-rates.json`, override with `TOKEN_BURNING_RATES`).
A plan bills a flat subscription, never per token, so your invoice cannot show this. Claude cache
reads price at one-tenth of input, cache writes at 1.25× input (>1h TTL ≈ 2×); tool-reported
costs are used when available, and a `~` marks partly estimated totals. List-price shortcuts
ignore long-context and priority/batch tiers (comment in `pricing.mjs`).

### 5. Why is the measured tokens/sec lower than what the provider advertises?
The dashboard computes `output / durMs` only for requests with a real generation phase
(`web/app.js`), and `durMs` **includes time-to-first-token**: queueing and prompt processing.
It also skips calls shorter than 30 output tokens and drops durations over 10 minutes,
which are "waiting on user/tools, not generation" (`tools/selftest.mjs`, `collectors/claude.mjs`).
Advertised speeds exclude that latency, and reasoning tokens here count as output.

### 6. What counts as a "turn", and why do some turns contain hundreds of requests?
A turn is all requests answering one user prompt: its id is the prompt's id, shared by every
request until the next real human prompt (docs/CONTRACT.md). `collectors/claude.mjs` starts a
turn only at a human message — system reminders, command echo and compact summaries do not.
Subagent work is attributed to the main turn active when the subagent was spawned. One prompt
then contains the whole agentic loop, tool calls included — hence hundreds of requests, and
wall time spanning minutes.

### 7. Why does Antigravity show no speed and no duration?
Its logs cannot tell us: `collectors/antigravity.mjs` sets `durMs: null` because the only gap
it can decode reflects time between calls, which includes tool execution, not request wall time.
So tok/s, "Took" and latency show `–`. Antigravity still shows up in the volume, cache, cost,
provider, turn and breakdown views — only its speed and duration are unavailable. Tool names are
missing for the same reason. See "Known gaps" in README.md and docs/antigravity-findings.md.

### 8. Why does my cache hit rate dip, and what should I do about it?
Most dips are real and expected: the cache expired after an idle gap, or the prompt prefix
changed (new project, branch, or a big initial cache write). The Overview calls out the worst
drop — more than 15 points between adjacent buckets — as "Cache went cold" (`web/app.js`).
Nothing to fix: a cold start is paid once as a cache write, then reuse resumes as you keep
working in the same session.

### 9. Which provider should I use for a big task?
Answer it with the By model table in History (`web/app.js`): compare
rows — requests, tokens, cache hit, median tok/s, median latency and API $. Check the Codex
plan-limit bar (from `collectors/codex.mjs` `rateLimits()`) for throttling. Compare your own
numbers; the dashboard deliberately writes no opinions.

### 10. How do I verify the numbers are right?
Run `node tools/selftest.mjs` (or `--json` for machine output; exit code 0/1). It collects the
last 7 days from every collector and checks eight invariants: tokens are finite and positive
summing, ids are unique and non-empty (no double counting), cache ratio ∈ [0,1], durations ≤
10 min and real numbers, no speed above 1500 tok/s (a timing bug — anything between 400 and 1500
is reported as fast but plausible), turns never mix tools or sessions, timestamps in a sane
window, and an empty source is SKIP while present-but-unparsable files are FAIL. A speed
anomaly is a warning: the run still exits 0. Each collector also self-tests when run directly
(`node collectors/<name>.mjs`), as does `node pricing.mjs`.

### 11. What files does this read from my machine, and does anything leave it?
Read-only: `~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**` (+ `archived_sessions`),
`~/.local/share/opencode/opencode.db` (temp snapshot only if the live WAL read fails),
the Antigravity conversation databases under the paths in `collectors/antigravity.mjs`, and the
rates file. Nothing is sent anywhere: the server binds `127.0.0.1` (`server.mjs`). The only writes
are the collector parse caches in `.cache/` and short-lived copies of the OpenCode and Antigravity
SQLite files in the OS temp directory, deleted as soon as they are read
(`collectors/opencode.mjs`, `collectors/antigravity.mjs`). The footer repeats this on every page.

### 12. How do I add a new source?
Create `collectors/<id>.mjs` following docs/CONTRACT.md: export `meta = { id, label, root }` and
`collect({ since }) -> Req[]`. Rules: never throw on a missing source (return `[]`), never write
to it, skip malformed lines, dedupe by stable `tool:…` id, and normalise OpenAI-style usage
(input includes cached → subtract) vs Anthropic's (already excludes). `store.mjs` auto-discovers
any `collectors/*.mjs` file with a `collect` export — no registration needed, duplicate ids are
reported. Document reverse-engineering evidence per docs/collector-audit.md.

### 13. How do I run it, and what are the useful flags?
    node --no-warnings server.mjs [port]   # http://127.0.0.1:4747; PORT env or first arg
    node --no-warnings stats.mjs --watch   # same numbers in a terminal, refreshed
    node tools/selftest.mjs --json         # invariant checks, machine-readable

In the UI `?compact` gives a narrow side-window layout showing only the last 24 hours (`web/app.js`, design rules in docs/DESIGN.md). The theme is dark only, the time range covers 1d/7d/30d/All,
and Rescan (`?refresh`) forces a re-read of every source.
