import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { estimateTokens } from '../core/estimate/tokenEstimator.js';
import { formatContext } from '../cli/format.js';
import { searchChunks } from '../context/search.js';
import { rankCandidates } from '../context/ranker.js';
import { packContext } from '../context/packer.js';
import type Database from 'better-sqlite3';

type Query = { query: string; expectedTop3: string[] };
type Hit = { path: string; text: string };
const skip = new Set(['.git', 'node_modules', 'dist', 'coverage', '.weft']);

async function files(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !skip.has(entry.name)) result.push(...await files(root, join(dir, entry.name)));
    else if (entry.isFile()) result.push(join(dir, entry.name));
  }
  return result;
}

async function baseline(root: string, query: string): Promise<Hit[]> {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_./-]+/g) ?? [])].filter((term) => term.length > 1);
  const matches: Hit[] = [];
  for (const path of (await files(root)).sort((a, b) => relative(root, a).localeCompare(relative(root, b)))) {
    let text: string;
    try { text = await readFile(path, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    const lower = text.toLowerCase();
    if (terms.some((term) => lower.includes(term))) matches.push({ path: relative(root, path).replace(/\\/g, '/'), text });
  }
  return matches.slice(0, 5);
}

export async function runRetrievalBenchmark(db: Database.Database, repoId: string, root: string, queries: Query[], outputDir: string) {
  const rows: Array<{ query: string; expectedTop3: string[]; baselineTokens: number; weftTokens: number; ratio: number | null; baselineContainsExpected: boolean; weftContainsExpected: boolean; baselineFiles: string[]; weftFiles: string[] }> = [];
  for (const entry of queries) {
    const hits = await baseline(root, entry.query);
    const baselineTokens = hits.reduce((sum, hit) => sum + estimateTokens(hit.text), 0);
    const ranked = rankCandidates(searchChunks(db, repoId, entry.query, 100), entry.query);
    const compact = packContext(ranked.filter((item, index) => ranked.findIndex(other => other.path === item.path) === index).slice(0, 2), 1500, entry.query);
    const output = formatContext(compact.items);
    const baselinePaths = hits.map((hit) => hit.path);
    const weftPaths = compact.items.map((item) => item.path);
    rows.push({ query: entry.query, expectedTop3: entry.expectedTop3, baselineTokens, weftTokens: estimateTokens(output), ratio: compact.items.length ? baselineTokens / estimateTokens(output) : null,
      baselineContainsExpected: baselinePaths.some((path) => entry.expectedTop3.includes(path)), weftContainsExpected: weftPaths.some((path) => entry.expectedTop3.includes(path)), baselineFiles: baselinePaths, weftFiles: weftPaths });
  }
  const stats = (key: 'baselineTokens' | 'weftTokens') => {
    const values = rows.map((row) => row[key]).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, median: values.length % 2 ? values[middle]! : ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2 };
  };
  const ratios = rows.map((row) => row.ratio).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const middle = Math.floor(ratios.length / 2);
  const report = { scope: 'Retrieval cost only; this does not measure end-to-end task cost.', repo: resolve(root), queryCount: rows.length, baseline: stats('baselineTokens'), weft: stats('weftTokens'), ratio: { mean: ratios.reduce((sum, value) => sum + value, 0) / (ratios.length || 1), median: ratios.length % 2 ? ratios[middle] ?? 0 : ((ratios[middle - 1] ?? 0) + (ratios[middle] ?? 0)) / 2 }, results: rows, createdAt: new Date().toISOString() };
  await mkdir(outputDir, { recursive: true });
  const path = join(outputDir, `retrieval-${Date.now()}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { ...report, reportPath: path };
}
