import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../storage/db.js';
import { hookGitRoot, repoFor } from './claude.js';
import { estimateTokens } from '../core/estimate/tokenEstimator.js';
import { redactSafe } from '../core/security/redactor.js';
import { refreshIndex } from '../indexer/refresh.js';
import { recordToolCall } from '../telemetry/toolCalls.js';
import { migrate } from '../storage/migrator.js';

const MAX_LOCATIONS = 6;
const MAX_TOKENS = 350;
const isIdentifier = (word: string) => /[a-z][A-Z]/.test(word) || word.includes('_') || (/\d/.test(word) && /[A-Za-z]/.test(word));

/** Names a prompt mentions that can be looked up exactly: code identifiers, file names and plain words long enough to be a file's base name. */
export function promptTerms(prompt: string): { identifiers: string[]; files: string[]; words: string[] } {
  const files = [...new Set(prompt.match(/[\w./\\-]+\.[A-Za-z0-9]{1,5}\b/g) ?? [])].map((file) => file.replace(/\\/g, '/'));
  const tokens = [...new Set(prompt.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])];
  return {
    identifiers: tokens.filter(isIdentifier).slice(0, 12),
    files: files.slice(0, 6),
    words: tokens.filter((word) => word.length >= 5 && !isIdentifier(word)).map((word) => word.toLowerCase()).slice(0, 15),
  };
}

