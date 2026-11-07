import type { RepoEntry } from '../core/registry/repoRegistry.js';
import { checkRepoHealth, type HealthReport } from './healthChecker.js';

export interface PortfolioSummary {
  repositories: Array<{ repo: RepoEntry; health: HealthReport }>;
  totals: { repositories: number; unmergedBranches: number; staleBranches: number; todoCount: number; dirtyFilesCount: number };
}

export async function generatePortfolioSummary(repos: RepoEntry[]): Promise<PortfolioSummary> {
  const repositories = await Promise.all(repos.map(async (repo) => ({ repo, health: await checkRepoHealth(repo.rootPath) })));
  return {
    repositories,
    totals: repositories.reduce((totals, { health }) => ({
      repositories: totals.repositories + 1,
      unmergedBranches: totals.unmergedBranches + health.unmergedBranches.length,
      staleBranches: totals.staleBranches + health.staleBranches.length,
      todoCount: totals.todoCount + health.todoCount,
      dirtyFilesCount: totals.dirtyFilesCount + health.dirtyFilesCount,
    }), { repositories: 0, unmergedBranches: 0, staleBranches: 0, todoCount: 0, dirtyFilesCount: 0 }),
  };
}
