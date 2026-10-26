// Where collectors keep their parse cache. A git checkout keeps it in ./.cache; an npm install (read-only, shared) uses the home dir.
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = process.env.TOKEN_ODOMETER_CACHE
  || (import.meta.dirname.includes('node_modules') ? join(homedir(), '.token-odometer') : join(import.meta.dirname, '..', '.cache'));
export const cacheFile = (name) => join(dir, name);
