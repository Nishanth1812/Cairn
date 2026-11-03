import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { orderedFingerprint } from '../core/fingerprint/hasher.js';
import { freeSpaceBytes, isStorageError, storageFailure } from '../storage/storageErrors.js';
import { detectLanguage, extractSymbols } from './symbols.js';
import { chunkText } from './chunker.js';
import { buildSearchExtra, buildSearchText } from './searchText.js';
import { walkRepository, type CandidateFile, type PreviousFile } from './walker.js';

export interface IndexSummary {
  generationId: number; files: number; symbols: number; chunks: number; reusedFiles: number; warnings: number;
}

type StoreStatements = { file: Database.Statement; symbol: Database.Statement; chunk: Database.Statement; meta: Database.Statement };

// Bump when what is stored per file changes (symbol rules, chunking): refreshIndex then rebuilds every repo on its next lookup.
export const INDEX_SCHEMA_VERSION = 7;

export async function indexRepository(
  db: Database.Database, repoId: string, repoRoot: string, options: { force?: boolean } = {},
): Promise<IndexSummary> {
  return withIndexLock(db, repoId, () => indexRepositoryLocked(db, repoId, repoRoot, options));
}

/** Serialize all writes to a repository's active index across processes. */
export async function withIndexLock<T>(db: Database.Database, repoId: string, action: () => Promise<T> | T): Promise<T> {
  // An in-memory database cannot be shared with another process, so it needs no cross-process lock.
  if (db.name === ':memory:') return action();
  const lockPath = `${db.name}.${createHash('sha1').update(repoId).digest('hex')}.index.lock`;
  const started = Date.now();
  const token = randomUUID();
  const read = async () => { try { return JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number; at?: number; token?: string }; } catch { return undefined; } };
  // Remove a lock only while it still holds the content we judged stale, so a lock another process just created survives.
  const removeIf = async (expected: string | undefined) => { if ((await read())?.token === expected) await rm(lockPath, { force: true }); };
  let acquired = false;
  while (!acquired) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { flag: 'wx' });
      acquired = true;
    } catch (error) {
      if (isStorageError(error)) { await rm(lockPath, { force: true }).catch(() => undefined); throw storageFailure(dirname(db.name), error, 64 * 1024 * 1024); }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lock = await read();
      if (!lock) { // Unreadable: either still being written or damaged. Only a damaged one older than 5 s is removed.
        const age = await stat(lockPath).then(info => Date.now() - info.mtimeMs, () => 0);
        if (age > 5_000) await rm(lockPath, { force: true });
      } else {
        let alive = false;
        if (Number.isInteger(lock.pid)) { try { process.kill(lock.pid!, 0); alive = true; } catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM'; } }
        // shortcut: a live holder is only taken over after 60 minutes (pid reuse), no heartbeat; add one if builds ever approach that.
        if (!alive || Date.now() - (lock.at ?? 0) > 60 * 60_000) { await removeIf(lock.token); continue; }
      }
      if (Date.now() - started > 30_000) throw new Error('Index already running for this repository; retry shortly.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return await action(); }
  catch (error) { if (isStorageError(error)) throw storageFailure(dirname(db.name), error, 64 * 1024 * 1024); throw error; }
  finally { await removeIf(token); }
}

export async function indexRepositoryLocked(
  db: Database.Database, repoId: string, repoRoot: string, options: { force?: boolean },
): Promise<IndexSummary> {
  const now = new Date().toISOString();
  const state = db.prepare('SELECT active_generation, schema_version FROM repo_index_state WHERE repo_id = ?').get(repoId) as { active_generation: number | null; schema_version: number } | undefined;
  const activeId = state?.active_generation ?? null;
  const previousRows = activeId === null ? [] : db.prepare('SELECT id, path, content_hash, mtime_ms, size_bytes FROM files WHERE generation_id = ?').all(activeId) as Array<{ id: number; path: string; content_hash: string; mtime_ms: number; size_bytes: number }>;
  const previousByPath = new Map(previousRows.map((file) => [file.path, file]));
  const previous = new Map<string, PreviousFile>(previousRows.map((file) => [file.path, { mtimeMs: file.mtime_ms, sizeBytes: file.size_bytes, hash: file.content_hash }]));
  let warnings = 0;
  const candidates = await walkRepository(repoRoot, options.force || state?.schema_version !== INDEX_SCHEMA_VERSION ? new Map() : previous, () => { warnings++; });
  const fingerprintParts = candidates.flatMap(({ path, contentHash }) => [path, contentHash]);
  const rebuildSchema = state !== undefined && state.schema_version !== INDEX_SCHEMA_VERSION;
  const fingerprint = orderedFingerprint(options.force || rebuildSchema ? [...fingerprintParts, `index-schema:${INDEX_SCHEMA_VERSION}`, randomUUID()] : [...fingerprintParts, `index-schema:${INDEX_SCHEMA_VERSION}`]);
  if (!options.force && state?.schema_version === INDEX_SCHEMA_VERSION && activeId !== null) {
    const current = db.prepare('SELECT fingerprint FROM index_generations WHERE id = ?').get(activeId) as { fingerprint: string } | undefined;
    if (current?.fingerprint === fingerprint) {
      // Refresh compares directory mtimes against completed_at; stamping it here stops a no-change index from looking stale forever.
      db.prepare('UPDATE index_generations SET completed_at = ? WHERE id = ?').run(new Date().toISOString(), activeId);
      const counts = db.prepare('SELECT (SELECT COUNT(*) FROM files WHERE generation_id = ?) files, (SELECT COUNT(*) FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.generation_id = ?) symbols, (SELECT COUNT(*) FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.generation_id = ?) chunks').get(activeId, activeId, activeId) as { files: number; symbols: number; chunks: number };
      return { generationId: activeId, ...counts, reusedFiles: candidates.length, warnings };
    }
  }

  const candidateBytes = candidates.reduce((sum, file) => sum + file.sizeBytes, 0);
  const previousBytes = activeId === null ? 0 : (db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM files WHERE generation_id = ?').get(activeId) as { bytes: number }).bytes;
  const chunkColumns = new Set((db.pragma('table_info(chunks)') as Array<{ name: string }>).map(({ name }) => name));
  const storedTextColumns = ['safe_text', 'search_text', 'path_text', 'symbol_text'].filter((column) => chunkColumns.has(column));
  const textBytes = activeId === null ? 0 : (db.prepare(`SELECT COALESCE(SUM(${storedTextColumns.map((column) => `length(${column})`).join(' + ')}), 0) AS bytes FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.generation_id = ?`).get(activeId) as { bytes: number }).bytes;
  const observedRatio = previousBytes ? Math.max(6, textBytes / previousBytes) : 10;
  const estimatedBytes = Math.max(64 * 1024 * 1024, Math.ceil(candidateBytes * observedRatio + candidates.length * 32 * 1024));
  if (db.name !== ':memory:') {
    const stateDir = dirname(db.name), availableBytes = freeSpaceBytes(stateDir);
    if (availableBytes < estimatedBytes) throw storageFailure(stateDir, new Error('estimated index space exceeds available disk space'), estimatedBytes, availableBytes);
  }

  const insertFile = db.prepare('INSERT INTO files (repo_id, generation_id, path, content_hash, mtime_ms, size_bytes, language, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertSymbol = db.prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)');
  const insertChunk = db.prepare('INSERT INTO chunks (file_id, ordinal, start_line, end_line, content_hash, safe_text, search_extra, token_estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertFileMeta = db.prepare('INSERT INTO file_search_meta(file_id, path_text, symbol_text) VALUES (?, ?, ?)');
  const storeStatements = { file: insertFile, symbol: insertSymbol, chunk: insertChunk, meta: insertFileMeta };
  const selectSymbols = db.prepare('SELECT name, kind, start_line, end_line FROM symbols WHERE file_id = ?');
  const selectChunks = db.prepare('SELECT ordinal, start_line, end_line, content_hash, safe_text, search_extra, token_estimate FROM chunks WHERE file_id = ?');
  const selectFileMeta = db.prepare('SELECT path_text, symbol_text FROM file_search_meta WHERE file_id = ?');
  const chunkInsertTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'chunks_ai'").get() as { sql: string } | undefined;
  let symbolCount = 0;
  let chunkCount = 0;
  let generationId = -1;
  try {
    generationId = db.transaction(() => {
      db.prepare('DELETE FROM index_generations WHERE repo_id = ? AND status IN (\'building\', \'failed\') AND id != COALESCE(?, -1)').run(repoId, activeId);
      const buildingId = Number(db.prepare('INSERT INTO index_generations (repo_id, fingerprint, status, started_at) VALUES (?, ?, \'building\', ?)').run(repoId, fingerprint, now).lastInsertRowid);
      if (chunkInsertTrigger) db.exec('DROP TRIGGER chunks_ai');
      for (const file of candidates) {
        if (!file.unchanged) {
          const stored = storeFile(db, repoId, buildingId, file, now, storeStatements);
          symbolCount += stored.symbols;
          chunkCount += stored.chunks;
          continue;
        }
        const language = file.language ?? detectLanguage(file.path);
        const fileId = Number(insertFile.run(repoId, buildingId, file.path, file.contentHash, Math.round(file.mtimeMs), file.sizeBytes, language ?? null, now).lastInsertRowid);
        const old = previousByPath.get(file.path)!;
        const symbols = selectSymbols.all(old.id) as Array<{ name: string; kind: string; start_line: number; end_line: number }>;
        const chunks = selectChunks.all(old.id) as Array<{ ordinal: number; start_line: number; end_line: number; content_hash: string; safe_text: string; search_extra: string; token_estimate: number }>;
        for (const symbol of symbols) insertSymbol.run(fileId, symbol.name, symbol.kind, symbol.start_line, symbol.end_line);
        const meta = selectFileMeta.get(old.id) as { path_text: string; symbol_text: string };
        insertFileMeta.run(fileId, meta.path_text, meta.symbol_text);
        for (const chunk of chunks) {
          insertChunk.run(fileId, chunk.ordinal, chunk.start_line, chunk.end_line, chunk.content_hash, chunk.safe_text, chunk.search_extra, chunk.token_estimate);
        }
        symbolCount += symbols.length;
        chunkCount += chunks.length;
      }
      db.prepare("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')").run();
      if (chunkInsertTrigger) db.exec(chunkInsertTrigger.sql);
      populateReferenceEdges(db, buildingId);
      db.prepare('UPDATE index_generations SET status = \'ready\', completed_at = ? WHERE id = ?').run(new Date().toISOString(), buildingId);
      db.prepare('INSERT INTO repo_index_state (repo_id, active_generation, schema_version, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(repo_id) DO UPDATE SET active_generation = excluded.active_generation, schema_version = excluded.schema_version, updated_at = excluded.updated_at').run(repoId, buildingId, INDEX_SCHEMA_VERSION, new Date().toISOString());
      db.prepare('DELETE FROM index_generations WHERE repo_id = ? AND id != ?').run(repoId, buildingId);
      return buildingId;
    }).immediate();
  } catch (error) {
    if (isStorageError(error)) throw storageFailure(dirname(db.name), error, estimatedBytes);
    throw error;
  }
  // A checkpoint can fail after the index is committed; the next build can retry it.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); }
  catch { /* A later build retries the checkpoint. */ }
  return { generationId, files: candidates.length, symbols: symbolCount, chunks: chunkCount, reusedFiles: candidates.filter(({ unchanged }) => unchanged).length, warnings };
}

/** Parse one changed file and store its row, symbols and chunks in the given generation. */
export function storeFile(db: Database.Database, repoId: string, generationId: number, file: CandidateFile, now: string, prepared?: StoreStatements): { symbols: number; chunks: number } {
  const statements = prepared ?? {
    file: db.prepare('INSERT INTO files (repo_id, generation_id, path, content_hash, mtime_ms, size_bytes, language, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    symbol: db.prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)'),
    chunk: db.prepare('INSERT INTO chunks (file_id, ordinal, start_line, end_line, content_hash, safe_text, search_extra, token_estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    meta: db.prepare('INSERT INTO file_search_meta(file_id, path_text, symbol_text) VALUES (?, ?, ?)'),
  };
  const language = file.language ?? detectLanguage(file.path);
  const fileId = Number(statements.file.run(repoId, generationId, file.path, file.contentHash, Math.round(file.mtimeMs), file.sizeBytes, language ?? null, now).lastInsertRowid);
  const symbols = extractSymbols(file.content, file.path);
  for (const symbol of symbols) statements.symbol.run(fileId, symbol.name, symbol.kind, symbol.startLine, symbol.endLine);
  const chunks = chunkText(file.content, symbols);
  const pathText = buildSearchText(file.path);
  const symbolText = buildSearchText(symbols.map(({ name }) => name).join(' '));
  statements.meta.run(fileId, pathText, symbolText);
  for (const chunk of chunks) {
    statements.chunk.run(fileId, chunk.ordinal, chunk.startLine, chunk.endLine, chunk.contentHash, chunk.safeText, buildSearchExtra(chunk.safeText), chunk.tokenEstimate);
  }
  return { symbols: symbols.length, chunks: chunks.length };
}


function populateReferenceEdges(db: Database.Database, generationId: number): void {
  const symbols = db.prepare('SELECT s.id, s.file_id AS fileId, s.name, s.start_line AS startLine, s.end_line AS endLine FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.generation_id = ? ORDER BY f.path, s.start_line').all(generationId) as Array<{ id: number; fileId: number; name: string; startLine: number; endLine: number }>;
  const targets = new Map<string, number[]>();
  const byFile = new Map<number, typeof symbols>();
  for (const symbol of symbols) {
    const targetIds = targets.get(symbol.name) ?? [];
    targetIds.push(symbol.id);
    targets.set(symbol.name, targetIds);
    const fileSymbols = byFile.get(symbol.fileId) ?? [];
    fileSymbols.push(symbol);
    byFile.set(symbol.fileId, fileSymbols);
  }
  const chunks = db.prepare('SELECT c.file_id AS fileId, c.start_line AS startLine, c.safe_text AS safeText FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.generation_id = ? ORDER BY f.path, c.start_line').all(generationId) as Array<{ fileId: number; startLine: number; safeText: string }>;
  const insert = db.prepare("INSERT OR IGNORE INTO edges (source_symbol_id, target_symbol_id, target_text, kind, confidence) VALUES (?, ?, ?, 'reference', 1)");
  const counts = new Map<number, Set<number>>();
  for (const chunk of chunks) {
    const owners = byFile.get(chunk.fileId) ?? [];
    const lines = chunk.safeText.split('\n');
    const active: typeof owners = [];
    let nextOwner = 0;
    for (let offset = 0; offset < lines.length; offset++) {
      const line = chunk.startLine + offset;
      while (nextOwner < owners.length && owners[nextOwner]!.startLine <= line) active.push(owners[nextOwner++]!);
      for (let i = active.length - 1; i >= 0; i--) if (active[i]!.endLine < line) active.splice(i, 1);
      const source = active.reduce<(typeof owners)[number] | undefined>((best, symbol) => !best || symbol.endLine - symbol.startLine < best.endLine - best.startLine ? symbol : best, undefined);
      if (!source || (counts.get(source.id)?.size ?? 0) >= 100) continue;
      for (const [name] of lines[offset]!.matchAll(/[A-Za-z_$][\w$]*/g)) {
        const matches = targets.get(name) ?? [];
        for (let target = 0; target < Math.min(5, matches.length); target++) {
          const targetId = matches[target]!;
          if (targetId === source.id) continue;
          let seen = counts.get(source.id);
          if (!seen) counts.set(source.id, seen = new Set());
          if (seen.size >= 100 || seen.has(targetId)) continue;
          seen.add(targetId);
          insert.run(source.id, targetId, name);
        }
      }
    }
  }
}
