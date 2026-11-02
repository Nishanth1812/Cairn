import type Database from 'better-sqlite3';
import { posix as path } from 'node:path';
import type { SearchResult } from './types.js';

export interface ReferenceHit { path: string; line: number; name: string; kind: string; referenceKind: 'call' | 'import' | 're-export' | 'module-level'; groupName: string }

export function searchChunks(db: Database.Database, repoId: string, query: string, limit = 20): SearchResult[] {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!terms.length || !Number.isFinite(limit) || limit < 1) return [];
  const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
  const state = db.prepare('SELECT active_generation FROM repo_index_state WHERE repo_id = ?').get(repoId) as { active_generation: number | null } | undefined;
  if (state?.active_generation == null) return [];
  // Symbols are looked up only for the rows that survive the LIMIT; doing it per match cost 4-5x the search itself.
  const rows = db.prepare(`
    WITH top AS MATERIALIZED (
      SELECT f.id AS fileId, f.path, c.start_line AS startLine, c.end_line AS endLine, c.safe_text AS safeText, bm25(chunk_fts, 6.0, 4.0, 1.0) AS rank
      FROM chunk_fts
      JOIN chunks c ON c.id = chunk_fts.rowid
      JOIN files f ON f.id = c.file_id
      WHERE chunk_fts MATCH ? AND f.repo_id = ? AND f.generation_id = ?
      ORDER BY rank ASC, f.path ASC, c.start_line ASC
      LIMIT ?
    )
    SELECT path, startLine, endLine, safeText, rank,
      COALESCE((SELECT MAX((SELECT COUNT(*) FROM edges e WHERE e.target_symbol_id = s.id)) FROM symbols s WHERE s.file_id = top.fileId AND s.start_line BETWEEN top.startLine AND top.endLine), 0) AS referenceCount,
      COALESCE((SELECT group_concat(name, char(31)) FROM symbols s WHERE s.file_id = top.fileId), '') AS symbolNames
    FROM top
    ORDER BY rank ASC, path ASC, startLine ASC
  `).all(match, repoId, state.active_generation, Math.floor(limit)) as Array<{
    path: string; startLine: number; endLine: number; safeText: string; rank: number; referenceCount: number; symbolNames: string;
  }>;
  const ranked = rows.map(({ rank, symbolNames, ...row }) => ({ ...row, rank, symbols: symbolNames ? symbolNames.split(String.fromCharCode(31)) : [] }));
  // Exact symbol names are looked up directly: a definition must be a candidate even when plain text matching ranks it below the limit.
  const names = [...new Set(terms)].slice(0, 12);
  const defined = db.prepare(`
    SELECT f.path AS path, c.start_line AS startLine, c.end_line AS endLine, c.safe_text AS safeText, s.name AS name
    FROM symbols s JOIN files f ON f.id = s.file_id JOIN chunks c ON c.file_id = f.id AND s.start_line BETWEEN c.start_line AND c.end_line
    WHERE f.repo_id = ? AND f.generation_id = ? AND s.name IN (${names.map(() => '?').join(',')})
    LIMIT 20
  `).all(repoId, state.active_generation, ...names) as Array<{ path: string; startLine: number; endLine: number; safeText: string; name: string }>;
  const byKey = new Map(ranked.map((row) => [`${row.path}:${row.startLine}`, row as typeof row & { defines?: string[] }]));
  for (const hit of defined) {
    const key = `${hit.path}:${hit.startLine}`;
    const row = byKey.get(key) ?? { path: hit.path, startLine: hit.startLine, endLine: hit.endLine, safeText: hit.safeText, rank: 0, symbols: [hit.name] } as (typeof ranked)[number] & { defines?: string[] };
    (row.defines ??= []).push(hit.name);
    if (!byKey.has(key)) { byKey.set(key, row); ranked.push(row); }
  }
  const all = ranked.slice(0, Math.floor(limit) + defined.length);
  const bestRank = Math.min(...all.map(row => row.rank));
  const worstRank = Math.max(...all.map(row => row.rank));
  return all.map(({ rank, ...row }) => ({
    ...row,
    normalizedBM25: worstRank === bestRank ? 1 : (worstRank - rank) / (worstRank - bestRank),
  }));
}

