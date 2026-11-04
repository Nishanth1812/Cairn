import { redactSecrets } from './secretScanner.js';
import { PIIVault } from './pii.js';

// Redact string values, never serialized JSON: a match next to a quote would corrupt the document.
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSafe(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)])) as T;
  return value;
}

export function redactSafe(text: string): string {
  return new PIIVault().mask(redactSecrets(text));
}
