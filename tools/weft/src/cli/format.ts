type Location = { path: string; startLine: number; endLine: number; safeText: string; symbols?: string[] };

function header(item: Location): string {
  const symbol = item.symbols?.find(name => item.safeText.includes(name)) ?? item.symbols?.[0];
  return `${item.path}:${item.startLine}-${item.endLine}  ${symbol ?? item.safeText.split(/\r?\n/, 1)[0]?.trim() ?? ''}`;
}

export function formatSearch(items: Location[]): string {
  const unique = items.filter((item, index) => !items.slice(0, index).some(previous => previous.path === item.path && previous.startLine <= item.endLine && item.startLine <= previous.endLine));
  return unique.map(item => `${header(item)}\n${item.safeText.split(/\r?\n/, 1)[0] ?? ''}`).join('\n\n');
}

export function formatContext(items: Location[]): string {
  return items.map(item => `${header(item)}\n${item.safeText}`).join('\n\n');
}
