export interface CodeSymbol { name: string; kind: string; startLine: number; endLine: number }

type Rule = { regex: RegExp; kind: string };
const rules: Record<string, Rule[]> = {
  ts: [
    { regex: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([\w$]+)/, kind: 'function' },
    { regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([\w$]+)/, kind: 'class' },
    { regex: /^\s*(?:export\s+)?interface\s+([\w$]+)/, kind: 'interface' },
    { regex: /^\s*(?:export\s+)?type\s+([\w$]+)/, kind: 'type' },
    { regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/, kind: 'function' },
    { regex: /^\s*(?:async\s+)?(?:static\s+)?([\w$]+)\s*\([^;]*\)\s*\{/, kind: 'method' },
  ],
  py: [ { regex: /^\s*(?:async\s+)?def\s+([\w]+)/, kind: 'function' }, { regex: /^\s*class\s+([\w]+)/, kind: 'class' } ],
  go: [ { regex: /^\s*func\s+(?:\([^)]*\)\s*)?([\w]+)/, kind: 'function' }, { regex: /^\s*type\s+([\w]+)\s+(?:struct|interface)\b/, kind: 'type' } ],
  rs: [ { regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([\w]+)/, kind: 'function' }, { regex: /^\s*(?:pub\s+)?struct\s+([\w]+)/, kind: 'class' }, { regex: /^\s*(?:pub\s+)?enum\s+([\w]+)/, kind: 'type' }, { regex: /^\s*(?:pub\s+)?trait\s+([\w]+)/, kind: 'interface' }, { regex: /^\s*(?:pub\s+)?type\s+([\w]+)/, kind: 'type' } ],
  java: [ { regex: /^\s*(?:(?:public|protected|private|static|final|abstract|synchronized)\s+)*class\s+([\w]+)/, kind: 'class' }, { regex: /^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*interface\s+([\w]+)/, kind: 'interface' }, { regex: /^\s*(?:(?:public|protected|private|static|final|synchronized)\s+)*[\w<>\[\], ?]+\s+([\w]+)\s*\([^;]*\)\s*\{/, kind: 'method' } ],
  c: [ { regex: /^\s*(?:typedef\s+)?(?:struct|enum)\s+([\w]+)/, kind: 'type' }, { regex: /^\s*(?:[\w*]+\s+)+([\w]+)\s*\([^;]*\)\s*\{/, kind: 'function' } ],
  cpp: [ { regex: /^\s*(?:class|struct)\s+([\w]+)/, kind: 'class' }, { regex: /^\s*(?:[\w:*&<>]+\s+)+([\w~]+)\s*\([^;]*\)\s*(?:const\s*)?\{/, kind: 'function' } ],
};

function endLine(lines: string[], start: number, language: string): number {
  const first = lines[start - 1] ?? '';
  if (language === 'python') {
    const indent = first.match(/^\s*/)?.[0].length ?? 0;
    let end = start;
    for (let i = start; i < lines.length; i++) {
      if (lines[i]!.trim() && (lines[i]!.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
      end = i + 1;
    }
    return end;
  }
  let depth = 0;
  let opened = false;
  for (let i = start - 1; i < lines.length; i++) {
    for (const char of lines[i]!) {
      if (char === '{') { depth++; opened = true; }
      else if (char === '}' && opened && --depth === 0) return i + 1;
    }
    if (!opened && i > start - 1) break;
  }
  return start;
}

export function detectLanguage(path: string): string | undefined {
  const extension = path.split('.').at(-1)?.toLowerCase();
  return extension && ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp' } as Record<string, string>)[extension];
}

export function extractSymbols(source: string, pathOrLanguage: string): CodeSymbol[] {
  const extension = pathOrLanguage.includes('.') ? pathOrLanguage.split('.').at(-1)!.toLowerCase() : pathOrLanguage.toLowerCase();
  const language = extension === 'tsx' || extension === 'js' || extension === 'jsx' ? 'ts' : extension === 'h' ? 'c' : extension === 'hpp' || extension === 'cc' ? 'cpp' : extension;
  const patterns = rules[language];
  if (!patterns) return [];
  const lines = source.split(/\r?\n/);
  const found: CodeSymbol[] = [];
  const keywords = new Set(['if', 'else', 'catch', 'for', 'while', 'switch', 'case', 'do', 'try', 'return', 'throw', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'await', 'yield', 'with', 'super']);
  for (let index = 0; index < lines.length; index++) {
    for (const rule of patterns) {
      const match = lines[index]!.match(rule.regex);
      if (match?.[1] && !keywords.has(match[1])) { found.push({ name: match[1], kind: rule.kind, startLine: index + 1, endLine: endLine(lines, index + 1, language === 'py' ? 'python' : language) }); break; }
    }
  }
  return found;
}
