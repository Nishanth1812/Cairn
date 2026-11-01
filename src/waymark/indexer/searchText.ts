const IDENTIFIER = /[A-Za-z][A-Za-z0-9]*/g;
const MAX_EXTRA = 4000;

/** Splits a camelCase or PascalCase identifier into lowercase words; a single word returns []. */
export function splitIdentifier(name: string): string[] {
  const parts = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(' ');
  return parts.length > 1 ? parts : [];
}

/**
 * The text the full-text index sees: the code plus the words inside its camelCase identifiers.
 * The index tokenizer cannot split `retryRequest`, so without this a search for "request" would miss it.
 */
export function buildSearchText(text: string): string {
  const extra = new Set<string>();
  for (const [name] of text.matchAll(IDENTIFIER)) for (const part of splitIdentifier(name)) extra.add(part);
  return extra.size ? `${text}\n${[...extra].join(' ').slice(0, MAX_EXTRA)}` : text;
}
