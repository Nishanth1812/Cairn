<!-- BEGIN WEFT MANAGED BLOCK -->
# Waymark Core Guidelines
- For code questions, you can run `cairn waymark context "<question>"` or `cairn waymark search "<term>"` first (ranked, token-budgeted); for exact text use `cairn waymark search --exact "<text>"`. Grep/Read remain fine for exact strings and known paths.
- Answer from the Cairn result; read a file only when it lacks a line you need (use offset/limit).
- Checkpoints are saved automatically; only run `cairn waymark task start <title>` to name a long task.
<!-- END WEFT MANAGED BLOCK -->
