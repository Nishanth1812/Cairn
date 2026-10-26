import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const BEGIN_MANAGED_BLOCK = '<!-- BEGIN WEFT MANAGED BLOCK -->';
export const END_MANAGED_BLOCK = '<!-- END WEFT MANAGED BLOCK -->';

function managedBlock(content: string): string {
  return `${BEGIN_MANAGED_BLOCK}\n${content.replace(/\r?\n$/, '')}\n${END_MANAGED_BLOCK}`;
}

export async function syncInstructions(targetPath: string, managedContent: string, dryRun = false): Promise<{ modified: boolean; content: string }> {
  let original: string;
  try { original = await readFile(targetPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    original = '';
  }
  const block = managedBlock(managedContent);
  const start = original.indexOf(BEGIN_MANAGED_BLOCK);
  const end = original.indexOf(END_MANAGED_BLOCK);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) throw new Error(`Invalid managed instruction markers in ${targetPath}`);
  let content: string;
  if (start >= 0) {
    const endAfter = end + END_MANAGED_BLOCK.length;
    content = original.slice(0, start) + block + original.slice(endAfter);
  } else {
    content = original ? `${original}${original.endsWith('\n') ? '' : '\n'}${block}\n` : `${block}\n`;
  }
  const modified = content !== original;
  if (modified && !dryRun) {
    await mkdir(dirname(targetPath), { recursive: true });
    const temporary = join(dirname(targetPath), `.${randomUUID()}.tmp`);
    try { await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, targetPath); }
    finally { await rm(temporary, { force: true }); }
  }
  return { modified, content };
}

export async function checkInstructions(targetPath: string, expectedContent: string): Promise<{ matches: boolean; diff?: string }> {
  let actual: string;
  try { actual = await readFile(targetPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    actual = '';
  }
  const expectedBlock = managedBlock(expectedContent);
  const start = actual.indexOf(BEGIN_MANAGED_BLOCK);
  const end = actual.indexOf(END_MANAGED_BLOCK);
  const currentBlock = start >= 0 && end >= start ? actual.slice(start, end + END_MANAGED_BLOCK.length) : '';
  return currentBlock === expectedBlock ? { matches: true } : { matches: false, diff: `Expected:\n${expectedBlock}\nActual:\n${currentBlock || '(missing)'}` };
}
