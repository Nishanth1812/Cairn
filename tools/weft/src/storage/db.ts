import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

function defaultStateDir(): string {
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'Weft', 'state');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Weft', 'state');
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'Weft');
}

export function openDatabase(stateDir: string = defaultStateDir()): Database.Database {
  const path = stateDir === ':memory:' ? stateDir : join(stateDir, 'weft.db');
  if (path !== ':memory:') mkdirSync(stateDir, { recursive: true });
  const db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function repairCorruptDatabase(stateDir: string, repair = true): Promise<{ integrity: string; backup?: string }> {
  const path = join(stateDir, 'weft.db');
  if (!existsSync(path)) return { integrity: 'missing' };
  let integrity = 'unreadable';
  try { const db = new Database(path, { readonly: true, fileMustExist: true }); try { integrity = db.pragma('quick_check', { simple: true }) as string; } finally { db.close(); } }
  catch (error) {
    // Only a database SQLite calls corrupt is moved aside; a busy or locked one is in use and must stay where it is.
    const code = (error as { code?: string }).code ?? '';
    if (!/^SQLITE_(CORRUPT|NOTADB)/.test(code)) return { integrity: `unreadable (${code || 'unknown'})` };
  }
  if (integrity === 'ok' || !repair) return { integrity };
  const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await rename(path, backup);
  await rename(`${path}-wal`, `${backup}-wal`).catch(() => undefined);
  await rename(`${path}-shm`, `${backup}-shm`).catch(() => undefined);
  return { integrity, backup };
}
