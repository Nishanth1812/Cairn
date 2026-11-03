import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { openDatabase } from '../storage/db.js';
import { hookGitRoot, repoFor } from './claude.js';
import { estimateTokens } from '../core/estimate/tokenEstimator.js';
import { redactSafe } from '../core/security/redactor.js';
import { recordToolCall } from '../telemetry/toolCalls.js';
import { migrate } from '../storage/migrator.js';

const MAX_LOCATIONS = 3;
const MAX_TOKENS = 350;
const isIdentifier = (word: string) => /[a-z][A-Z]/.test(word) || word.includes('_') || (/\d/.test(word) && /[A-Za-z]/.test(word));

/** Names a prompt mentions that can be looked up exactly: code identifiers, file names and plain words long enough to be a file's base name. */
export function promptTerms(prompt: string): { identifiers: string[]; files: string[]; words: string[] } {
  const files = [...new Set(prompt.match(/[\w./\\-]+\.[A-Za-z0-9]{1,5}\b/g) ?? [])].map((file) => file.replace(/\\/g, '/'));
  const tokens = [...new Set(prompt.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])];
  return {
    identifiers: tokens.filter(isIdentifier).slice(0, 12),
    files: files.slice(0, 6),
    words: tokens.filter((word) => word.length >= 5 && !isIdentifier(word)).map((word) => word.toLowerCase()).slice(0, 6),
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
    const text = redactSafe(`Cairn matched names in this request:\n${list}`);
    try { recordToolCall(db, { repoId: repo.id, tool: 'hook_prompt', session: null, returnedTokens: estimateTokens(text), ms: Date.now() - started }); } catch { /* Telemetry must not interrupt the session. */ }
    return text;
  } finally { db.close(); }
}

const LARGE_READ_BYTES = 32 * 1024;
const MAX_ADVISORIES = 2;
// Binary files are not text lookups: Waymark cannot search them, and opening a screenshot is not a sweep.
const BINARY_FILE = /\.(?:png|jpe?g|gif|webp|bmp|ico|svg|pdf)$/i;

