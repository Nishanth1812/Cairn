export function hasPromptSearchIntent(prompt: string): boolean {
  return /\b[A-Za-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[A-Za-z_][A-Za-z0-9]*_[A-Za-z0-9_]+\b|\b[\w./\\-]+\.[A-Za-z0-9]{1,5}\b/.test(prompt);
}
