import type Database from 'better-sqlite3';
import { readOdometer, rangeForSince, type OdometerRow } from './odometer.js';

export type CostGroup = {
  key: string;
  providerReportedCostMicros: number;
  estimatedCostMicros: number;
  otherCostMicros: number;
  totalCostMicros: number;
  eventCount: number;
};

export interface CostSummaryResult {
  totals: Omit<CostGroup, 'key'>;
  by?: 'harness' | 'model' | 'repo';
  groups: CostGroup[];
}

export interface CacheDiagnosticResult {
  hitTokens: number;
  missTokens: number;
  diagnosticsCount: number;
  byKind: Array<{ cacheKind: string; hitTokens: number; missTokens: number; diagnosticsCount: number }>;
}

export interface SessionSummary {
  id: string;
  repo: string | null;
  harness: string;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  eventCount: number;
  costMicros: number;
}

const micros = (usd: number) => Math.round((usd ?? 0) * 1_000_000);

export async function odometerRows(since?: string): Promise<OdometerRow[]> {
  return readOdometer(rangeForSince(since));
}

function addCost(group: CostGroup, costMicros: number): void {
  group.eventCount++;
  group.providerReportedCostMicros += costMicros;
  group.totalCostMicros += costMicros;
}

function emptyGroup(key: string): CostGroup {
  return { key, providerReportedCostMicros: 0, estimatedCostMicros: 0, otherCostMicros: 0, totalCostMicros: 0, eventCount: 0 };
}

export async function getCostSummary(
  _db: Database.Database,
  options: { since?: string; by?: 'harness' | 'model' | 'repo' } = {},
): Promise<CostSummaryResult> {
  const rows = await odometerRows(options.since);
  const totals = emptyGroup('');
  const grouped = new Map<string, CostGroup>();
  for (const row of rows) {
    const cost = micros(row.costUsd);
    addCost(totals, cost);
    if (!options.by) continue;
    const value = options.by === 'model' ? row.model ?? 'unknown' : options.by === 'harness' ? row.tool : row.project ?? 'unknown';
    let group = grouped.get(value);
    if (!group) { group = emptyGroup(value); grouped.set(value, group); }
    addCost(group, cost);
  }
  const { key: _key, ...summary } = totals;
  return { totals: summary, ...(options.by ? { by: options.by } : {}), groups: [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

export async function getCacheDiagnostics(_db: Database.Database, options: { since?: string } = {}): Promise<CacheDiagnosticResult> {
  const rows = await odometerRows(options.since);
  const hitTokens = rows.reduce((sum, row) => sum + row.cacheRead, 0);
  const byKind = [{ cacheKind: 'odometer', hitTokens, missTokens: 0, diagnosticsCount: rows.length }];
  return { hitTokens, missTokens: 0, diagnosticsCount: rows.length, byKind };
}

export async function listSessions(_db: Database.Database, limit = 50): Promise<SessionSummary[]> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative safe integer');
  const rows = await readOdometer('All');
  const bySession = new Map<string, { rows: typeof rows; model: string | null; startedAt: string; endedAt: string }>();
  for (const row of rows) {
    let entry = bySession.get(row.session);
    if (!entry) { entry = { rows: [], model: row.model, startedAt: row.time, endedAt: row.time }; bySession.set(row.session, entry); }
    entry.rows.push(row);
    if (row.time < entry.startedAt) entry.startedAt = row.time;
    if (row.time > entry.endedAt) entry.endedAt = row.time;
    entry.model = row.model;
  }
  return [...bySession.entries()]
    .map(([id, entry]) => ({
      id,
      repo: null,
      harness: entry.rows[0]?.tool ?? 'unknown',
      model: entry.model,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      eventCount: entry.rows.length,
      costMicros: entry.rows.reduce((sum, row) => sum + micros(row.costUsd), 0),
    }))
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    .slice(0, limit);
}
