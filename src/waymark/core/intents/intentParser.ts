export interface ParsedIntent {
  now: string[];
  next: string[];
  deadlines: Array<{ date: string; goal: string }>;
  someday: string[];
}

export function parseIntent(markdown: string): ParsedIntent {
  const result: ParsedIntent = { now: [], next: [], deadlines: [], someday: [] };
  let section: keyof ParsedIntent | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(Now|Next|Deadlines|Someday)\s*#*\s*$/i.exec(line.trim());
    if (heading) { section = heading[1]!.toLowerCase() as keyof ParsedIntent; continue; }
    if (/^#{1,2}\s/.test(line.trim())) { section = null; continue; }
    const item = /^\s*[-*+]\s+(.+?)\s*$/.exec(line);
    if (!section || !item) continue;
    if (section === 'deadlines') {
      const deadline = /^(\d{4}-\d{2}-\d{2})\s*[-—]\s*(.+)$/.exec(item[1]!);
      if (deadline) result.deadlines.push({ date: deadline[1]!, goal: deadline[2]!.trim() });
    } else result[section].push(item[1]!);
  }
  return result;
}

export function generateDefaultIntent(): string {
  return `# Weft Intent\n\n## Now\n- \n\n## Next\n- \n\n## Deadlines\n- YYYY-MM-DD - Goal description\n\n## Someday\n- \n`;
}
