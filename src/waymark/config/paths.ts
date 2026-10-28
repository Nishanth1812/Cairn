import { realpathSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

export interface UserPaths { config: string; instructions: string; state: string; cache: string }

export function getUserPaths(os = platform(), env: NodeJS.ProcessEnv = process.env): UserPaths {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (os === 'win32') {
    const roaming = env.APPDATA || join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return {
      config: join(roaming, 'weft').replace(/\\/g, '/'),
      instructions: join(roaming, 'weft', 'instructions').replace(/\\/g, '/'),
      state: join(local, 'weft', 'state').replace(/\\/g, '/'),
      cache: join(local, 'weft', 'cache').replace(/\\/g, '/')
    };
  }
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  const state = env.XDG_STATE_HOME || join(home, '.local', 'state');
  const cache = env.XDG_CACHE_HOME || join(home, '.cache');
  return {
    config: join(config, 'weft').replace(/\\/g, '/'),
    instructions: join(config, 'weft', 'instructions').replace(/\\/g, '/'),
    state: join(state, 'weft').replace(/\\/g, '/'),
    cache: join(cache, 'weft').replace(/\\/g, '/')
  };
}

export function ensureDir(dirPath: string): void { mkdirSync(dirPath, { recursive: true }); }

export async function normalizeCanonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return (await import('node:fs/promises')).realpath(absolute).then((p) => p.replace(/\\/g, '/')); }
  catch { return absolute.replace(/\\/g, '/'); }
}

export function normalizeCanonicalPathSync(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute).replace(/\\/g, '/'); }
  catch { return absolute.replace(/\\/g, '/'); }
}
