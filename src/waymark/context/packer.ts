import { estimateTokens } from '../core/estimate/tokenEstimator.js';
import type { BoundedContextPackage, RankedChunk, SelectedChunk } from './types.js';

// Below this many spare tokens a clipped window says too little to be worth showing.
const MIN_WINDOW_TOKENS = 150;

/** The lines of a chunk around its first query match that fit `maxTokens`, with the line range they cover. */
function clipToBudget(chunk: RankedChunk, query: string, maxTokens: number): RankedChunk {
  const lines = chunk.safeText.split(/\r?\n/);
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const anchor = Math.max(0, lines.findIndex(line => terms.some(term => line.toLowerCase().includes(term))));
  let start = anchor, end = anchor + 1, used = estimateTokens(lines[anchor] ?? '');
  // Grow one line at a time, after the match first (a signature is followed by its body), until the budget is spent.
  for (let grew = true; grew;) {
    grew = false;
    for (const next of [end < lines.length ? end : -1, start > 0 ? start - 1 : -1]) {
      if (next < 0) continue;
      const cost = estimateTokens(lines[next]!);
      if (used + cost > maxTokens) continue;
      used += cost; grew = true;
      if (next === end) end++; else start--;
    }
  }
  return { ...chunk, safeText: lines.slice(start, end).join('\n'), startLine: chunk.startLine + start, endLine: chunk.startLine + end - 1 };
}

export function packContext(candidates: RankedChunk[], maxTokens: number, query = ''): BoundedContextPackage {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
  const selected: RankedChunk[] = [];
  for (const candidate of sorted) {
    if (selected.some(item => item.path === candidate.path && item.startLine <= candidate.endLine && candidate.startLine <= item.endLine)) continue;
    selected.push(candidate);
  }
  let estimatedTokens = 0;
  let omittedCount = 0;
  let clippedCount = 0;
  const items: SelectedChunk[] = [];
  for (const candidate of selected) {
    const cost = estimateTokens(candidate.safeText);
    if (estimatedTokens + cost <= maxTokens) {
      items.push({ ...candidate, estimatedTokens: cost });
      estimatedTokens += cost;
    } else if (maxTokens - estimatedTokens >= MIN_WINDOW_TOKENS) {
      // A chunk bigger than the room left (one long function) is shown as a window around its match rather than dropped.
      const clipped = clipToBudget(candidate, query, maxTokens - estimatedTokens);
      const clippedCost = estimateTokens(clipped.safeText);
      items.push({ ...clipped, estimatedTokens: clippedCost });
      estimatedTokens += clippedCost;
      clippedCount++;
    } else omittedCount++;
  }
  return { query, estimatedTokens, budget: maxTokens, isTruncated: omittedCount + clippedCount > 0, items, omittedCount };
}
