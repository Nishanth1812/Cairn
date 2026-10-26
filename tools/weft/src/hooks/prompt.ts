import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../storage/db.js';
import { hookGitRoot, repoFor } from './claude.js';
import { estimateTokens } from '../core/estimate/tokenEstimator.js';
import { redactSafe } from '../core/security/redactor.js';
import { recordToolCall } from '../telemetry/toolCalls.js';

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
    const started = Date.now();
    const generation = (db.prepare('SELECT active_generation AS g FROM repo_index_state WHERE repo_id = ?').get(repo.id) as { g: number | null } | undefined)?.g;
    if (generation == null) return '';
    const hits = new Map<string, { line: string; size: number; rank: number }>();
    const add = (key: string, line: string, size: number, rank: number) => { if (!hits.has(key)) hits.set(key, { line, size, rank }); };
    if (identifiers.length) {
      const rows = db.prepare(`SELECT s.name, s.kind, s.start_line AS startLine, s.end_line AS endLine, f.path, f.size_bytes AS size FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.repo_id = ? AND f.generation_id = ? AND s.name IN (${identifiers.map(() => '?').join(',')}) LIMIT 20`)
        .all(repo.id, generation, ...identifiers) as Array<{ name: string; kind: string; startLine: number; endLine: number; path: string; size: number }>;
      for (const row of rows) add(`${row.path}:${row.startLine}`, `${row.path}:${row.startLine}${row.endLine > row.startLine ? `-${row.endLine}` : ''}  ${row.name} (${row.kind})`, row.size, 0);
    }
    for (const file of files) {
      const path = file.replace(/^\.?\//, '').toLowerCase();
      const rows = db.prepare("SELECT path, size_bytes AS size FROM files WHERE repo_id = ? AND generation_id = ? AND (lower(path) = ? OR lower(path) LIKE '%/' || ?) LIMIT 3").all(repo.id, generation, path, path) as Array<{ path: string; size: number }>;
      for (const row of rows) add(row.path, row.path, row.size, 1);
    }
    // A plain word counts only when it names one to three source files; "index" or "config" would match half the repo.
    for (const word of words) {
      const rows = db.prepare("SELECT path, size_bytes AS size FROM files WHERE repo_id = ? AND generation_id = ? AND path NOT LIKE '%.md' AND (lower(path) LIKE '%/' || ? || '.%' OR lower(path) LIKE ? || '.%') LIMIT 4").all(repo.id, generation, word, word) as Array<{ path: string; size: number }>;
      if (rows.length >= 1 && rows.length <= 3) for (const row of rows) add(row.path, row.path, row.size, 2);
    }
    const picked = [...hits.values()].sort((a, b) => a.rank - b.rank).slice(0, MAX_LOCATIONS);
    if (!picked.length) return '';
    let list = picked.map((hit) => hit.line).join('\n');
    while (estimateTokens(list) > MAX_TOKENS && picked.length > 1) { picked.pop(); list = picked.map((hit) => hit.line).join('\n'); }
    const text = redactSafe(`Weft located what this request names (read by line range with mcp__weft__weft_read, or use weft_context to explore, instead of grepping or reading whole files):\n${list}`);
    try { recordToolCall(db, { repoId: repo.id, tool: 'hook_prompt', returnedTokens: estimateTokens(text), baselineTokens: picked.reduce((sum, hit) => sum + Math.ceil(hit.size / 4 * 1.1), 0), ms: Date.now() - started }); } catch { /* Telemetry must not interrupt the session. */ }
    return text;
  } finally { db.close(); }
}

const LARGE_READ_BYTES = 32 * 1024;

/** PreToolUse(Read): a whole-file read of a big file in an indexed repo costs context on every later turn, so suggest a ranged read instead. Never blocks. */
export async function runReadNudge(options: { cwd?: string; stateDir: string; filePath?: string; ranged?: boolean }): Promise<string> {
  if (!options.filePath || options.ranged || /(?:lock\.json|\.lock|\.min\.\w+|\.map)$/i.test(options.filePath)) return '';
  const size = await stat(options.filePath).then((info) => (info.isFile() ? info.size : 0), () => 0);
  if (size < LARGE_READ_BYTES) return '';
  const root = await hookGitRoot(resolve(options.cwd ?? process.cwd()));
  if (!root) return '';
  const db = openDatabase(options.stateDir);
  try {
    if (!repoFor(db, root)) return '';
  } finally { db.close(); }
  const tokens = Math.ceil(size / 4 * 1.1);
  const additionalContext = `This file is about ${Math.round(tokens / 1000)}K tokens and every later turn re-reads it from context. Prefer mcp__weft__weft_search / weft_context to find the part you need, then Read with offset and limit (or weft_read by line range).`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } });
}
