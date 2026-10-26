const MICROS_PER_MILLION = 1_000_000n;

interface ModelRate {
  input: bigint;
  output: bigint;
  cached: bigint;
  cacheWrite?: bigint;
}

// Rates are micro-dollars per million tokens, matching the Phase 5 pricing snapshot.
const rates: Readonly<Record<string, ModelRate>> = {
  'gpt-4o': { input: 2_500_000n, output: 10_000_000n, cached: 1_250_000n },
  'gpt-4o-mini': { input: 150_000n, output: 600_000n, cached: 75_000n },
  'claude-3-5-sonnet': { input: 3_000_000n, output: 15_000_000n, cached: 300_000n },
  'claude-3-5-sonnet-20240620': { input: 3_000_000n, output: 15_000_000n, cached: 300_000n },
  'claude-3-5-sonnet-20241022': { input: 3_000_000n, output: 15_000_000n, cached: 300_000n },
  'claude-3-7-sonnet': { input: 3_000_000n, output: 15_000_000n, cached: 300_000n },
  'claude-3-haiku': { input: 250_000n, output: 1_250_000n, cached: 30_000n },
  'claude-3-opus': { input: 15_000_000n, output: 75_000_000n, cached: 1_500_000n },
  // Anthropic standard Claude API rates (USD per MTok): cached = cache read, cacheWrite = 5-minute write.
  'claude-opus-5-5': { input: 4_000_000n, output: 20_000_000n, cached: 200_000n, cacheWrite: 5_000_000n },
  'claude-sonnet-5-5': { input: 2_000_000n, output: 10_000_000n, cached: 100_000n, cacheWrite: 2_500_000n },
  'claude-sonnet-5': { input: 2_000_000n, output: 10_000_000n, cached: 200_000n, cacheWrite: 2_500_000n },
  // Haiku 5.5 is priced for prompts up to 100k tokens; longer prompts cost 5x, so this is a lower bound.
  'claude-haiku-5-5': { input: 100_000n, output: 500_000n, cached: 10_000n, cacheWrite: 125_000n },
  'claude-haiku-4-5-20251001': { input: 1_000_000n, output: 5_000_000n, cached: 100_000n, cacheWrite: 1_250_000n },
  'gemini-1.5-pro': { input: 1_250_000n, output: 5_000_000n, cached: 312_500n },
  'gemini-1.5-flash': { input: 75_000n, output: 300_000n, cached: 18_750n },
};

function tokenCount(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return BigInt(value);
}

function roundMicros(numerator: bigint): number {
  const rounded = (numerator + MICROS_PER_MILLION / 2n) / MICROS_PER_MILLION;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('cost exceeds the safe integer range');
  return Number(rounded);
}

export function calculateCostMicros(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  cacheWriteTokens = 0,
): { costMicros: number | null; provenance: 'provider_reported' | 'estimated' | 'unavailable' } {
  const input = tokenCount(inputTokens, 'inputTokens');
  const output = tokenCount(outputTokens, 'outputTokens');
  const cached = tokenCount(cachedInputTokens, 'cachedInputTokens');
  if (cached > input) throw new RangeError('cachedInputTokens cannot exceed inputTokens');
  const rate = rates[model.toLowerCase()];
  if (!rate) return { costMicros: null, provenance: 'unavailable' };
  const cost = (input - cached) * rate.input + cached * rate.cached + output * rate.output
    + tokenCount(cacheWriteTokens, 'cacheWriteTokens') * (rate.cacheWrite ?? rate.input * 5n / 4n);
  return { costMicros: roundMicros(cost), provenance: 'estimated' };
}
