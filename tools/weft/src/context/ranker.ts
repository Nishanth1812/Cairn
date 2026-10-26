import type { CandidateChunk, RankedChunk, SelectionReason } from './types.js';

const words = (text: string): string[] => text.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
const isTest = (path: string) => /(?:^|[/_.-])(?:test|tests|spec|specs|fixtures?)(?:[/_.-]|$)/i.test(path);
const isLowValue = (path: string) => isTest(path) || /(?:^|[/_.-])(?:generated|dist|docs?|documentation)(?:[/_.-]|$)/i.test(path);
const isIntent = (path: string) => /(?:^|\/)(?:intent|plans?)(?:\/|\.|$)/i.test(path);

export function rankCandidates(candidates: CandidateChunk[], query: string): RankedChunk[] {
  const queryWords = [...new Set(words(query))];
  const hasTestTerm = queryWords.some(word => /test|spec/.test(word));
  const ranked = candidates.map(candidate => {
    const path = candidate.path.toLocaleLowerCase();
    const pathParts = path.split(/[\/_.-]/);
    const symbolNames = (candidate.symbols ?? []).map(name => name.toLocaleLowerCase());
    const symbolMatch = queryWords.some(word => symbolNames.some(name => name === word || name.includes(word)));
    const pathMatch = queryWords.some(word => pathParts.some(part => part === word || part.includes(word)));
    const pathScore = pathMatch ? 1 : 0;
    const symbolScore = symbolMatch ? 1 : 0;
    const graphScore = Math.max(0, Math.min(1, candidate.graphProximity ?? 0));
    const testPenalty = isLowValue(candidate.path) && !hasTestTerm ? 0.35 : 0;
    const intentScore = isIntent(candidate.path) && queryWords.some(word => words(candidate.safeText).includes(word)) ? 1 : 0;
    const score = Math.max(0, 0.45 * candidate.normalizedBM25 + 0.20 * symbolScore + 0.15 * pathScore + 0.10 * graphScore + 0.10 * intentScore - testPenalty);
    const signals: Array<[SelectionReason, number]> = [
      ['lexical', candidate.normalizedBM25], ['symbol', symbolScore], ['path', pathScore], ['dependency', graphScore], ['intent', intentScore],
    ];
    const selectionReason = signals.reduce((best, current) => current[1] > best[1] ? current : best)[0];
    return { ...candidate, score, selectionReason };
  });
  return ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
}
