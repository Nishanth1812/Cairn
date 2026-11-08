# Cairn — Proposed Developer Tools

Cairn is an open-source ecosystem of modular developer tools designed to improve coding workflows, reduce unnecessary AI/token costs, and make AI-assisted development more efficient. Each tool should work independently with its own CLI, while a unified Cairn CLI can bring them together later.

## 1. Cairn Context
Indexes repositories and retrieves relevant files, symbols, and dependencies for a coding task. Supports fast code search and prepares focused context for developers and AI agents.

## 2. Cairn Optimize
Reduces unnecessary AI context by removing duplicate or irrelevant material, reusing cached retrieval results, and enforcing token budgets. Prioritizes relevant retrieval before compression.

## 3. Cairn Meter
Tracks AI usage, estimated token costs, latency, and spending across supported providers or workflows. Helps developers understand where costs come from and measure potential savings.

## 4. Cairn Parallel
Manages parallel coding tasks using isolated Git worktrees. Can launch supported coding-agent CLIs, track task status, and make changes easier to review without tasks interfering with each other.

## 5. Cairn Map
Explores repository architecture by mapping symbols, imports, callers, callees, and dependencies. Helps developers understand unfamiliar code and estimate the impact of changing a component.

## 6. Cairn Run
Runs repeatable development workflows such as setup, linting, tests, builds, and deployment checks through simple, configurable commands. Produces clear logs and diagnostics when commands fail.

## 7. Cairn Verify
Analyzes code changes and selects relevant tests and quality checks. Reports failures and helps developers assess whether a change is ready for review.

## 8. Cairn Recall
Maintains searchable project knowledge, including architectural decisions, bug investigations, failed approaches, and trade-offs. Retrieves relevant notes across coding sessions while keeping stored information inspectable.

## Proposed Development Approach
- Develop the tools sequentially in a monorepo.
- Keep each tool independently usable and installable.
- Share code only through small, explicit public APIs and common packages where genuinely useful.
- Build the unified Cairn CLI after the standalone tools are established, reusing each tool's implementation rather than duplicating functionality.
- Benchmark performance, retrieval quality, reliability, and cost savings before making quantitative claims.
