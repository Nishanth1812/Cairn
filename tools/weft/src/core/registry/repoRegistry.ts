import { basename } from 'node:path';
import { getGitRoot } from '../gitstate/gitRunner.js';
import { normalizeCanonicalPath } from '../../config/paths.js';

export interface RepoEntry { name: string; rootPath: string; registeredAt: string }

export async function registerRepo(path: string, repos: RepoEntry[], name = basename(path)): Promise<RepoEntry> {
  const gitRoot = await getGitRoot(path);
  if (!gitRoot) throw new Error(`Not a Git repository: ${path}`);
  const rootPath = await normalizeCanonicalPath(gitRoot);
  const existing = repos.find((repo) => repo.rootPath.toLowerCase() === rootPath.toLowerCase());
  if (existing) return existing;
  const entry = { name: name.trim() || basename(rootPath), rootPath, registeredAt: new Date().toISOString() };
  repos.push(entry);
  return entry;
}

function rank(query: string, name: string): number {
  const q = query.trim().toLocaleLowerCase(); const n = name.toLocaleLowerCase();
  if (!q) return -1;
  if (q === n) return 0;
  const at = n.indexOf(q);
  if (at >= 0) return 1 + at / 1000;
  let cursor = 0;
  for (const char of q) { cursor = n.indexOf(char, cursor); if (cursor < 0) return -1; cursor++; }
  return 2 + (n.length - q.length) / 1000;
}

export function fuzzyFindRepo(query: string, repos: RepoEntry[]): { match: RepoEntry | null; candidates: RepoEntry[] } {
  const ranked = repos.map((repo) => ({ repo, score: rank(query, repo.name) })).filter((item) => item.score >= 0)
    .sort((a, b) => a.score - b.score || a.repo.name.localeCompare(b.repo.name) || a.repo.rootPath.localeCompare(b.repo.rootPath));
  const best = ranked[0]?.score;
  const candidates = ranked.map(({ repo }) => repo);
  return { match: ranked.length && ranked[1]?.score !== best ? ranked[0]!.repo : null, candidates };
}
