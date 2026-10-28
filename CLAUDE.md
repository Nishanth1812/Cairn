<!-- BEGIN WEFT MANAGED BLOCK -->
# Weft Core Guidelines
- To explore code, call the `weft_context` / `weft_search` MCP tools (CLI: `weft context "<query>"`) instead of Grep, Glob or reading whole files (Grep only for an exact string Weft misses, including in subagents); use `weft_read` for exact line ranges.
- Checkpoints are saved automatically; only run `weft task start <title>` to name a long task.
<!-- END WEFT MANAGED BLOCK -->