export function searchReferences(db: Database.Database, repoId: string, name: string): ReferenceHit[] {
  const state = db.prepare('SELECT active_generation FROM repo_index_state WHERE repo_id = ?').get(repoId) as { active_generation: number | null } | undefined;
  if (state?.active_generation == null) return [];
  const targets = db.prepare('SELECT DISTINCT f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.name = ? AND f.repo_id = ? AND f.generation_id = ?')
    .all(name, repoId, state.active_generation) as Array<{ path: string }>;
  if (!targets.length) return [];
  // shortcut: identifier spelling stands in for compiler symbol identity; same-name declarations can add false positives until language parsers are available.
  const targetModules = new Set(targets.map(({ path: file }) => stripSourceExtension(file)));
  const symbols = db.prepare('SELECT f.path, s.name, s.kind, s.start_line AS startLine, s.end_line AS endLine FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.repo_id = ? AND f.generation_id = ? ORDER BY f.path, s.start_line')
    .all(repoId, state.active_generation) as Array<{ path: string; name: string; kind: string; startLine: number; endLine: number }>;
  const byFile = new Map<string, typeof symbols>();
  for (const symbol of symbols) { const rows = byFile.get(symbol.path) ?? []; rows.push(symbol); byFile.set(symbol.path, rows); }
  const chunks = db.prepare("SELECT f.path, c.start_line AS startLine, c.safe_text AS safeText FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.repo_id = ? AND f.generation_id = ? AND f.language IN ('typescript', 'javascript', 'python', 'go', 'rust', 'java', 'c', 'cpp') ORDER BY f.path, c.start_line")
    .all(repoId, state.active_generation) as Array<{ path: string; startLine: number; safeText: string }>;
  const identifier = new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRegex(name)}(?![\\p{L}\\p{N}_$])`, 'gu');
  const hits = new Map<string, ReferenceHit>();
  let currentPath = '';
  let lastLine = 0;
  let blockComment = false;
  let stringDelimiter = '';
  for (const chunk of chunks) {
    if (chunk.path !== currentPath) { currentPath = chunk.path; lastLine = 0; blockComment = false; stringDelimiter = ''; }
    const lines = chunk.safeText.split('\n');
    for (let offset = 0; offset < lines.length; offset++) {
      const lineNumber = chunk.startLine + offset;
      if (lineNumber <= lastLine) continue; // chunks overlap; only inspect each physical line once.
      if (lastLine && lineNumber !== lastLine + 1) { blockComment = false; stringDelimiter = ''; }
      lastLine = lineNumber;
      const sourceLine = lines[offset]!;
      const code = maskCommentsAndStrings(sourceLine, { blockComment, stringDelimiter }, (state) => { blockComment = state.blockComment; stringDelimiter = state.stringDelimiter; }, /\.py$/i.test(chunk.path));
      const owner = (byFile.get(chunk.path) ?? []).filter((symbol) => symbol.startLine <= lineNumber && symbol.endLine >= lineNumber)
        .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
      for (const match of code.matchAll(identifier)) {
        const before = code.slice(0, match.index);
        if (owner?.name === name && owner.startLine === lineNumber && /(?:function|class|interface|type|const|let|var)\s+$/.test(before)) continue;
        const importLine = /^\s*import\b/.test(sourceLine);
        const exportLine = /^\s*export\b/.test(sourceLine);
        let referenceKind: ReferenceHit['referenceKind'];
        if (importLine) referenceKind = 'import';
        else if (exportLine && /^\s*export\s+(?:type\s+)?(?:\{|\*)/.test(sourceLine)) referenceKind = 're-export';
        else referenceKind = owner ? 'call' : 'module-level';
        const groupName = owner?.name ?? 'module level';
        const hit = { path: chunk.path, line: lineNumber, name: groupName, kind: owner?.kind ?? 'module', referenceKind, groupName };
        hits.set(`${hit.path}:${hit.line}:${hit.referenceKind}`, hit);
      }
      // `export *` carries no identifier, so connect only explicit relative JS/TS module paths to the target declaration file.
      const wildcard = sourceLine.match(/^\s*export\s+(?:type\s+)?\*\s+from\s+['"]([^'"]+)['"]/)?.[1];
      if (wildcard && targetModules.has(resolveModule(chunk.path, wildcard))) {
        const hit = { path: chunk.path, line: lineNumber, name: 'module level', kind: 'module', referenceKind: 're-export' as const, groupName: 'module level' };
        hits.set(`${hit.path}:${hit.line}:${hit.referenceKind}`, hit);
      }
    }
  }
  return [...hits.values()].sort((a, b) => a.path.localeCompare(b.path) || (a.groupName === b.groupName ? a.line - b.line : a.groupName === 'module level' ? -1 : b.groupName === 'module level' ? 1 : a.groupName.localeCompare(b.groupName)));
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function stripSourceExtension(value: string): string { return value.replace(/\.(?:[cm]?[jt]sx?)$/i, ''); }
function resolveModule(file: string, specifier: string): string { return stripSourceExtension(path.normalize(path.join(path.dirname(file), specifier))); }

function maskCommentsAndStrings(line: string, initial: { blockComment: boolean; stringDelimiter: string }, save: (state: { blockComment: boolean; stringDelimiter: string }) => void, python: boolean): string {
  let output = '', quote = initial.stringDelimiter;
  let blockComment = initial.blockComment;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!, next = line[i + 1];
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; i++; } output += ' '; continue; }
    if (quote) {
      if (line.startsWith(quote, i)) { output += ' '.repeat(quote.length); i += quote.length - 1; quote = ''; continue; }
      if (char === '\\') { output += '  '; i++; continue; }
      output += ' ';
      continue;
    }
    if (char === '/' && next === '/') break;
    if (char === '/' && next === '*') { blockComment = true; output += '  '; i++; continue; }
    if (python && char === '#') break;
    if (python && (line.startsWith('"""', i) || line.startsWith("'''", i))) { quote = line.slice(i, i + 3); output += '   '; i += 2; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; output += ' '; continue; }
    output += char;
  }
  save({ blockComment, stringDelimiter: quote === '`' || quote.length === 3 ? quote : '' });
  return output;
}

export function countSearchFiles(db: Database.Database, repoId: string, query: string): number {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!terms.length) return 0;
  const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
  const state = db.prepare('SELECT active_generation FROM repo_index_state WHERE repo_id = ?').get(repoId) as { active_generation: number | null } | undefined;
  if (state?.active_generation == null) return 0;
  return (db.prepare('SELECT COUNT(DISTINCT f.path) AS count FROM chunk_fts JOIN chunks c ON c.id = chunk_fts.rowid JOIN files f ON f.id = c.file_id WHERE chunk_fts MATCH ? AND f.repo_id = ? AND f.generation_id = ?').get(match, repoId, state.active_generation) as { count: number }).count;
}
