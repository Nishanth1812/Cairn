export type SelectionReason = 'lexical' | 'path' | 'symbol' | 'dependency' | 'intent';

export interface CandidateChunk {
  path: string;
  startLine: number;
  endLine: number;
  safeText: string;
  normalizedBM25: number;
  symbols?: string[];
  graphProximity?: number;
}

export interface SearchResult extends CandidateChunk {}

export interface RankedChunk extends CandidateChunk {
  score: number;
  selectionReason: SelectionReason;
}

export interface SelectedChunk extends RankedChunk {
  estimatedTokens: number;
}

export interface BoundedContextPackage {
  query: string;
  estimatedTokens: number;
  budget: number;
  isTruncated: boolean;
  items: SelectedChunk[];
  omittedCount: number;
}
