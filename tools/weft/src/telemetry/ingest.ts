import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { calculateCostMicros } from './pricing.js';

export type UsageProvenance = 'provider_reported' | 'harness_reported' | 'local_parsed' | 'estimated';

export interface UsageEventInput {
  source: string;
  provenance: UsageProvenance;
  observedAt?: string;
  sessionId?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteTokens?: number | null;
  costMicros?: number | null;
  pricingSnapshotId?: string | null;
  confidence?: number | null;
}

function optionalCount(value: number | null | undefined, field: string): number | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} must be a non-negative safe integer`);
  return value;
}

export function recordUsageEvent(db: Database.Database, event: UsageEventInput): string {
  if (!/^[\w.-]{1,64}$/.test(event.source)) throw new TypeError('source must be a short identifier');
  const inputTokens = optionalCount(event.inputTokens, 'inputTokens');
  const outputTokens = optionalCount(event.outputTokens, 'outputTokens');
  const reasoningTokens = optionalCount(event.reasoningTokens, 'reasoningTokens');
  const cachedInputTokens = optionalCount(event.cachedInputTokens, 'cachedInputTokens');
  const cacheWriteTokens = optionalCount(event.cacheWriteTokens, 'cacheWriteTokens');
  const estimatedCost = event.provenance === 'estimated' && event.costMicros == null && event.model && inputTokens != null && outputTokens != null
    ? calculateCostMicros(event.model, inputTokens, outputTokens, cachedInputTokens ?? 0).costMicros
    : null;
  if (event.costMicros != null && (!Number.isSafeInteger(event.costMicros) || event.costMicros < 0)) {
    throw new RangeError('costMicros must be a non-negative safe integer');
  }
  if (event.confidence != null && (!Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1)) {
    throw new RangeError('confidence must be between 0 and 1');
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO usage_events
    (id, session_id, source, provenance, observed_at, model, input_tokens, output_tokens, reasoning_tokens,
     cached_input_tokens, cache_write_tokens, cost_micros, pricing_snapshot_id, confidence, raw_metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`)
    .run(id, event.sessionId ?? null, event.source, event.provenance, event.observedAt ?? new Date().toISOString(),
      event.model ?? null, inputTokens, outputTokens, reasoningTokens, cachedInputTokens, cacheWriteTokens,
      event.costMicros ?? estimatedCost, event.pricingSnapshotId ?? null, event.confidence ?? null);
  return id;
}