/** Points the agent at code the prompt names (symbols, files) so it does not have to remember to ask Weft. Silent when nothing matches exactly. */
export async function runPromptHook(options: { cwd?: string; stateDir: string; prompt: string }): Promise<string> {
  const prompt = options.prompt.trim();
  if (prompt.length < 15 || prompt.startsWith('/')) return '';
  const { identifiers, files, words } = promptTerms(prompt);
  if (!identifiers.length && !files.length && !words.length) return '';
  const root = await hookGitRoot(resolve(options.cwd ?? process.cwd()));
  if (!root) return '';
  const db = openDatabase(options.stateDir);
  try {
    const repo = repoFor(db, root);
    if (!repo) return '';
    await refreshIndex(db, repo.id, root, { reindex: false }); // stale line numbers would mislead; a patch is a few stats
    const started = Date.now();
    const generation = (db.prepare('SELECT active_generation AS g FROM repo_index_state WHERE repo_id = ?').get(repo.id) as { g: number | null } | undefined)?.g;
    if (generation == null) return '';
    const hits = new Map<string, { line: string; rank: number }>();
    const add = (key: string, line: string, rank: number) => { if (!hits.has(key)) hits.set(key, { line, rank }); };
    if (identifiers.length) {
      const rows = db.prepare(`SELECT s.name, s.kind, s.start_line AS startLine, s.end_line AS endLine, f.path FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.repo_id = ? AND f.generation_id = ? AND s.name IN (${identifiers.map(() => '?').join(',')}) LIMIT 20`)
        .all(repo.id, generation, ...identifiers) as Array<{ name: string; kind: string; startLine: number; endLine: number; path: string }>;
      for (const row of rows) add(`${row.path}:${row.startLine}`, `${row.path}:${row.startLine}${row.endLine > row.startLine ? `-${row.endLine}` : ''}  ${row.name} (${row.kind})`, 0);
    }
    for (const file of files) {
      const path = file.replace(/^\.?\//, '').toLowerCase();
      const rows = db.prepare("SELECT path FROM files WHERE repo_id = ? AND generation_id = ? AND (lower(path) = ? OR lower(path) LIKE '%/' || ?) LIMIT 3").all(repo.id, generation, path, path) as Array<{ path: string }>;
      for (const row of rows) add(row.path, row.path, 1);
    }
    // A plain word counts only when it names one to three source files; "index" or "config" would match half the repo.
    for (const word of words) {
      const rows = db.prepare("SELECT path FROM files WHERE repo_id = ? AND generation_id = ? AND path NOT LIKE '%.md' AND (lower(path) LIKE '%/' || ? || '.%' OR lower(path) LIKE ? || '.%') LIMIT 4").all(repo.id, generation, word, word) as Array<{ path: string }>;
      if (rows.length >= 1 && rows.length <= 3) for (const row of rows) add(row.path, row.path, 2);
    }
    const picked = [...hits.values()].sort((a, b) => a.rank - b.rank).slice(0, MAX_LOCATIONS);
    if (!picked.length) return '';
    let list = picked.map((hit) => hit.line).join('\n');
    while (estimateTokens(list) > MAX_TOKENS && picked.length > 1) { picked.pop(); list = picked.map((hit) => hit.line).join('\n'); }
    const text = redactSafe(`Weft located what this request names (Read just those line ranges with offset and limit, or run cairn waymark context "<question>", instead of grepping or reading whole files):\n${list}`);
    try { recordToolCall(db, { repoId: repo.id, tool: 'hook_prompt', session: null, returnedTokens: estimateTokens(text), ms: Date.now() - started }); } catch { /* Telemetry must not interrupt the session. */ }
    return text;
  } finally { db.close(); }
}

const LARGE_READ_BYTES = 32 * 1024;
// Native lookups an agent may run before it files feedback; every feedback buys this many more.
const SWEEP_DENIALS = 2;
// Binary files are not text lookups: Waymark cannot search them, and opening a screenshot is not a sweep.
const BINARY_FILE = /\.(?:png|jpe?g|gif|webp|bmp|ico|svg|pdf)$/i;

const deny = (reason: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

// A Bash command that searches files: grep, rg, ag or find as its first word of a command, after an optional sudo or xargs. A pipe filter ("npm test | grep fail") is not a search.
const BASH_SEARCH = /^(?:(?:sudo|xargs)\s+)?(?:e?grep|fgrep|rg|ag|find)(?=\s|$)/;
export function isBashSearch(command: string): boolean {
  return command.split(/&&|\|\||;|\n|\(/).some((segment) => BASH_SEARCH.test(segment.trim()));
}

// Waymark's own commands stay open to a blocked agent: they are how it searches and files feedback. Quoted text (a feedback note) may hold anything; chaining or redirecting may not.
const WAYMARK_COMMAND = /^cairn waymark (?:search|context|feedback|stats)(?:\s|$)/;
export function isWaymarkCommand(command: string): boolean {
  const trimmed = command.trim();
  return WAYMARK_COMMAND.test(trimmed) && !/[&;|`\n<>]|\$\(/.test(trimmed.replace(/"[^"]*"|'[^']*'/g, '""'));
}

const BASH_SEARCH_TOOL = 'Bash-search';
// A whole-file read of a large file: recorded apart from small reads so the gate and stats can tell them apart.
const WHOLE_READ_TOOL = 'Read-whole';
// Lookups that count toward an agent's allowance.
const SWEEP_TOOLS = ['Grep', 'Glob', BASH_SEARCH_TOOL, WHOLE_READ_TOOL];

/** PreToolUse(*): every native lookup is counted per agent (subagents included). A file search (Grep, Glob, grep/rg/find in Bash) or a whole-file read of a large file is a sweep. An agent gets SWEEP_DENIALS sweeps before it must file feedback, and each feedback buys SWEEP_DENIALS more. Past that allowance every tool is blocked except Waymark's own commands, so the agent cannot move on without saying what went wrong. Repos Waymark has not indexed are gated too; the denial points at `cairn waymark search`, which indexes them on first use. */
export async function runReadNudge(options: { cwd?: string; stateDir: string; filePath?: string; ranged?: boolean; tool?: string; command?: string; session?: string }): Promise<string> {
  const command = options.command ?? '';
  if (options.tool === 'Bash' && isWaymarkCommand(command)) return '';
  const binary = BINARY_FILE.test(options.filePath ?? '');
  const lockOrMinified = /(?:lock\.json|\.lock|\.min\.\w+|\.map)$/i.test(options.filePath ?? '');
  const size = options.tool === 'Read' && !binary && !options.ranged && options.filePath && !lockOrMinified ? await stat(options.filePath).then((info) => (info.isFile() ? info.size : 0), () => 0) : 0;
  const whole = size >= LARGE_READ_BYTES;
  const lookup = options.tool === 'Bash' ? (isBashSearch(command) ? BASH_SEARCH_TOOL : undefined)
    : options.tool === 'Read' ? (binary ? undefined : whole ? WHOLE_READ_TOOL : 'Read')
      : options.tool === 'Grep' || options.tool === 'Glob' ? options.tool : undefined;
  const sweep = lookup !== undefined && SWEEP_TOOLS.includes(lookup);
  const root = await hookGitRoot(resolve(options.cwd ?? process.cwd()));
  const db = openDatabase(options.stateDir);
  let sweeps = 0, feedback = 0;
  try {
    migrate(db); // the hook can run before any CLI command has migrated this database
    const repoId = root ? repoFor(db, root)?.id ?? null : null;
    // Lookups are recorded only in a git checkout. Sweeps count even in a repo Waymark has not indexed yet; other lookups only where it has.
    if (lookup && root && (repoId || sweep)) { try { recordToolCall(db, { repoId, tool: lookup, session: options.session ?? null, returnedTokens: 0, ms: null }); } catch { /* Telemetry must not interrupt the session. */ } }
    if (options.session) {
      sweeps = (db.prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE session = ? AND tool IN (${SWEEP_TOOLS.map(() => '?').join(', ')})`).get(options.session, ...SWEEP_TOOLS) as { n: number }).n;
      feedback = (db.prepare('SELECT COUNT(*) AS n FROM lookup_feedback WHERE session = ?').get(options.session) as { n: number }).n;
    }
  } finally { db.close(); }
  if (options.session) {
    const allowance = SWEEP_DENIALS * (1 + feedback);
    const file = `cairn waymark feedback --session "${options.session}" --query "<the cairn waymark search you ran>" --kind miss|bad_output|error "<what went wrong>"`;
    if (sweeps > allowance) return deny(`Blocked: this agent has run ${sweeps} native lookups and filed ${feedback} feedback, which covers ${allowance}. Until it files feedback, every tool is blocked except cairn waymark search, context, feedback and stats. Run \`cairn waymark search "<term>"\` on the lookup, then file what went wrong with \`${file}\`.`);
    if (sweep && !feedback && sweeps <= SWEEP_DENIALS) return deny(`Waymark can search this repo. Run \`cairn waymark search "<term>"\` (it indexes the repo on first use) or \`cairn waymark context "<question>"\` first. If it misses or returns bad output, file that with \`${file}\`, then repeat this lookup.`);
  }
  if (!sweep) return '';
  const tokens = Math.ceil(size / 4 * 1.1);
  const additionalContext = whole
    ? `This file is about ${Math.round(tokens / 1000)}K tokens and every later turn re-reads it from context. Run cairn waymark search "<term>" to find the part you need, then Read with offset and limit.`
    : 'Waymark can search this repo: run `cairn waymark search "<term>"` or `cairn waymark context "<question>"` first (ranked, token-budgeted); use Grep, Glob or a Bash grep/rg/find only for an exact string it missed.';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } });
}
