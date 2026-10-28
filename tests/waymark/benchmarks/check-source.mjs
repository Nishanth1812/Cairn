import { readFile } from 'node:fs/promises';

const checks = {
  'bugfix-harness-placeholder': ['src/bench/live.ts', "includes('{prompt}')"],
  'bugfix-baseline-instructions': ['src/bench/live.ts', "condition !== 'A'"],
  'bugfix-repo-isolation': ['src/bench/live.ts', 'cp(resolve(task.repoPath), repo,'],
  'bugfix-test-gating': ['src/bench/live.ts', 'harness.code === 0 && test.code === 0'],
  'feature-task-token-budget': ['src/cli/commands/index.ts', 'task.estimatedTokens ?? 10_000'],
  'feature-task-filter': ['src/cli/commands/index.ts', '.filter((task) => selected.includes(task.id))'],
  'feature-repeat-summary': ['src/cli/commands/index.ts', ['Array.from({ length: repeat }', 'successfulTaskCostMedianMicros', 'Math.sqrt(report.conditionResults[condition].successfulTaskCostVarianceMicros)']],
  'refactor-suite-loader': ['src/bench/live.ts', 'function clearWeftSetup('],
  'refactor-usage-parser': ['src/bench/live.ts', 'function readUsage('],
  'comprehension-mcp-config': ['tests/benchmarks/answers/condition-c.md', 'weft-local/Weft/state'],
};

const [path, expected] = checks[process.argv[2]] ?? [];
const content = path ? await readFile(path, 'utf8') : '';
if (!path || (Array.isArray(expected) ? !expected.every((value) => content.includes(value)) : !content.includes(expected))) process.exitCode = 1;
