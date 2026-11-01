import type { ExactMatch, SymbolHit } from '../context/lookup.js';

type Location = { path: string; startLine: number; endLine: number; safeText: string; symbols?: string[] };

const queryTerms = (query: string): string[] => query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

/** Names the symbol the query is about when the chunk has one, else the first symbol it mentions. */
function header(item: Location, query = ''): string {
  const inChunk = item.symbols?.filter(name => item.safeText.includes(name)) ?? [];
  const terms = queryTerms(query);
  const symbol = inChunk.find(name => terms.includes(name.toLowerCase())) ?? inChunk.find(name => terms.some(term => name.toLowerCase().includes(term))) ?? inChunk[0] ?? item.symbols?.[0];
  return `${item.path}:${item.startLine}-${item.endLine}  ${symbol ?? item.safeText.split(/\r?\n/, 1)[0]?.trim() ?? ''}`;
}

/** The first line that holds a query term, so a hit shows why it matched; the chunk's first line when none does. */
function matchingLine(item: Location, query: string): string {
  const lines = item.safeText.split(/\r?\n/);
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  const line = lines.find(candidate => terms.some(term => candidate.toLowerCase().includes(term))) ?? lines[0] ?? '';
  return line.trim().slice(0, 200);
}

export function formatSearch(items: Location[], query = ''): string {
  const unique = items.filter((item, index) => !items.slice(0, index).some(previous => previous.path === item.path && previous.startLine <= item.endLine && item.startLine <= previous.endLine));
  const body = unique.map(item => `${header(item, query)}
${matchingLine(item, query)}`).join('\n\n');
  // A ranked search is lexical: when no hit holds every word, say so and point at the exact tools instead of leaving the agent to sweep.
  const terms = [...new Set(queryTerms(query))];
  const weak = terms.length >= 3 && !unique.some(item => terms.every(term => item.safeText.toLowerCase().includes(term)));
  return weak ? `${body}

No result contains every word. For literal text use search --exact "<text>"; to list definitions use search --kind function|class|variable "<name>".` : body;
}

/** The --json form of a search hit: where it is and the line that matched, not the whole chunk (about 15x smaller). */
export function searchRecord(item: Location & { score: number; selectionReason: string }, query = '') {
  return { path: item.path, startLine: item.startLine, endLine: item.endLine, score: item.score, selectionReason: item.selectionReason, symbols: item.symbols ?? [], line: matchingLine(item, query) };
}

export function formatContext(items: Location[]): string {
  return items.map(item => `${header(item)}\n${item.safeText}`).join('\n\n');
}

/** `total` can exceed matches.length when --limit cut the list; say so, so an audit is never silently partial. */
export function formatExact(matches: ExactMatch[], total: number): string {
  const lines = matches.map(match => `${match.path}:${match.line}  ${match.text}`);
  if (total > matches.length) lines.push(`... ${total - matches.length} more matches (raise --limit or --budget)`);
  return lines.join('\n');
}

export function formatSymbols(hits: SymbolHit[], total: number): string {
  const lines = hits.map(hit => `${hit.path}:${hit.startLine}-${hit.endLine}  ${hit.name} (${hit.kind})`);
  if (total > hits.length) lines.push(`... ${total - hits.length} more (raise --limit or --budget)`);
  return lines.join('\n');
}
