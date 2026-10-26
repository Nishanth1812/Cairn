import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

export async function suggestChecks(repoRoot: string, changedFiles: string[]): Promise<string[]> {
  const packagePath = join(repoRoot, 'package.json');
  if (!existsSync(packagePath)) return [];
  const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
  const scripts = pkg.scripts ?? {}, commands = Object.keys(scripts).filter((name) => ['test', 'lint', 'build', 'typecheck'].includes(name)).map((name) => `npm run ${name}`);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.vitest && !deps.jest && !/vitest|jest/.test(scripts.test ?? '')) return commands;
  const tests = new Set<string>();
  for (const file of changedFiles) {
    const ext = extname(file), stem = basename(file, ext);
    const candidates = [`${file.slice(0, -ext.length)}.test${ext}`, `${file.slice(0, -ext.length)}.spec${ext}`];
    const findTests = async (directory: string): Promise<void> => {
      for (const entry of await readdir(join(repoRoot, directory), { withFileTypes: true }).catch(() => [])) {
        const candidate = join(directory, entry.name);
        if (entry.isDirectory()) await findTests(candidate);
        else if (entry.isFile() && [ `${stem}.test${ext}`, `${stem}.spec${ext}` ].includes(entry.name)) candidates.push(candidate);
      }
    };
    await findTests('tests');
    for (const candidate of candidates) {
      if (existsSync(resolve(repoRoot, candidate))) tests.add(candidate.replace(/\\/g, '/'));
    }
  }
  if (tests.size) commands.unshift(`npx ${deps.vitest ? 'vitest' : 'jest'} run ${[...tests].sort().join(' ')}`);
  return commands;
}
