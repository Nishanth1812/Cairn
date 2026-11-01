import type { ExactMatch, SymbolHit } from '../context/lookup.js';

type Location = { path: string; startLine: number; endLine: number; safeText: string; symbols?: string[] };

function header(item: Location): string {
  const symbol = item.symbols?.find(name => item.safeText.includes(name)) ?? item.symbols?.[0];
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
  return unique.map(item => `${header(item)}\n${matchingLine(item, query)}`).join('\n\n');
}

export function formatContext(items: Location[]): string {
  return items.map(item => `${header(item)}\n${item.safeText}`).join('\n\n');
}

/** `total` can exceed matches.length when --limit cut the list; say so, so an audit is never silently partial. */
export function formatExact(matches: ExactMatch[], total: number): string {
  const lines = matches.map(match => `${match.path}:${match.line}  ${match.text}`);
  if (total > matches.length) lines.push(`... ${total - matches.length} more matches (raise --limit)`);
  return lines.join('\n');
}

export function formatSymbols(hits: SymbolHit[], total: number): string {
  const lines = hits.map(hit => `${hit.path}:${hit.startLine}-${hit.endLine}  ${hit.name} (${hit.kind})`);
  if (total > hits.length) lines.push(`... ${total - hits.length} more (raise --limit)`);
  return lines.join('\n');
}
