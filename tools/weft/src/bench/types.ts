export type TrialCondition = 'A' | 'B' | 'C';

export const TRIAL_CONDITIONS: Readonly<Record<TrialCondition, string>> = {
  A: 'Baseline harness',
  B: 'Shared instructions',
  C: 'Full Weft with MCP, lifecycle hooks, and a local index',
};

export interface TaskDefinition {
  id: string;
  title: string;
  category: 'bugfix' | 'refactor' | 'feature' | 'comprehension';
  repoPath: string;
  testCommand: string;
  prompt?: string;
}

export interface TrialExecution {
  success: boolean;
  durationMs: number;
  tokensUsed: number;
  costMicros: number;
  tokenProvenance?: 'provider_reported' | 'estimated';
  costProvenance?: 'provider_reported' | 'estimated';
  error?: string;
  infrastructure?: boolean;
}

export type BenchmarkTask = TaskDefinition & {
  run: (condition: TrialCondition) => Promise<TrialExecution>;
};

export interface TrialResult extends TrialExecution {
  taskId: string;
  condition: TrialCondition;
}

export interface BenchmarkSummary {
  totalTasks: number;
  conditionResults: Record<TrialCondition, {
    passRate: number;
    avgDurationMs: number;
    totalCostMicros: number;
    efficiencyScore: number;
    successfulTaskCostMicros: number;
    successfulTaskCostVarianceMicros: number;
    successfulTaskCostCi95Micros: [number, number];
  }>;
}

export interface BenchmarkReport extends BenchmarkSummary {
  results: TrialResult[];
}
