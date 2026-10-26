import type Database from 'better-sqlite3';
import type { SearchResult } from './types.js';

export function searchChunks(db: Database.Database, repoId: string, query: string, limit = 20): SearchResult[] {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!terms.length || !Number.isFinite(limit) || limit < 1) return [];
  const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
  const state = db.prepare('SELECT active_generation FROM repo_index_state WHERE repo_id = ?').get(repoId) as { active_generation: number | null } | undefined;
  if (state?.active_generation == null) return [];
  // Symbols and graph proximity are looked up only for the rows that survive the LIMIT; doing it per match cost 4-5x the search itself.
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
      COALESCE((SELECT group_concat(name, char(31)) FROM symbols s WHERE s.file_id = top.fileId), '') AS symbolNames,
      CASE WHEN EXISTS (
        SELECT 1 FROM symbols s JOIN edges e
          ON e.source_symbol_id = s.id OR e.target_symbol_id = s.id
        WHERE s.file_id = top.fileId
      ) THEN 1.0 ELSE 0.0 END AS graphProximity
    FROM top
    ORDER BY rank ASC, path ASC, startLine ASC
  `).all(match, repoId, state.active_generation, Math.floor(limit)) as Array<{
    path: string; startLine: number; endLine: number; safeText: string; rank: number; symbolNames: string; graphProximity: number;
  }>;
  const bestRank = Math.min(...rows.map(row => row.rank));
  const worstRank = Math.max(...rows.map(row => row.rank));
  return rows.map(({ rank, symbolNames, ...row }) => ({
    ...row,
    symbols: symbolNames ? symbolNames.split(String.fromCharCode(31)) : [],
    graphProximity: row.graphProximity,
    normalizedBM25: worstRank === bestRank ? 1 : (worstRank - rank) / (worstRank - bestRank),
  }));
}
