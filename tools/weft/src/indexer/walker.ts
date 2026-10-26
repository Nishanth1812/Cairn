import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { hashBytes } from '../core/fingerprint/hasher.js';
import { shouldExcludePath } from '../core/security/paths.js';
import { containsSecret, redactSecrets } from '../core/security/secretScanner.js';

export interface PreviousFile { mtimeMs: number; sizeBytes: number; hash: string }
export interface CandidateFile {
  path: string; content: string; contentHash: string; mtimeMs: number; sizeBytes: number; language?: string; unchanged?: boolean;
}

const languageByExtension: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.py': 'python',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.json': 'json', '.md': 'markdown', '.sql': 'sql',
};

function globRegex(pattern: string): RegExp {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') { regex += '.*'; i++; }
    else if (char === '*') regex += '[^/]*';
    else if (char === '?') regex += '[^/]';
    else regex += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`^${regex}$`);
}

interface IgnoreRule { base: string; pattern: string; negate: boolean; directoryOnly: boolean; anchored: boolean; regex: RegExp }

function compileRules(lines: string[], base: string): IgnoreRule[] {
  const result: IgnoreRule[] = [];
  for (const source of lines) {
    let pattern = source.trim();
    if (!pattern || pattern.startsWith('#')) continue;
    const negate = pattern.startsWith('!');
    if (negate) pattern = pattern.slice(1);
    if (pattern.startsWith('\\!')) pattern = pattern.slice(1);
    const directoryOnly = pattern.endsWith('/');
    pattern = pattern.replace(/^\//, '').replace(/\/$/, '');
    result.push({ base, pattern, negate, directoryOnly, anchored: pattern.includes('/'), regex: globRegex(pattern) });
  }
  return result;
}

function ignored(path: string, rules: IgnoreRule[]): boolean {
  let excluded = false;
  for (const rule of rules) {
    if (rule.base && !path.startsWith(`${rule.base}/`)) continue;
    const relativePath = rule.base ? path.slice(rule.base.length + 1) : path;
    const parts = relativePath.split('/');
    const candidates = rule.anchored
      ? rule.directoryOnly ? parts.map((_, index) => parts.slice(0, index + 1).join('/')) : [relativePath]
      : parts;
    const matches = candidates.some((part) => rule.regex.test(part) && (!rule.directoryOnly || part !== relativePath || relativePath.includes('/')));
    if (matches) excluded = !rule.negate;
  }
  return excluded;
}

export async function walkRepository(repoRoot: string, previous: Map<string, PreviousFile> = new Map(), onWarning: () => void = () => undefined): Promise<CandidateFile[]> {
  const root = resolve(repoRoot);
  const files: CandidateFile[] = [];
  const visit = async (directory: string, inheritedRules: IgnoreRule[] = []): Promise<void> => {
    let rules = inheritedRules;
    try { rules = [...rules, ...compileRules((await readFile(join(directory, '.gitignore'), 'utf8')).split(/\r?\n/), relative(root, directory).split(sep).join('/'))]; } catch { /* no ignore file */ }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { onWarning(); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (shouldExcludePath(path) || entry.name === '.gitignore') continue;
      if (entry.isDirectory()) { await visit(absolute, rules); continue; }
      if (!entry.isFile()) continue;
      if (ignored(path, rules)) continue;
      let metadata;
      try { metadata = await stat(absolute); } catch { onWarning(); continue; }
      if (metadata.size > 2 * 1024 * 1024) { onWarning(); continue; }
      const cached = previous.get(path);
      if (cached && cached.mtimeMs === Math.round(metadata.mtimeMs) && cached.sizeBytes === metadata.size) {
        files.push({ path, content: '', contentHash: cached.hash, mtimeMs: metadata.mtimeMs, sizeBytes: metadata.size, language: languageByExtension[extname(path).toLowerCase()], unchanged: true });
        continue;
      }
      let bytes: Buffer;
      try { bytes = await readFile(absolute); } catch { onWarning(); continue; }
      if (bytes.includes(0)) { onWarning(); continue; }
      const source = bytes.toString('utf8').replace(/^\uFEFF/, '');
      if (source.includes('\uFFFD')) { onWarning(); continue; }
      const contentHash = hashBytes(bytes);
      files.push({ path, content: containsSecret(source) ? redactSecrets(source) : source, contentHash, mtimeMs: metadata.mtimeMs, sizeBytes: metadata.size, language: languageByExtension[extname(path).toLowerCase()] });
    }
  };
  await visit(root);
  return files;
}
