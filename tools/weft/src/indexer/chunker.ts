import { hashString } from '../core/fingerprint/hasher.js';
import { estimateTokens } from '../core/estimate/tokenEstimator.js';
import type { CodeSymbol } from './symbols.js';

export interface TextChunk { ordinal: number; startLine: number; endLine: number; safeText: string; contentHash: string; tokenEstimate: number }

export function chunkText(safeText: string, symbols: CodeSymbol[] = [], chunkLines = 60, overlapLines = 15): TextChunk[] {
  const lines = safeText.split(/\r?\n/);
  const boundaries = [...new Set(symbols.map(symbol => symbol.startLine).filter(line => line > 1 && line <= lines.length))].sort((a, b) => a - b);
  if (boundaries.length) {
    const chunks: TextChunk[] = [];
    let start = 1;
    for (const boundary of [...boundaries, lines.length + 1]) {
      if (boundary <= start) continue;
      const text = lines.slice(start - 1, boundary - 1).join('\n');
      chunks.push({ ordinal: chunks.length, startLine: start, endLine: boundary - 1, safeText: text, contentHash: hashString(text), tokenEstimate: estimateTokens(text) });
      start = boundary;
    }
    return chunks.filter(chunk => chunk.safeText.length > 0);
  }
  if (chunkLines < 50 || chunkLines > 150 || overlapLines < 10 || overlapLines > 20 || overlapLines >= chunkLines) throw new RangeError('Chunk size must be 50–150 lines with 10–20 lines of overlap');
  const chunks: TextChunk[] = [];
  for (let start = 0; start < lines.length;) {
    const end = Math.min(start + chunkLines, lines.length);
    const text = lines.slice(start, end).join('\n');
    chunks.push({ ordinal: chunks.length, startLine: start + 1, endLine: end, safeText: text, contentHash: hashString(text), tokenEstimate: estimateTokens(text) });
    if (end === lines.length) break;
    start = end - overlapLines;
  }
  return chunks;
}
