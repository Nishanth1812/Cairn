import { win32 } from 'node:path';

export type TaskOutcome = 'completed' | 'not-completed' | 'unknown';
export interface ComparisonAnnotations {
  baselineOutcome?: TaskOutcome;
  currentOutcome?: TaskOutcome;
  baselineElapsedMs?: number;
  currentElapsedMs?: number;
}

type JsonObject = Record<string, unknown>;
type Metric = { baseline: number | null; current: number | null; change: number | null };

export interface AuditComparison {
  status: 'comparable' | 'partial' | 'incomparable';
  reports: { baseline: { host: string; project: string | null }; current: { host: string; project: string | null } };
  coverage: { baseline: Record<string, string>; current: Record<string, string>; differences: string[] };
  metrics: Record<string, Metric>;
  taskOutcome: { baseline: TaskOutcome; current: TaskOutcome; change: string };
  elapsedMs: { baseline: number | null; current: number | null; change: number | null };
  notes: string[];
}

const object = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const finiteCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const HOSTS = new Set(['claude-code', 'codex', 'opencode']);

function auditReport(value: unknown, label: string): JsonObject {
  const report = object(value) && object(value.data) ? value.data : value;
  if (!object(report) || !HOSTS.has(String(report.host)) || !object(report.scope) || !(report.scope.project === null || typeof report.scope.project === 'string')
    || !object(report.bounds) || !object(report.usage) || !object(report.usage.byModel)
    || !object(report.opportunities) || !Array.isArray(report.opportunities.repeatedReads) || !Array.isArray(report.opportunities.repeatedSearches)
    || !object(report.opportunities.largeToolOutputs) || !object(report.coverage) || !object(report.coverage.categories)) {
    throw new Error(`${label} is not a valid Cairn Optimize audit report`);
  }
  if (report.coverage.id !== report.host || Object.values(report.coverage.categories as JsonObject).some((category) => !object(category) || !['observable', 'estimated', 'unavailable'].includes(String(category.coverage)))) {
    throw new Error(`${label} has invalid coverage metadata`);
  }
  for (const field of ['projectsPresent', 'projectsScanned', 'sessionsScanned', 'sessionsSkipped', 'malformedLines']) {
    if (!finiteCount(report.bounds[field])) throw new Error(`${label} has invalid bounds.${field}`);
  }
  for (const field of ['sessionsWithProviderUsage', 'sessionsWithoutProviderUsage']) {
    if (!finiteCount(report.usage[field])) throw new Error(`${label} has invalid usage.${field}`);
  }
  return report;
}

