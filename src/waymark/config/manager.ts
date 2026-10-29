import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getUserPaths } from './paths.js';

export interface WeftConfig { version: 1; repositories: string[]; autoOnboard: boolean; maxTrackedFiles: number }
const DEFAULT_CONFIG: WeftConfig = { version: 1, repositories: [], autoOnboard: true, maxTrackedFiles: 20_000 };
const configPath = () => join(getUserPaths().config, 'config.json');

function validateConfig(value: unknown): WeftConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_CONFIG };
  const data = value as Record<string, unknown>;
  return { version: 1, repositories: Array.isArray(data.repositories) ? data.repositories.filter((v): v is string => typeof v === 'string') : [], autoOnboard: typeof data.autoOnboard === 'boolean' ? data.autoOnboard : true, maxTrackedFiles: Number.isSafeInteger(data.maxTrackedFiles) && Number(data.maxTrackedFiles) > 0 ? Number(data.maxTrackedFiles) : 20_000 };
}

export async function loadConfig(path = configPath()): Promise<WeftConfig> {
  try { return validateConfig(JSON.parse(await readFile(path, 'utf8')) as unknown); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_CONFIG };
    if (error instanceof SyntaxError) return { ...DEFAULT_CONFIG };
    throw error;
  }
}

export async function saveConfig(config: WeftConfig, path = configPath()): Promise<void> {
  const valid = validateConfig(config);
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try { await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
