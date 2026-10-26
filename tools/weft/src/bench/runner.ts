import type { BenchmarkReport, BenchmarkTask, TrialCondition, TrialExecution, TrialResult } from './types.js';

const CONDITIONS: readonly TrialCondition[] = ['A', 'B', 'C'];

function failedTrial(taskId: string, condition: TrialCondition, error: unknown): TrialResult {
  return {
    taskId,
    condition,
    success: false,
    durationMs: 0,
    tokensUsed: 0,
    costMicros: 0,
    error: error instanceof Error ? error.message : String(error),
  };
}

function summarize(results: TrialResult[], totalTasks: number): BenchmarkReport['conditionResults'] {
  return Object.fromEntries(CONDITIONS.map((condition) => {
    const trials = results.filter((result) => result.condition === condition);
    const successCount = trials.filter((result) => result.success).length;
    const totalDurationMs = trials.reduce((total, result) => total + result.durationMs, 0);
    const totalCostMicros = trials.reduce((total, result) => total + result.costMicros, 0);
    const successfulCosts = trials.filter((result) => result.success).map((result) => result.costMicros);
    const successfulTaskCostMicros = successfulCosts.length ? successfulCosts.reduce((sum, cost) => sum + cost, 0) / successfulCosts.length : 0;
    const successfulTaskCostVarianceMicros = successfulCosts.length ? successfulCosts.reduce((sum, cost) => sum + (cost - successfulTaskCostMicros) ** 2, 0) / successfulCosts.length : 0;
    const timeOverheadHours = totalDurationMs / 3_600_000;
    const denominator = totalCostMicros / 1_000_000 + timeOverheadHours;

    return [condition, {
      passRate: totalTasks ? successCount / totalTasks : 0,
      avgDurationMs: totalTasks ? totalDurationMs / totalTasks : 0,
      totalCostMicros,
      efficiencyScore: denominator ? successCount / denominator : 0,
      successfulTaskCostMicros,
      successfulTaskCostVarianceMicros,
      successfulTaskCostCi95Micros: [successfulTaskCostMicros - 1.96 * Math.sqrt(successfulTaskCostVarianceMicros / (successfulCosts.length || 1)), successfulTaskCostMicros + 1.96 * Math.sqrt(successfulTaskCostVarianceMicros / (successfulCosts.length || 1))],
    }];
  })) as BenchmarkReport['conditionResults'];
}

export async function runBenchmark(
  tasks: BenchmarkTask[],
  conditions: TrialCondition[],
): Promise<BenchmarkReport> {
  const results: TrialResult[] = [];
  for (const task of tasks) {
    for (const condition of conditions) {
      let execution: TrialExecution;
      try {
        execution = await task.run(condition);
      } catch (error) {
        results.push(failedTrial(task.id, condition, error));
        continue;
      }
      results.push({ taskId: task.id, condition, ...execution });
    }
  }

  return { totalTasks: tasks.length, results, conditionResults: summarize(results, tasks.length) };
}