// A Bash command that searches files: grep, rg, ag or find as its first word of a command, after an optional sudo or xargs. A pipe filter ("npm test | grep fail") is not a search.
const BASH_SEARCH = /^(?:(?:sudo|xargs)\s+)?(?:e?grep|fgrep|rg|ag|find)(?=\s|$)/;
export function isBashSearch(command: string): boolean {
  return command.split(/&&|\|\||;|\n|\(/).some((segment) => BASH_SEARCH.test(segment.trim()));
}

// "grep -c FAILED /tmp/test.log": a search whose file arguments all lie outside the repo is not a code search Waymark could have answered.
export function searchesOutsideRepo(command: string, cwd: string, root: string | null): boolean {
  if (!root) return false;
  const segments = command.split(/&&|\|\||;|\n|\(/).map((segment) => segment.trim()).filter((segment) => BASH_SEARCH.test(segment));
  return segments.length > 0 && segments.every((segment) => {
    // Words up to the first pipe, without redirections: `grep x file.log | head` searches only file.log.
    const tokens = (segment.split('|')[0]!.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).filter((token) => !/^\d*[<>&]/.test(token));
    const grepLike = /^(?:(?:sudo|xargs)\s+)?(?:e?grep|fgrep|rg|ag)(?=\s|$)/.test(segment);
    // find takes its paths before the first expression; grep, rg and ag take the pattern first, then paths, with flags anywhere.
    // `-e PATTERN` and flag values (`-A 3`) read as extra operands, which can only keep a search gated, never exempt one.
    const words = tokens.slice(1);
    const operands = grepLike ? words.filter((token) => !token.startsWith('-')).slice(1) : words.slice(0, Math.max(0, words.findIndex((token) => /^[-!(]/.test(token)) === -1 ? words.length : words.findIndex((token) => /^[-!(]/.test(token))));
    const paths = operands.map((token) => token.replace(/^["']|["']$/g, ''));
    return paths.length > 0 && paths.every((path) => {
      if (path.startsWith('~')) return true;
      const inside = relative(root, resolve(cwd, path));
      return inside.startsWith('..') || isAbsolute(inside);
    });
  });
}

const BASH_SEARCH_TOOL = 'Bash-search';
// A whole-file read of a large file is counted separately for adoption statistics.
const WHOLE_READ_TOOL = 'Read-whole';
const SWEEP_TOOLS = ['Grep', 'Glob', BASH_SEARCH_TOOL, WHOLE_READ_TOOL];

const ADVISORY = 'Cairn can answer this: cairn waymark context "<question>" (ranked, token-budgeted). Use grep/read freely for exact strings.';
const hasWildcard = (path: string) => /[*?{}\[\]]/.test(path);

async function exactFilePath(path: string | undefined, cwd: string): Promise<boolean> {
  if (!path || hasWildcard(path)) return false;
  const info = await stat(resolve(cwd, path)).catch(() => undefined);
  return !info || info.isFile();
}

async function isBroadSweep(options: { cwd: string; tool?: string; command: string; filePath?: string; ranged?: boolean; path?: string; pattern?: string }, root: string | null, whole: boolean): Promise<boolean> {
  if (options.tool === 'Read') return whole;
  if (options.tool === 'Grep') return !await exactFilePath(options.path, options.cwd);
  if (options.tool === 'Glob') return hasWildcard(options.pattern ?? '') || !await exactFilePath(options.pattern, options.cwd);
  if (options.tool !== 'Bash' || !isBashSearch(options.command) || searchesOutsideRepo(options.command, options.cwd, root)) return false;
  const segments = options.command.split(/&&|\|\||;|\n|\(/).map((segment) => segment.trim()).filter((segment) => BASH_SEARCH.test(segment));
  for (const segment of segments) {
    const tokens = (segment.split('|')[0]!.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).filter((token) => !/^\d*[<>&]/.test(token));
    const grepLike = /^(?:(?:sudo|xargs)\s+)?(?:e?grep|fgrep|rg|ag)(?=\s|$)/.test(segment);
    const words = tokens.slice(1).filter((token) => !token.startsWith('-'));
    const paths = grepLike ? words.slice(1) : words.slice(0, Math.max(0, words.findIndex((token) => /^[-!(]/.test(token)) < 0 ? words.length : words.findIndex((token) => /^[-!(]/.test(token))));
    if (!paths.length) return true;
    for (const path of paths) if (hasWildcard(path) || !await exactFilePath(path.replace(/^['"]|['"]$/g, ''), options.cwd)) return true;
  }
  return false;
}

/** PreToolUse records native lookup telemetry and may offer two optional, per-session hints in indexed repos. */
export async function runReadNudge(options: { cwd?: string; stateDir: string; filePath?: string; path?: string; pattern?: string; ranged?: boolean; tool?: string; command?: string; session?: string }): Promise<string> {
  const command = options.command ?? '';
  const cwd = resolve(options.cwd ?? process.cwd());
  const binary = BINARY_FILE.test(options.filePath ?? '');
  const lockOrMinified = /(?:lock\.json|\.lock|\.min\.\w+|\.map)$/i.test(options.filePath ?? '');
  const size = options.tool === 'Read' && !binary && !options.ranged && options.filePath && !lockOrMinified ? await stat(resolve(cwd, options.filePath)).then((info) => (info.isFile() ? info.size : 0), () => 0) : 0;
  const whole = size >= LARGE_READ_BYTES;
  const root = await hookGitRoot(cwd);
  const lookup = options.tool === 'Bash' ? (isBashSearch(command) && !searchesOutsideRepo(command, resolve(options.cwd ?? process.cwd()), root) ? BASH_SEARCH_TOOL : undefined)
    : options.tool === 'Read' ? (binary ? undefined : whole ? WHOLE_READ_TOOL : 'Read')
      : options.tool === 'Grep' || options.tool === 'Glob' ? options.tool : undefined;
  const sweep = lookup !== undefined && SWEEP_TOOLS.includes(lookup);
  const broad = sweep && await isBroadSweep({ cwd, tool: options.tool, command, filePath: options.filePath, ranged: options.ranged, path: options.path, pattern: options.pattern }, root, whole);
  // Where a Read landed, relative to the repo, so stats can tell whether the agent read a file a lookup returned.
  const relativeRead = options.tool === 'Read' && options.filePath && root ? relative(root, resolve(options.cwd ?? process.cwd(), options.filePath)).split(sep).join('/') : '';
  const readPaths = relativeRead && !relativeRead.startsWith('..') ? [relativeRead] : undefined;
  const db = openDatabase(options.stateDir);
  let advisory = false;
  try {
    migrate(db); // the hook can run before any CLI command has migrated this database
    const repoId = root ? repoFor(db, root)?.id ?? null : null;
    if (lookup && root && (repoId || sweep)) { try { recordToolCall(db, { repoId, tool: lookup, session: options.session ?? null, returnedTokens: 0, ms: null, paths: readPaths }); } catch { /* Telemetry must not interrupt the session. */ } }
    if (broad && options.session && repoId) {
      const indexed = (db.prepare('SELECT active_generation AS generation FROM repo_index_state WHERE repo_id = ?').get(repoId) as { generation: number | null } | undefined)?.generation;
      if (indexed != null) {
        advisory = db.transaction(() => {
          const count = (db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE session = ? AND tool = 'hook_advisory'").get(options.session) as { n: number }).n;
          if (count >= MAX_ADVISORIES) return false;
          recordToolCall(db, { repoId, tool: 'hook_advisory', session: options.session!, returnedTokens: 0, ms: null });
          return true;
        }).immediate();
      }
    }
  } finally { db.close(); }
  return advisory ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ADVISORY } }) : '';
}
