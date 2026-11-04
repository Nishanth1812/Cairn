export interface ReferenceSite {
  identifier: string;
  line: number;
  groupName: string;
  symbolKind: string;
  referenceKind: 'call' | 'import' | 're-export' | 'module-level';
  specifier?: string;
}

export function referenceSites(
  chunks: Array<{ startLine: number; safeText: string }>,
  symbols: Array<{ name: string; kind: string; startLine: number; endLine: number }>,
  file: string,
): ReferenceSite[] {
  const hits = new Map<string, ReferenceSite>();
  let lastLine = 0, blockComment = false, stringDelimiter = '';
  const active: typeof symbols = [];
  let nextOwner = 0;
  for (const chunk of chunks) {
    const lines = chunk.safeText.split('\n');
    for (let offset = 0; offset < lines.length; offset++) {
      const line = chunk.startLine + offset;
      if (line <= lastLine) continue;
      if (lastLine && line !== lastLine + 1) { blockComment = false; stringDelimiter = ''; }
      lastLine = line;
      while (nextOwner < symbols.length && symbols[nextOwner]!.startLine <= line) active.push(symbols[nextOwner++]!);
      for (let i = active.length - 1; i >= 0; i--) if (active[i]!.endLine < line) active.splice(i, 1);
      const owner = active.reduce<(typeof symbols)[number] | undefined>((best, symbol) => !best || symbol.endLine - symbol.startLine < best.endLine - best.startLine ? symbol : best, undefined);
      const sourceLine = lines[offset]!;
      const code = maskCommentsAndStrings(sourceLine, { blockComment, stringDelimiter }, (state) => { blockComment = state.blockComment; stringDelimiter = state.stringDelimiter; }, /\.py$/i.test(file));
      const importLine = /^\s*import\b/.test(sourceLine);
      const exportLine = /^\s*export\b/.test(sourceLine);
      const referenceKind: ReferenceSite['referenceKind'] = importLine ? 'import' : exportLine && /^\s*export\s+(?:type\s+)?(?:\{|\*)/.test(sourceLine) ? 're-export' : owner ? 'call' : 'module-level';
      const groupName = owner?.name ?? 'module level';
      const symbolKind = owner?.kind ?? 'module';
      for (const match of code.matchAll(/[\p{L}\p{N}_$]+/gu)) {
        const identifier = match[0]!;
        if (owner?.name === identifier && owner.startLine === line && /(?:function|class|interface|type|const|let|var)\s+$/.test(code.slice(0, match.index))) continue;
        const site = { identifier, line, groupName, symbolKind, referenceKind };
        hits.set(`${line}:${identifier}:${referenceKind}`, site);
      }
      const wildcard = sourceLine.match(/^\s*export\s+(?:type\s+)?\*\s+from\s+['"]([^'"]+)['"]/)?.[1];
      if (wildcard) hits.set(`${line}:*`, { identifier: '', line, groupName: 'module level', symbolKind: 'module', referenceKind: 're-export', specifier: wildcard });
    }
  }
  return [...hits.values()];
}

export function maskCommentsAndStrings(line: string, initial: { blockComment: boolean; stringDelimiter: string }, save: (state: { blockComment: boolean; stringDelimiter: string }) => void, python: boolean): string {
  let output = '', quote = initial.stringDelimiter;
  let blockComment = initial.blockComment;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!, next = line[i + 1];
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; i++; } output += ' '; continue; }
    if (quote) {
      if (line.startsWith(quote, i)) { output += ' '.repeat(quote.length); i += quote.length - 1; quote = ''; continue; }
      if (char === '\\') { output += '  '; i++; continue; }
      output += ' ';
      continue;
    }
    if (char === '/' && next === '/') break;
    if (char === '/' && next === '*') { blockComment = true; output += '  '; i++; continue; }
    if (python && char === '#') break;
    if (python && (line.startsWith('"""', i) || line.startsWith("'''", i))) { quote = line.slice(i, i + 3); output += '   '; i += 2; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; output += ' '; continue; }
    output += char;
  }
  save({ blockComment, stringDelimiter: quote === '`' || quote.length === 3 ? quote : '' });
  return output;
}
