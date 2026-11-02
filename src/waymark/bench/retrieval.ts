import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { estimateTokens } from '../core/estimate/tokenEstimator.js';
import { formatContext } from '../cli/format.js';
import { searchChunks } from '../context/search.js';
import { rankCandidates } from '../context/ranker.js';
import { packContext } from '../context/packer.js';
import { walkRepository } from '../indexer/walker.js';
import type Database from 'better-sqlite3';

export type RetrievalQuery = { query: string; expectedTop3: string[]; split?: 'tuning' | 'heldout'; repo?: string };

function baseline(files: Awaited<ReturnType<typeof walkRepository>>, query: string): Array<{ path: string; text: string }> {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_./-]+/g) ?? [])].filter((term) => term.length > 1);
  const matches: Array<{ path: string; text: string }> = [];
  for (const file of files) {
    const text = file.content;
    const lower = text.toLowerCase();
    if (terms.some((term) => lower.includes(term))) matches.push({ path: file.path, text });
  }
  return matches.slice(0, 5);
}

export async function runRetrievalBenchmark(db: Database.Database, repoId: string, root: string, queries: RetrievalQuery[], outputDir: string, indexMs?: number) {
  const queryFixture = 'tests/waymark/golden/queries.json';
  const corpus = (await walkRepository(root)).filter((file) => file.path !== queryFixture);
  const rows: Array<{ query: string; split: 'tuning' | 'heldout'; expectedTop3: string[]; baselineTokens: number; weftTokens: number; ratio: number | null; hitAt1: boolean; hitAt3: boolean; hitAt5: boolean; baselineFiles: string[]; weftFiles: string[] }> = [];
  for (const entry of queries) {
    const hits = baseline(corpus, entry.query);
    const baselineTokens = hits.reduce((sum, hit) => sum + estimateTokens(hit.text), 0);
    const ranked = rankCandidates(searchChunks(db, repoId, entry.query, 100).filter((item) => item.path !== queryFixture), entry.query);
    const rankedPaths = [...new Set(ranked.map((item) => item.path))];
    const compact = packContext(ranked.filter((item, index) => ranked.findIndex(other => other.path === item.path) === index).slice(0, 2), 1500, entry.query);
    const output = formatContext(compact.items);
    const expected = new Set(entry.expectedTop3);
    const hit = (count: number) => rankedPaths.slice(0, count).some((path) => expected.has(path));
    rows.push({ query: entry.query, split: entry.split ?? 'tuning', expectedTop3: entry.expectedTop3, baselineTokens, weftTokens: estimateTokens(output), ratio: compact.items.length ? baselineTokens / estimateTokens(output) : null,
      hitAt1: hit(1), hitAt3: hit(3), hitAt5: hit(5), baselineFiles: hits.map((item) => item.path), weftFiles: rankedPaths.slice(0, 5) });
  }
  const stats = (items: typeof rows) => {
    const values = items.map((row) => row.weftTokens).sort((a, b) => a - b);
    return { mean: values.reduce((sum, value) => sum + value, 0) / (values.length || 1), max: values.at(-1) ?? 0 };
  };
  const evaluate = (split: 'tuning' | 'heldout') => {
    const items = rows.filter((row) => row.split === split);
    return { queryCount: items.length, hitAt1: items.filter((row) => row.hitAt1).length / (items.length || 1), hitAt3: items.filter((row) => row.hitAt3).length / (items.length || 1), hitAt5: items.filter((row) => row.hitAt5).length / (items.length || 1), tokens: stats(items) };
  };
  const ratios = rows.map((row) => row.ratio).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const middle = Math.floor(ratios.length / 2);
  const dbBytes = db.name === ':memory:' ? null : await stat(db.name).then((value) => value.size).catch(() => null);
  const report = { scope: 'Retrieval cost only; hit rates use distinct ranked files and token counts measure packed context.', repo: resolve(root), queryCount: rows.length, corpusFiles: corpus.length, indexMs: indexMs ?? null, dbBytes, tuning: evaluate('tuning'), heldout: evaluate('heldout'), rows, ratio: { mean: ratios.reduce((sum, value) => sum + value, 0) / (ratios.length || 1), median: ratios.length % 2 ? ratios[middle] ?? 0 : ((ratios[middle - 1] ?? 0) + (ratios[middle] ?? 0)) / 2 }, createdAt: new Date().toISOString() };
  await mkdir(outputDir, { recursive: true });
  const path = join(outputDir, `retrieval-${Date.now()}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { ...report, reportPath: path };
}
