<!-- BEGIN WEFT MANAGED BLOCK -->
# Waymark Core Guidelines
- To explore code, run `cairn waymark context "<query>"` (or `cairn waymark search "<query>"`) in the shell before Grep, Glob, `rg`, `find` or reading whole files (Grep only for an exact string it misses, including in subagents); then Read just the lines you need with offset and limit.
- Checkpoints are saved automatically; only run `cairn waymark task start <title>` to name a long task.
- Grep, Glob, grep, rg or find run in Bash, and whole-file Reads of large files are gated per agent: the first two are denied in favour of Waymark. Read a large file with offset and limit where you can. If Waymark misses or returns bad output, file it with `cairn waymark feedback --session "<key>" --query "<the search you ran>" --kind miss|bad_output|error "<what went wrong>"` (the denial shows your key); each feedback unlocks two more lookups, and past that every other tool is blocked until feedback is filed.
<!-- END WEFT MANAGED BLOCK -->
