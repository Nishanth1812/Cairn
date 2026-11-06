import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getUnmergedBranches, getWorkingTreeStatus, runGit } from '../core/gitstate/gitRunner.js';
import { walkRepository } from '../indexer/walker.js';

export interface StaleBranch { name: string; lastCommitAt: string; daysSinceCommit: number }
export interface HealthReport {
  repoRoot: string;
  unmergedBranches: string[];
  staleBranches: StaleBranch[];
  todoCount: number;
  dirtyFilesCount: number;
}

const STALE_AFTER_DAYS = 14;

export async function checkRepoHealth(repoRoot: string): Promise<HealthReport> {
  const [unmergedBranches, workingTree, files] = await Promise.all([
    getUnmergedBranches(repoRoot), getWorkingTreeStatus(repoRoot), walkRepository(repoRoot),
  ]);
  const now = Date.now();
  const branchData = await runGit(repoRoot, ['for-each-ref', '--format=%(refname:short)%00%(committerdate:iso-strict)', 'refs/heads']);
  if (branchData.exitCode !== 0) throw new Error(branchData.stderr.trim() || 'Unable to read Git branch dates');
  const staleBranches = branchData.stdout.split(/\r?\n/).flatMap((line) => {
    const [name, date] = line.split('\0');
    if (!name || !date || name === workingTree.branch) return [];
    const timestamp = Date.parse(date);
    if (!Number.isFinite(timestamp)) return [];
    const daysSinceCommit = Math.floor((now - timestamp) / 86_400_000);
    return daysSinceCommit > STALE_AFTER_DAYS ? [{ name, lastCommitAt: new Date(timestamp).toISOString(), daysSinceCommit }] : [];
  }).sort((a, b) => a.name.localeCompare(b.name));
  let todoCount = 0;
  for (const file of files) {
    const content = file.unchanged ? await readFile(join(repoRoot, file.path), 'utf8') : file.content;
    todoCount += content.match(/\b(?:TODO|FIXME)\b/gi)?.length ?? 0;
  }
  const dirtyFilesCount = new Set([...workingTree.staged, ...workingTree.unstaged, ...workingTree.untracked]).size;
  return { repoRoot, unmergedBranches, staleBranches, todoCount, dirtyFilesCount };
}
