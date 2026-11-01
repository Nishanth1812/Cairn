import type Database from 'better-sqlite3';

export const SYMBOL_KINDS = ['function', 'class', 'interface', 'type', 'method', 'variable'];

const activeGeneration = (db: Database.Database, repoId: string): number | null =>
  (db.prepare('SELECT active_generation AS generation FROM repo_index_state WHERE repo_id = ?').get(repoId) as { generation: number | null } | undefined)?.generation ?? null;

export interface ExactMatch { path: string; line: number; text: string }

function exactExcerpt(line: string, needle: string): string {
  const text = line.trim();
  if (text.length <= 200) return text;
  const match = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  const start = Math.max(0, Math.min(match - 80, text.length - 200));
  return `${start ? '…' : ''}${text.slice(start, start + 200)}${start + 200 < text.length ? '…' : ''}`;
}

/** Every line that contains `text` (case-insensitive, literal), as file:line. Semantic search ranks; this enumerates, for audits like "every reference to src/". */
export function exactMatches(db: Database.Database, repoId: string, text: string): ExactMatch[] {
  const generation = activeGeneration(db, repoId);
  if (generation === null || !text) return [];
  const rows = db.prepare(`
    SELECT f.path AS path, c.start_line AS startLine, c.safe_text AS safeText
    FROM chunks c JOIN files f ON f.id = c.file_id
    WHERE f.repo_id = ? AND f.generation_id = ? AND instr(lower(c.safe_text), lower(?)) > 0
    ORDER BY f.path, c.start_line
  `).all(repoId, generation, text) as Array<{ path: string; startLine: number; safeText: string }>;
  const needle = text.toLowerCase(), seen = new Set<string>(), found: ExactMatch[] = [];
  for (const row of rows) {
    row.safeText.split(/\r?\n/).forEach((line, index) => {
      const key = `${row.path}:${row.startLine + index}`;
      // Chunks overlap, so the same line can arrive twice.
      if (line.toLowerCase().includes(needle) && !seen.has(key)) { seen.add(key); found.push({ path: row.path, line: row.startLine + index, text: exactExcerpt(line, needle) }); }
    });
  }
  return found;
}

export interface SymbolHit { path: string; startLine: number; endLine: number; name: string; kind: string }

/** Definitions of one kind, optionally narrowed to those whose name or path contains any of `terms`. Answers "list the classes in the backend". */
export function symbolsByKind(db: Database.Database, repoId: string, kind: string, terms: string[]): SymbolHit[] {
  const generation = activeGeneration(db, repoId);
  if (generation === null) return [];
  const narrow = terms.length ? ` AND (${terms.map(() => '(instr(lower(s.name), ?) > 0 OR instr(lower(f.path), ?) > 0)').join(' OR ')})` : '';
  return db.prepare(`
    SELECT f.path AS path, s.start_line AS startLine, s.end_line AS endLine, s.name AS name, s.kind AS kind
    FROM symbols s JOIN files f ON f.id = s.file_id
    WHERE f.repo_id = ? AND f.generation_id = ? AND s.kind = ?${narrow}
    ORDER BY f.path, s.start_line
  `).all(repoId, generation, kind, ...terms.flatMap((term) => [term.toLowerCase(), term.toLowerCase()])) as SymbolHit[];
}
