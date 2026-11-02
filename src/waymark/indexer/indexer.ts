import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { orderedFingerprint } from '../core/fingerprint/hasher.js';
import { detectLanguage, extractSymbols } from './symbols.js';
import { chunkText } from './chunker.js';
import { buildSearchText } from './searchText.js';
import { walkRepository, type CandidateFile, type PreviousFile } from './walker.js';

export interface IndexSummary {
  generationId: number; files: number; symbols: number; chunks: number; reusedFiles: number; warnings: number;
}

// Bump when what is stored per file changes (symbol rules, chunking): refreshIndex then rebuilds every repo on its next lookup.
export const INDEX_SCHEMA_VERSION = 6;

export async function indexRepository(
  db: Database.Database, repoId: string, repoRoot: string, options: { force?: boolean } = {},
): Promise<IndexSummary> {
  // An in-memory database cannot be shared with another process, so it needs no cross-process lock.
  if (db.name === ':memory:') return indexRepositoryLocked(db, repoId, repoRoot, options);
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
  try { return await indexRepositoryLocked(db, repoId, repoRoot, options); }
  finally { await removeIf(token); }
}

async function indexRepositoryLocked(
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

  db.prepare('DELETE FROM index_generations WHERE repo_id = ? AND status IN (\'building\', \'failed\') AND id != COALESCE(?, -1)').run(repoId, activeId);
  const generationId = Number(db.prepare('INSERT INTO index_generations (repo_id, fingerprint, status, started_at) VALUES (?, ?, \'building\', ?)').run(repoId, fingerprint, now).lastInsertRowid);
  const insertFile = db.prepare('INSERT INTO files (repo_id, generation_id, path, content_hash, mtime_ms, size_bytes, language, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertSymbol = db.prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)');
  const insertChunk = db.prepare('INSERT INTO chunks (file_id, ordinal, start_line, end_line, content_hash, safe_text, search_text, path_text, symbol_text, token_estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let symbolCount = 0;
  let chunkCount = 0;
  try {
    db.transaction(() => {
      for (const file of candidates) {
        if (!file.unchanged) {
          const stored = storeFile(db, repoId, generationId, file, now);
          symbolCount += stored.symbols;
          chunkCount += stored.chunks;
          continue;
        }
        const language = file.language ?? detectLanguage(file.path);
        const fileId = Number(insertFile.run(repoId, generationId, file.path, file.contentHash, Math.round(file.mtimeMs), file.sizeBytes, language ?? null, now).lastInsertRowid);
        const old = previousByPath.get(file.path)!;
        const symbols = db.prepare('SELECT name, kind, start_line, end_line FROM symbols WHERE file_id = ?').all(old.id) as Array<{ name: string; kind: string; start_line: number; end_line: number }>;
        const chunks = db.prepare('SELECT ordinal, start_line, end_line, content_hash, safe_text, search_text, path_text, symbol_text, token_estimate FROM chunks WHERE file_id = ?').all(old.id) as Array<{ ordinal: number; start_line: number; end_line: number; content_hash: string; safe_text: string; search_text: string; path_text: string; symbol_text: string; token_estimate: number }>;
        for (const symbol of symbols) insertSymbol.run(fileId, symbol.name, symbol.kind, symbol.start_line, symbol.end_line);
        for (const chunk of chunks) insertChunk.run(fileId, chunk.ordinal, chunk.start_line, chunk.end_line, chunk.content_hash, chunk.safe_text, chunk.search_text, chunk.path_text, chunk.symbol_text, chunk.token_estimate);
        symbolCount += symbols.length;
        chunkCount += chunks.length;
      }
      populateReferenceEdges(db, generationId);
      db.prepare('UPDATE index_generations SET status = \'ready\', completed_at = ? WHERE id = ?').run(new Date().toISOString(), generationId);
      db.prepare('INSERT INTO repo_index_state (repo_id, active_generation, schema_version, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(repo_id) DO UPDATE SET active_generation = excluded.active_generation, schema_version = excluded.schema_version, updated_at = excluded.updated_at').run(repoId, generationId, INDEX_SCHEMA_VERSION, new Date().toISOString());
    })();
  } catch (error) {
    db.prepare('DELETE FROM index_generations WHERE id = ?').run(generationId);
    throw error;
  }
  // Each index copies every file row, so keeping superseded generations multiplies the database size (the index is rebuildable; telemetry is untouched).
  try { db.prepare('DELETE FROM index_generations WHERE repo_id = ? AND id != ?').run(repoId, generationId); } catch { /* A busy reader must not fail the index. */ }
  return { generationId, files: candidates.length, symbols: symbolCount, chunks: chunkCount, reusedFiles: candidates.filter(({ unchanged }) => unchanged).length, warnings };
}

/** Parse one changed file and store its row, symbols and chunks in the given generation. */
export function storeFile(db: Database.Database, repoId: string, generationId: number, file: CandidateFile, now: string): { symbols: number; chunks: number } {
  const language = file.language ?? detectLanguage(file.path);
  const fileId = Number(db.prepare('INSERT INTO files (repo_id, generation_id, path, content_hash, mtime_ms, size_bytes, language, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(repoId, generationId, file.path, file.contentHash, Math.round(file.mtimeMs), file.sizeBytes, language ?? null, now).lastInsertRowid);
  const symbols = extractSymbols(file.content, file.path);
  const insertSymbol = db.prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line) VALUES (?, ?, ?, ?, ?)');
  for (const symbol of symbols) insertSymbol.run(fileId, symbol.name, symbol.kind, symbol.startLine, symbol.endLine);
  const chunks = chunkText(file.content, symbols);
  const pathText = buildSearchText(file.path);
  const symbolText = buildSearchText(symbols.map(({ name }) => name).join(' '));
  const insertChunk = db.prepare('INSERT INTO chunks (file_id, ordinal, start_line, end_line, content_hash, safe_text, search_text, path_text, symbol_text, token_estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const chunk of chunks) insertChunk.run(fileId, chunk.ordinal, chunk.startLine, chunk.endLine, chunk.contentHash, chunk.safeText, buildSearchText(chunk.safeText), pathText, symbolText, chunk.tokenEstimate);
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
        for (const targetId of (targets.get(name) ?? []).slice(0, 5)) {
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
