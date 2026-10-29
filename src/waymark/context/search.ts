import type Database from 'better-sqlite3';
import type { SearchResult } from './types.js';

export function searchChunks(db: Database.Database, repoId: string, query: string, limit = 20): SearchResult[] {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!terms.length || !Number.isFinite(limit) || limit < 1) return [];
  const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
  const state = db.prepare('SELECT active_generation FROM repo_index_state WHERE repo_id = ?').get(repoId) as { active_generation: number | null } | undefined;
  if (state?.active_generation == null) return [];
  // Symbols are looked up only for the rows that survive the LIMIT; doing it per match cost 4-5x the search itself.
  const rows = db.prepare(`
    WITH top AS MATERIALIZED (
      SELECT f.id AS fileId, f.path, c.start_line AS startLine, c.end_line AS endLine, c.safe_text AS safeText, bm25(chunk_fts) AS rank
      FROM chunk_fts
      JOIN chunks c ON c.id = chunk_fts.rowid
      JOIN files f ON f.id = c.file_id
      WHERE chunk_fts MATCH ? AND f.repo_id = ? AND f.generation_id = ?
      ORDER BY rank ASC, f.path ASC, c.start_line ASC
      LIMIT ?
    )
    SELECT path, startLine, endLine, safeText, rank,
      COALESCE((SELECT group_concat(name, char(31)) FROM symbols s WHERE s.file_id = top.fileId), '') AS symbolNames
    FROM top
    ORDER BY rank ASC, path ASC, startLine ASC
  `).all(match, repoId, state.active_generation, Math.floor(limit)) as Array<{
    path: string; startLine: number; endLine: number; safeText: string; rank: number; symbolNames: string;
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