function projectKey(project: string | null): string | null {
  if (project === null) return null;
  if (/^[a-zA-Z]:(?:[\\/]|$)/.test(project) || project.startsWith('\\\\') || project.includes('\\')) return win32.normalize(project).toLowerCase();
  const absolute = project.startsWith('/');
  const parts: string[] = [];
  for (const part of project.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !absolute) parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}`;
}

function coverageKey(report: JsonObject): string {
  const categories = report.coverage as JsonObject;
  const values = categories.categories as JsonObject;
  return JSON.stringify(Object.fromEntries(Object.keys(values).sort().map((key) => {
    const value = values[key];
    return [key, object(value) ? value.coverage : null];
  })));
}

function coverageStatuses(report: JsonObject): Record<string, string> {
  const categories = (report.coverage as JsonObject).categories as JsonObject;
  return Object.fromEntries(Object.keys(categories).sort().map((key) => [key, String((categories[key] as JsonObject).coverage)]));
}

function sumByModel(models: JsonObject, field: string): number {
  return Object.values(models).reduce<number>((sum, model) => {
    const value = object(model) ? model[field] : undefined;
    if (field === 'reasoningTokens' && value === undefined) return sum;
    if (!finiteCount(value)) throw new Error(`Audit report has invalid usage.byModel.${field}`);
    return sum + value;
  }, 0);
}

function metric(baseline: number | null, current: number | null, comparable: boolean): Metric {
  return { baseline, current, change: comparable && baseline !== null && current !== null ? current - baseline : null };
}

export function compareReports(baselineValue: unknown, currentValue: unknown, annotations: ComparisonAnnotations = {}): AuditComparison {
  const baseline = auditReport(baselineValue, 'Baseline');
  const current = auditReport(currentValue, 'Current report');
  const baselineProject = baseline.scope as JsonObject;
  const currentProject = current.scope as JsonObject;
  const reasons: string[] = [];
  if (baseline.host !== current.host) reasons.push('Host differs; metrics are shown side by side without deltas.');
  if (projectKey(baselineProject.project as string | null) !== projectKey(currentProject.project as string | null)) reasons.push('Project scope differs; metrics are shown side by side without deltas.');
  if (coverageKey(baseline) !== coverageKey(current)) reasons.push('Coverage differs; metrics are shown side by side without deltas.');
  const comparable = reasons.length === 0;
  const baseCoverage = coverageStatuses(baseline);
  const currentCoverage = coverageStatuses(current);
  const relevantCoverage = ['sessions', 'tool events', 'provider usage', 'output sizes', 're-read identity'];

  const partialReasons: string[] = [];
  for (const [label, report] of [['Baseline', baseline], ['Current', current]] as const) {
    const bounds = report.bounds as JsonObject;
    const usage = report.usage as JsonObject;
    if (bounds.sessionsSkipped || bounds.malformedLines) partialReasons.push(`${label} report is capped or contains unreadable data.`);
    if (usage.sessionsWithoutProviderUsage) partialReasons.push(`${label} report has sessions without provider-reported usage.`);
  }
  if (relevantCoverage.some((key) => baseCoverage[key] !== undefined && baseCoverage[key] !== 'observable')) partialReasons.push('Baseline coverage limits one or more compared observation categories.');
  if (relevantCoverage.some((key) => currentCoverage[key] !== undefined && currentCoverage[key] !== 'observable')) partialReasons.push('Current coverage limits one or more compared observation categories.');
  const partial = partialReasons.length > 0;
  reasons.push(...partialReasons);
  reasons.push('Descriptive comparison only: matching task identity and time windows are not verified, and metric deltas do not establish savings or causation.');

  const totals = (report: JsonObject, field: string): number | null => {
    const usage = report.usage as JsonObject;
    return usage.sessionsWithProviderUsage === 0 ? null : sumByModel(usage.byModel as JsonObject, field);
  };
  const sumRows = (report: JsonObject, rowsField: string, valueField: string): number =>
    (report.opportunities as JsonObject)[rowsField] instanceof Array
      ? ((report.opportunities as JsonObject)[rowsField] as JsonObject[]).reduce((sum, row) => {
        if (!object(row) || !finiteCount(row[valueField])) throw new Error(`Audit report has invalid opportunities.${rowsField}.${valueField}`);
        return sum + row[valueField];
      }, 0)
      : 0;
  const metricPair = (read: (report: JsonObject) => number | null): Metric => metric(read(baseline), read(current), comparable);
  const baseLarge = (baseline.opportunities as JsonObject).largeToolOutputs as JsonObject;
  const currentLarge = (current.opportunities as JsonObject).largeToolOutputs as JsonObject;
  for (const value of [baseLarge.count, baseLarge.chars, currentLarge.count, currentLarge.chars]) if (!finiteCount(value)) throw new Error('Audit report has invalid largeToolOutputs totals');

  const baselineOutcome = annotations.baselineOutcome ?? 'unknown';
  const currentOutcome = annotations.currentOutcome ?? 'unknown';
  const outcomeChange = baselineOutcome === 'unknown' || currentOutcome === 'unknown' ? 'unknown'
    : baselineOutcome === currentOutcome ? 'unchanged' : `${currentOutcome}-after-${baselineOutcome}`;
  const baselineElapsed = annotations.baselineElapsedMs ?? null;
  const currentElapsed = annotations.currentElapsedMs ?? null;
  return {
    status: !comparable ? 'incomparable' : partial ? 'partial' : 'comparable',
    reports: {
      baseline: { host: String(baseline.host), project: baselineProject.project as string | null },
      current: { host: String(current.host), project: currentProject.project as string | null },
    },
    coverage: {
      baseline: baseCoverage,
      current: currentCoverage,
      differences: [...new Set([...Object.keys(baseCoverage), ...Object.keys(currentCoverage)])]
        .filter((key) => baseCoverage[key] !== currentCoverage[key])
        .map((key) => `${key}: ${baseCoverage[key] ?? 'missing'} → ${currentCoverage[key] ?? 'missing'}`),
    },
    metrics: {
      sessionsScanned: metricPair((report) => (report.bounds as JsonObject).sessionsScanned as number),
      inputTokens: metricPair((report) => totals(report, 'inputTokens')),
      outputTokens: metricPair((report) => totals(report, 'outputTokens')),
      cacheReadTokens: metricPair((report) => totals(report, 'cacheReadTokens')),
      cacheCreationTokens: metricPair((report) => totals(report, 'cacheCreationTokens')),
      reasoningTokens: metricPair((report) => totals(report, 'reasoningTokens')),
      repeatedReads: metricPair((report) => sumRows(report, 'repeatedReads', 'identicalRepeats')),
      repeatedSearches: metricPair((report) => sumRows(report, 'repeatedSearches', 'calls')),
      largeToolOutputCount: metric(baseLarge.count as number, currentLarge.count as number, comparable),
      largeToolOutputChars: metric(baseLarge.chars as number, currentLarge.chars as number, comparable),
    },
    taskOutcome: { baseline: baselineOutcome, current: currentOutcome, change: outcomeChange },
    elapsedMs: { baseline: baselineElapsed, current: currentElapsed, change: baselineElapsed !== null && currentElapsed !== null ? currentElapsed - baselineElapsed : null },
    notes: [...new Set(reasons)],
  };
}
