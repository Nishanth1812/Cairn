export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.1);
}

export function fitsBudget(text: string, maxTokens: number): boolean {
  return estimateTokens(text) <= maxTokens;
}
