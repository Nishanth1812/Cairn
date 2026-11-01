import type { CandidateChunk, RankedChunk, SelectionReason } from './types.js';

const words = (text: string): string[] => text.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
const isTest = (path: string) => /(?:^|[/_.-])(?:test|tests|spec|specs|fixtures?)(?:[/_.-]|$)/i.test(path);
const isLowValue = (path: string) => isTest(path) || /(?:^|[/_.-])(?:generated|dist|docs?|documentation)(?:[/_.-]|$)/i.test(path);
// Prose (README, plans, notes) answers a code question only when the query asks for it; otherwise it crowds out definitions.
const isProse = (path: string) => /\.(?:md|mdx|txt|rst)$/i.test(path);
const PROSE_TERM = /^(?:readme|docs?|documentation|plans?|phases?|sections?|md|markdown|specs?|guide|changelog|notes?|intent)$/;
// Chunks that only import things, or the managed instruction block every CLAUDE.md carries, match many queries and answer none.
const isBoilerplate = (text: string) => {
  if (text.includes('BEGIN WEFT MANAGED BLOCK')) return true;
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every(line => /^(?:import\b|from\s.+\bimport\b|#include\b|use\s.+;$|package\b|(?:const|let|var)\s.+=\s*require\(|\/\/|\*|\/\*)/.test(line));
};
const isIntent = (path: string) => /(?:^|\/)(?:intent|plans?)(?:\/|\.|$)/i.test(path);

export function rankCandidates(candidates: CandidateChunk[], query: string): RankedChunk[] {
  const queryWords = [...new Set(words(query))];
  const hasProseTerm = queryWords.some(word => PROSE_TERM.test(word));
  const hasTestTerm = queryWords.some(word => /test|spec/.test(word));
  const ranked = candidates.map(candidate => {
    const path = candidate.path.toLocaleLowerCase();
    const pathParts = path.split(/[\/_.-]/);
    const symbolNames = (candidate.symbols ?? []).map(name => name.toLocaleLowerCase());
    const symbolMatch = queryWords.some(word => symbolNames.some(name => name === word || name.includes(word)));
    const defScore = (candidate.defines ?? []).some(name => queryWords.includes(name.toLocaleLowerCase())) ? 1 : 0;
    const pathMatch = queryWords.some(word => pathParts.some(part => part === word || part.includes(word)));
    const pathScore = pathMatch ? 1 : 0;
    const symbolScore = symbolMatch ? 1 : 0;
    const testPenalty = (isLowValue(candidate.path) && !hasTestTerm) || (isProse(candidate.path) && !hasProseTerm) ? 0.35 : 0;
    const intentScore = isIntent(candidate.path) && queryWords.some(word => words(candidate.safeText).includes(word)) ? 1 : 0;
    const penalty = Math.max(testPenalty, isBoilerplate(candidate.safeText) ? 0.35 : 0);
    const score = Math.max(0, 0.45 * candidate.normalizedBM25 + 0.40 * defScore + 0.20 * symbolScore + 0.15 * pathScore + 0.10 * intentScore - penalty);
    const signals: Array<[SelectionReason, number]> = [
      ['lexical', candidate.normalizedBM25], ['symbol', Math.max(symbolScore, defScore)], ['path', pathScore], ['intent', intentScore],
    ];
    const selectionReason = signals.reduce((best, current) => current[1] > best[1] ? current : best)[0];
    return { ...candidate, score, selectionReason };
  });
  return ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);
}
