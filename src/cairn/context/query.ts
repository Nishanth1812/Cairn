const QUESTION_WORDS = new Set(['a', 'an', 'and', 'are', 'can', 'do', 'does', 'for', 'how', 'in', 'is', 'of', 'on', 'the', 'to', 'what', 'where', 'which', 'why']);

export function queryTerms(query: string): string[] {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const specific = terms.filter(term => !QUESTION_WORDS.has(term.toLocaleLowerCase()));
  return specific.length ? specific : terms;
}
