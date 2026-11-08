<!-- BEGIN WEFT MANAGED BLOCK -->
# Cairn Context Core Guidelines
- For code questions that span files or need orientation, run `cairn context "<question>"` for ranked, token-budgeted context.
- For an exact text or identifier match, run `cairn context search "<term>" --exact`; to find a symbol's usages across files, run `cairn context search "<symbol>" --refs`.
- Do not use Cairn Context for small files, line ranges you already know, or pure git diff review; Grep/Read remain fine for those cases.
- Answer from the Cairn result; read only missing lines from files with a narrow range.
- To audit assistant-session retrieval waste, run `cairn optimize audit --consent --project .`; review the report before making changes.
<!-- END WEFT MANAGED BLOCK -->
