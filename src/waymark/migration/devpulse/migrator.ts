import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { getUserPaths } from '../../config/paths.js';
import { openDatabase } from '../../storage/db.js';
import { migrate } from '../../storage/migrator.js';

export interface MigrationReport {
  sourcePath: string;
  imported: number;
  skipped: number;
  warnings: string[];
  dryRun: boolean;
}

const digest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const stableId = (value: string) => createHash('sha256').update(value).digest('hex');

function sourceDirectory(sourcePath?: string): string {
  const configured = sourcePath ?? process.env.DEVPULSE_CONFIG ?? join(homedir(), '.devpulse');
  const resolved = resolve(configured);
  return basename(resolved).toLowerCase() === 'config.toml' ? join(resolved, '..') : resolved;
}

function parseRepositories(toml: string): Array<{ name: string; path: string }> {
  const output: Array<{ name: string; path: string }> = [];
  const push = (name: string | undefined, path: string | undefined) => {
    if (!path) return;
    const rootPath = resolve(path.replaceAll('\\\\', '\\'));
    output.push({ name: name?.trim() || basename(rootPath), path: rootPath });
  };
  for (const block of toml.matchAll(/\[\[repositories?\]\]([\s\S]*?)(?=\n\s*\[\[|$)/gi)) {
    const fields = Object.fromEntries([...block[1]!.matchAll(/^\s*(name|path|root|root_path)\s*=\s*["']([^"']+)["']/gim)].map((match) => [match[1]!.toLowerCase(), match[2]!])) as Record<string, string>;
    push(fields.name, fields.path ?? fields.root ?? fields.root_path);
  }
  for (const block of toml.matchAll(/\{([^{}]+)\}/g)) {
    const fields = Object.fromEntries([...block[1]!.matchAll(/(name|path|root|root_path)\s*=\s*["']([^"']+)["']/gi)].map((match) => [match[1]!.toLowerCase(), match[2]!])) as Record<string, string>;
    push(fields.name, fields.path ?? fields.root ?? fields.root_path);
  }
  if (!output.length) {
    for (const array of toml.matchAll(/^\s*(?:repositories|repos)\s*=\s*\[([^\]]*)\]/gim)) {
      for (const value of array[1]!.matchAll(/["']([^"']+)["']/g)) push(undefined, value[1]);
    }
  }
  if (!output.length) {
    for (const line of toml.split(/\r?\n/)) {
      const match = /^\s*(?:repo|repository|path)\s*=\s*["']([^"']+)["']/i.exec(line);
      if (match) push(undefined, match[1]);
    }
  }
  return [...new Map(output.map((repo) => [repo.path.toLowerCase(), repo])).values()];
}

function capUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  return bytes.length <= maxBytes ? value : bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
}

function notePayload(title: string, content: string): string {
  let low = 0;
  let high = Math.min(Buffer.byteLength(content), 16 * 1024);
  const atBytes = (size: number) => Buffer.from(content).subarray(0, size).toString('utf8').replace(/\uFFFD$/, '');
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const payload = JSON.stringify({ source: 'devpulse-import', title, content: atBytes(middle) });
    if (Buffer.byteLength(payload) <= 16 * 1024) low = middle;
    else high = middle - 1;
  }
  return JSON.stringify({ source: 'devpulse-import', title, content: capUtf8(atBytes(low), low) });
}

