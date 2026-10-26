import type Database from 'better-sqlite3';

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

type UsageRow = {
  provenance: string;
  cost_micros: number | null;
  harness: string | null;
  model: string | null;
  repo: string | null;
};

function addCost(group: CostGroup, row: UsageRow): void {
  group.eventCount++;
  const cost = row.cost_micros ?? 0;
  if (row.provenance === 'provider_reported') group.providerReportedCostMicros += cost;
  else if (row.provenance === 'estimated') group.estimatedCostMicros += cost;
  else group.otherCostMicros += cost;
  group.totalCostMicros += cost;
}

function emptyGroup(key: string): CostGroup {
  return { key, providerReportedCostMicros: 0, estimatedCostMicros: 0, otherCostMicros: 0, totalCostMicros: 0, eventCount: 0 };
}

export function getCostSummary(
  db: Database.Database,
  options: { since?: string; by?: 'harness' | 'model' | 'repo' } = {},
): CostSummaryResult {
  const rows = db.prepare(`SELECT u.provenance, u.cost_micros, COALESCE(s.harness, u.source) AS harness,
      COALESCE(u.model, s.model) AS model, r.display_name AS repo
    FROM usage_events u LEFT JOIN sessions s ON s.id = u.session_id
    LEFT JOIN repositories r ON r.id = s.repo_id
    WHERE (? IS NULL OR u.observed_at >= ?)`)
    .all(options.since ?? null, options.since ?? null) as UsageRow[];
  const totals = emptyGroup('');
  const grouped = new Map<string, CostGroup>();
  for (const row of rows) {
    addCost(totals, row);
    if (!options.by) continue;
    const value = row[options.by] ?? 'unknown';
    let group = grouped.get(value);
    if (!group) { group = emptyGroup(value); grouped.set(value, group); }
    addCost(group, row);
  }
  const { key: _key, ...summary } = totals;
  return { totals: summary, ...(options.by ? { by: options.by } : {}), groups: [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

export function getCacheDiagnostics(db: Database.Database, options: { since?: string } = {}): CacheDiagnosticResult {
  const rows = db.prepare(`SELECT cache_kind, COALESCE(SUM(hit_tokens), 0) AS hit_tokens,
      COALESCE(SUM(miss_tokens), 0) AS miss_tokens, COUNT(*) AS diagnostics_count
    FROM cache_diagnostics WHERE (? IS NULL OR observed_at >= ?) GROUP BY cache_kind ORDER BY cache_kind`)
    .all(options.since ?? null, options.since ?? null) as Array<{ cache_kind: string; hit_tokens: number; miss_tokens: number; diagnostics_count: number }>;
  const byKind = rows.map(({ cache_kind, hit_tokens, miss_tokens, diagnostics_count }) => ({
    cacheKind: cache_kind, hitTokens: hit_tokens, missTokens: miss_tokens, diagnosticsCount: diagnostics_count,
  }));
  return byKind.reduce((total, row) => ({
    hitTokens: total.hitTokens + row.hitTokens, missTokens: total.missTokens + row.missTokens,
    diagnosticsCount: total.diagnosticsCount + row.diagnosticsCount, byKind,
  }), { hitTokens: 0, missTokens: 0, diagnosticsCount: 0, byKind });
}

export function listSessions(db: Database.Database, limit = 50): SessionSummary[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative safe integer');
  return db.prepare(`SELECT s.id, r.display_name AS repo, s.harness, s.model, s.started_at, s.ended_at,
      COUNT(u.id) AS event_count, COALESCE(SUM(u.cost_micros), 0) AS cost_micros
    FROM sessions s LEFT JOIN repositories r ON r.id = s.repo_id
    LEFT JOIN usage_events u ON u.session_id = s.id
    GROUP BY s.id ORDER BY s.started_at DESC LIMIT ?`).all(limit).map((row) => {
      const session = row as { id: string; repo: string | null; harness: string; model: string | null; started_at: string; ended_at: string | null; event_count: number; cost_micros: number };
      return { id: session.id, repo: session.repo, harness: session.harness, model: session.model,
        startedAt: session.started_at, endedAt: session.ended_at, eventCount: session.event_count, costMicros: session.cost_micros };
    });
}
