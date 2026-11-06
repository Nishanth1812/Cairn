import type { ExactMatch, SymbolHit } from '../context/lookup.js';
import { queryTerms as meaningfulTerms } from '../context/query.js';

type Location = { path: string; startLine: number; endLine: number; safeText: string; symbols?: string[]; defines?: string[] };

const queryTerms = (query: string): string[] => meaningfulTerms(query).map(term => term.toLowerCase());
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Names the symbol the query is about when the chunk has one, else the first symbol it mentions. */
function header(item: Location, query = '', includeSymbol = true): string {
  const inChunk = item.symbols?.filter(name => item.safeText.includes(name)) ?? [];
  const terms = queryTerms(query);
  const symbol = inChunk.find(name => terms.includes(name.toLowerCase())) ?? inChunk.find(name => terms.some(term => name.toLowerCase().includes(term))) ?? inChunk[0] ?? item.symbols?.[0];
  return `${item.path}:${item.startLine}-${item.endLine}${includeSymbol ? `  ${symbol ?? item.safeText.split(/\r?\n/, 1)[0]?.trim() ?? ''}` : ''}`;
}

/** The first line that holds a query term, so a hit shows why it matched; the chunk's first line when none does. */
function matchingLine(item: Location, query: string): string {
  const lines = item.safeText.split(/\r?\n/);
  const terms = queryTerms(query);
  const matches = (candidate: string) => terms.some(term => candidate.toLowerCase().includes(term));
  const line = lines.find(candidate => matches(candidate) && !/^\s*(?:\/\/|\/\*|\*|#|<!--)/.test(candidate)) ?? lines.find(matches) ?? lines.find(candidate => candidate.trim()) ?? '';
  return line.trim().slice(0, 200);
}

export function formatSearch(items: Location[], query = ''): string {
  const unique = items.filter((item, index) => !items.slice(0, index).some(previous => previous.path === item.path && previous.startLine <= item.endLine && item.startLine <= previous.endLine));
  const body = unique.map(item => `${header(item, query)}
${matchingLine(item, query)}`).join('\n');
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

export function contextAnswer(items: Location[], query = '') {
  const terms = queryTerms(query);
  const symbol = [...new Set(items.flatMap(item => item.defines ?? []))].find(name => terms.includes(name.toLowerCase()));
  const definition = symbol && items.find(item => item.defines?.includes(symbol));
  const usages: Array<{ path: string; line: number }> = [];
  if (symbol) for (const item of items) {
    const lines = item.safeText.split(/\r?\n/);
    for (const [offset, line] of lines.entries()) {
      if (item === definition || !new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRegExp(symbol)}(?![\\p{L}\\p{N}_$])`, 'u').test(line) || /^\s*(?:\/\/|\/\*|\*|#|<!--)/.test(line)) continue;
      usages.push({ path: item.path, line: item.startLine + offset });
      if (usages.length === 3) break;
    }
    if (usages.length === 3) break;
  }
  return { ...(definition && symbol ? { definition: { symbol, path: definition.path, startLine: definition.startLine, endLine: definition.endLine } } : {}), usages };
}

export function formatContext(items: Location[], query = ''): string {
  const { definition, usages } = contextAnswer(items, query);
  const byFile = new Map<string, Location[]>();
  for (const item of items) { const rows = byFile.get(item.path) ?? []; rows.push(item); byFile.set(item.path, rows); }
  const mergedItems = [...byFile.values()].flatMap(rows => {
    const merged: Location[] = [];
    for (const row of rows.sort((a, b) => a.startLine - b.startLine)) {
      const previous = merged.at(-1);
      if (previous && row.startLine <= previous.endLine + 1) {
        previous.safeText += `\n${row.safeText}`;
        previous.endLine = Math.max(previous.endLine, row.endLine);
      } else merged.push({ ...row });
    }
    return merged;
  });
  const definitionItem = definition && mergedItems.find(item => item.path === definition.path && item.startLine <= definition.startLine && item.endLine >= definition.startLine);
  const ordered = definitionItem ? [definitionItem, ...mergedItems.filter(item => item !== definitionItem)] : mergedItems;
  const usageLines = new Set(usages.map(use => `${use.path}:${use.line}`));
  const snippets = ordered.map(item => {
    const text = item.safeText.split(/\r?\n/).filter((_, offset) => !usageLines.has(`${item.path}:${item.startLine + offset}`)).join('\n').trim().replace(/\n{3,}/g, '\n\n');
    return item === definitionItem ? text : `${item.path}:${item.startLine}\n${text}`;
  }).filter(Boolean);
  const answer = definitionItem ? [header(definitionItem, query), ...usages.map(use => `${use.path}:${use.line}`)] : [];
  return [answer.join('\n'), ...snippets].filter(Boolean).join('\n\n');
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

export function formatReferences(hits: Array<{ path: string; line: number; groupName: string; referenceKind: string }>, total: number): string {
  const groups = new Map<string, typeof hits>();
  for (const hit of hits) { const key = `${hit.path}\0${hit.groupName}`; const rows = groups.get(key) ?? []; rows.push(hit); groups.set(key, rows); }
  const lines: string[] = [];
  let file = '';
  for (const rows of groups.values()) {
    const first = rows[0]!;
    if (file !== first.path) { file = first.path; lines.push(file); }
    lines.push(`  ${first.groupName}`);
    for (const hit of rows) lines.push(`    ${hit.path}:${hit.line} [${hit.referenceKind}]`);
  }
  if (total > hits.length) lines.push(`... ${total - hits.length} more reference sites (raise --limit or --budget)`);
  return lines.join('\n');
}