export async function migrateDevPulse(options: { sourcePath?: string; dryRun?: boolean } = {}): Promise<MigrationReport> {
  const source = sourceDirectory(options.sourcePath);
  const dryRun = options.dryRun ?? false;
  const report: MigrationReport = { sourcePath: source, imported: 0, skipped: 0, warnings: [], dryRun };
  const configPath = join(source, 'config.toml');
  let config: string | undefined;
  try { config = await readFile(configPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    report.warnings.push(`Missing ${configPath}`);
  }
  const goalsPath = join(source, 'goals.md');
  let goals: string | undefined;
  try { goals = await readFile(goalsPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const notesPath = join(source, 'notes');
  let notePaths: string[] = [];
  try { notePaths = (await readdir(notesPath)).filter((file) => file.toLowerCase().endsWith('.md')).sort().map((file) => join(notesPath, file)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const paths = getUserPaths();
  const dbPath = join(paths.state, 'weft.db');
  const db = dryRun
    ? (await stat(dbPath).then(() => new Database(dbPath, { readonly: true, fileMustExist: true }), () => { const memory = new Database(':memory:'); migrate(memory); return memory; }))
    : openDatabase(paths.state);
  try {
    if (!dryRun) migrate(db);
    const ledger = db.prepare('SELECT source_key FROM migration_ledger WHERE source_type = ? AND source_key = ?');
    const sourceKey = (key: string, hash: string) => `${source}:${key}:${hash}`;
    const seen = (key: string) => Boolean(ledger.get('devpulse', key));
    const sourceFiles = [
      ...(config === undefined ? [] : [{ path: configPath, key: 'config.toml', content: config }]),
      ...(goals === undefined ? [] : [{ path: goalsPath, key: 'goals.md', content: goals }]),
      ...await Promise.all(notePaths.map(async (path) => ({ path, key: `notes/${basename(path)}`, content: await readFile(path, 'utf8') }))),
    ];
    const repos = parseRepositories(config ?? '');
    const existingRepos = db.prepare('SELECT id, root_path, display_name FROM repositories').all() as Array<{ id: string; root_path: string; display_name: string }>;
    const importedRepos = repos.map((repo) => ({ ...repo, id: stableId(`devpulse:${repo.path}`) }));
    const now = new Date().toISOString();
    const insertRepo = db.prepare('INSERT OR IGNORE INTO repositories (id, root_path, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)');
    const insertLedger = db.prepare('INSERT INTO migration_ledger (source_type, source_key, imported_at, target_table, target_id) VALUES (?, ?, ?, ?, ?)');
    const queue = (key: string, hash: string, targetTable: string, targetId: string) => {
      const entryKey = sourceKey(key, hash);
      if (seen(entryKey)) { report.skipped++; return false; }
      report.imported++;
      if (!dryRun) insertLedger.run('devpulse', entryKey, now, targetTable, targetId);
      return true;
    };
    const intentWrite = goals === undefined ? undefined : await (async () => {
      const target = join(paths.instructions, 'intent.md');
      const alternate = join(paths.instructions, 'intent.devpulse.md');
      const targetExists = await stat(target).then((item) => item.isFile(), () => false);
      const destination = targetExists ? alternate : target;
      if (!seen(sourceKey('goals.md', digest(goals)))) {
        if (!dryRun) {
          await mkdir(paths.instructions, { recursive: true });
          if (destination === target) await copyFile(goalsPath, target);
          else await writeFile(alternate, goals, 'utf8');
        }
      }
      return destination;
    })();
    const apply = () => {
      for (const repo of importedRepos) {
        const existing = existingRepos.find((item) => item.root_path.toLowerCase() === repo.path.toLowerCase());
        const targetId = existing?.id ?? repo.id;
        if (queue(`config.toml:${repo.path}`, digest(config ?? ''), 'repositories', targetId) && !dryRun) {
          const nameTaken = existingRepos.some((item) => item.display_name.toLowerCase() === repo.name.toLowerCase() && item.id !== existing?.id);
          insertRepo.run(targetId, repo.path, nameTaken ? `${repo.name} (DevPulse)` : repo.name, now, now);
        }
      }
      if (config !== undefined && !importedRepos.length) queue('config.toml', digest(config), 'repositories', 'manifest');
      if (goals !== undefined) {
        queue('goals.md', digest(goals), 'intent', intentWrite!);
      }
      if (notePaths.length && !importedRepos.length && !existingRepos.length) report.warnings.push('Notes were not imported because no repositories are registered.');
      const availableRepos = [...existingRepos, ...importedRepos.map((repo) => ({ id: repo.id, root_path: repo.path, display_name: repo.name }))];
      for (const path of notePaths) {
        const content = sourceFiles.find((file) => file.path === path)!.content;
        const stem = basename(path, '.md').toLowerCase();
        const repo = availableRepos.find((item) => item.display_name.toLowerCase() === stem) ?? availableRepos[0];
        if (!repo) continue;
        const key = `notes/${basename(path)}`;
        const hash = digest(content);
        const taskId = stableId(`devpulse-task:${key}:${hash}`);
        const checkpointId = stableId(`devpulse-checkpoint:${key}:${hash}`);
        if (!queue(key, hash, 'checkpoints', checkpointId)) continue;
        if (!dryRun) {
          db.prepare('INSERT OR IGNORE INTO tasks (id, repo_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(taskId, repo.id, `Imported DevPulse note: ${basename(path, '.md')}`, 'complete', now, now);
          const payload = notePayload(basename(path, '.md'), content);
          db.prepare('INSERT OR IGNORE INTO checkpoints (id, task_id, schema_version, working_tree_fingerprint, payload_json, created_at) VALUES (?, ?, 1, ?, ?, ?)')
            .run(checkpointId, taskId, hash, payload, now);
        }
      }
    };
    if (dryRun) apply();
    else db.transaction(apply).immediate();
  } finally { db.close(); }
  return report;
}
