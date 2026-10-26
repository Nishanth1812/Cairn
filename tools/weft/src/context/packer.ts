import { estimateTokens } from '../core/estimate/tokenEstimator.js';
import type { BoundedContextPackage, RankedChunk, SelectedChunk } from './types.js';

export function packContext(candidates: RankedChunk[], maxTokens: number, query = ''): BoundedContextPackage {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
  const selected: RankedChunk[] = [];
  for (const candidate of sorted) {
    if (selected.some(item => item.path === candidate.path && item.startLine <= candidate.endLine && candidate.startLine <= item.endLine)) continue;
    selected.push(candidate);
  }
  let estimatedTokens = 0;
  let omittedCount = 0;
  const items: SelectedChunk[] = [];
  for (const candidate of selected) {
    const cost = estimateTokens(candidate.safeText);
    if (estimatedTokens + cost <= maxTokens) {
      items.push({ ...candidate, estimatedTokens: cost });
      estimatedTokens += cost;
    } else omittedCount++;
  }
  return { query, estimatedTokens, budget: maxTokens, isTruncated: omittedCount > 0, items, omittedCount };
}
