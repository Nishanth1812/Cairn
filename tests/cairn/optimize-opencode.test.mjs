// Synthetic-fixture tests for the OpenCode SQLite reader. No real user data is
// read: every database is built from scratch in a temp directory with fake
// sessions, fake tool output and fake canary strings that must never appear
// in a summary. The TypeScript source is compiled to a private temp build
// directory (never the shared dist/) so these tests run without a build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Must be set before better-sqlite3's addon loads so URI filenames
// (mode=ro&immutable=1) are honoured by the reader under test.
process.env.SQLITE_USE_URI ??= '1';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const Database = (await import('better-sqlite3')).default;

const buildDir = mkdtempSync(join(repoRoot, '.cairn-opencode-build-'));
after(() => rmSync(buildDir, { recursive: true, force: true }));

const tscBin = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const compiled = spawnSync(
  process.execPath,
  [
    tscBin,
    '--ignoreConfig',
    join(repoRoot, 'src', 'cairn', 'optimize', 'opencodeTranscript.ts'),
    '--outDir', buildDir,
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--target', 'ES2022',
    '--esModuleInterop',
    '--skipLibCheck',
    // Emit-only compile: full type-checking is the repo's `typecheck` job.
    '--noCheck',
    '--declaration', 'false',
    '--sourceMap', 'false',
  ],
  { cwd: repoRoot, encoding: 'utf8' },
);
assert.equal(compiled.status, 0, `tsc failed:\n${compiled.stdout}\n${compiled.stderr}`);
const oc = await import(pathToFileURL(join(buildDir, 'optimize', 'opencodeTranscript.js')).href);
const { DataError } = await import(pathToFileURL(join(buildDir, 'optimize', 'errors.js')).href);

const CANARY = 'super-secret-canary-oc-987';
const READ_TEXT = 'first version of fixture app.ts content (fake text, never real)';
const READ_TEXT_CHANGED = 'second version of fixture app.ts content (fake text)';
const RAW_COMMAND = `mytool run --token ${CANARY} secret-arg`;

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function buildV1Database(dir) {
  const dbPath = join(dir, 'opencode.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  const t0 = Date.parse('2026-11-01T10:00:00.000Z');
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?)').run('ses_v1', 'proj1', 'slug', 'C:\\repos\\demo', 'Fixture', '1.0.0', t0, t0 + 60000);
  const msg = (id, offset, data) =>
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id, 'ses_v1', t0 + offset, t0 + offset, JSON.stringify(data));
  msg('msg_user', 0, { role: 'user', time: { created: t0 } });
  msg('msg_asst', 1000, {
    role: 'assistant',
    providerID: 'test-provider',
    modelID: 'test-model',
    tokens: { input: 1200, output: 300, reasoning: 40, cache: { read: 500, write: 100 } },
    time: { created: t0 + 1000 },
  });
  msg('msg_asst2', 2000, { role: 'assistant', providerID: 'test-provider', modelID: 'test-model', time: { created: t0 + 2000 } }); // no tokens: usage stays provider-reported only
  const part = (id, messageId, offset, data) =>
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(id, messageId, 'ses_v1', t0 + offset, t0 + offset, typeof data === 'string' ? data : JSON.stringify(data));
  const tool = (id, messageId, offset, toolName, input, output) =>
    part(id, messageId, offset, { type: 'tool', callID: id, tool: toolName, state: { status: 'completed', input, output, title: toolName, metadata: {}, time: { start: t0 + offset, end: t0 + offset + 1 } } });
  tool('prt_r1', 'msg_asst', 1100, 'read', { filePath: 'C:\\repos\\demo\\src\\app.ts' }, READ_TEXT);
  tool('prt_r2', 'msg_asst', 1200, 'read', { filePath: 'C:\\REPOS\\DEMO\\SRC\\APP.TS' }, READ_TEXT);
  tool('prt_r3', 'msg_asst', 1300, 'read', { filePath: 'C:\\repos\\demo\\src\\app.ts' }, READ_TEXT_CHANGED);
  tool('prt_g1', 'msg_asst', 1400, 'grep', { pattern: 'needleGoal', path: 'C:\\repos\\demo', include: '*.ts' }, 'match');
  tool('prt_g2', 'msg_asst', 1500, 'grep', { pattern: 'needleGoal', path: 'C:\\repos\\demo', include: '*.ts' }, 'match again');
  tool('prt_b1', 'msg_asst', 1600, 'bash', { command: RAW_COMMAND }, 'x'.repeat(25000));
  part('prt_err', 'msg_asst', 1700, { type: 'tool', callID: 'prt_err', tool: 'read', state: { status: 'error', input: { filePath: 'C:\\repos\\demo\\src\\app.ts' }, error: 'fixture error', time: { start: t0 + 1700, end: t0 + 1701 } } });
  part('prt_text', 'msg_asst', 1800, { type: 'text', text: 'fixture assistant text (never printed)' });
  // Step-finish tokens must NOT be added on top of message tokens.
  part('prt_step', 'msg_asst', 1900, { type: 'step-finish', reason: 'stop', cost: 0.01, tokens: { input: 9999, output: 9999, reasoning: 0, cache: { read: 0, write: 0 } } });
  part('prt_bad', 'msg_asst', 1950, 'not json at all');
  db.close();
  return dbPath;
}

function buildV2Database(dir) {
  const dbPath = join(dir, 'opencode.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE session_part (message_id TEXT NOT NULL, session_id TEXT NOT NULL, ordinal INTEGER NOT NULL, type TEXT NOT NULL, call_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (message_id, ordinal));
  `);
  const t0 = Date.parse('2026-11-02T09:00:00.000Z');
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?)').run('ses_v2', 'proj2', 'slug', '/work/demo', 'Fixture', '2.0.0', t0, t0 + 60000);
  const smsg = (id, type, seq, offset, data) =>
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(id, 'ses_v2', type, seq, t0 + offset, t0 + offset, JSON.stringify(data));
  smsg('msg_v2_user', 'user', 1, 0, { type: 'user', text: 'fixture prompt', files: [], agents: [], skills: [], time: { created: t0 } });
  smsg('msg_v2_asst', 'assistant', 2, 1000, {
    type: 'assistant',
    agent: 'build',
    model: { id: 'v2-model', providerID: 'v2-provider' },
    tokens: { input: 800, output: 200, reasoning: 10, cache: { read: 0, write: 50 } },
    time: { created: t0 + 1000 },
  });
  // Compaction tokens are not assistant usage and must be excluded.
  smsg('msg_v2_compact', 'compaction', 3, 2000, { type: 'compaction', status: 'completed', reason: 'auto', summary: 'fixture summary', tokens: { input: 5000, output: 5000, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: t0 + 2000 } });
  const spart = (ordinal, data) =>
    db.prepare('INSERT INTO session_part VALUES (?,?,?,?,?,?,?,?)').run('msg_v2_asst', 'ses_v2', ordinal, data.type, 'call1', t0 + 1000 + ordinal, t0 + 1000 + ordinal, JSON.stringify(data));
  spart(0, { type: 'tool', id: 'call1', name: 'read', state: { status: 'completed', input: { path: 'src/app.ts' }, content: [{ type: 'text', text: READ_TEXT }], time: { created: t0 + 1000 } } });
  spart(1, { type: 'tool', id: 'call2', name: 'read', state: { status: 'completed', input: { path: 'src/app.ts' }, content: [{ type: 'text', text: READ_TEXT }], time: { created: t0 + 1001 } } });
  spart(2, { type: 'tool', id: 'call3', name: 'grep', state: { status: 'completed', input: { pattern: 'needleGoal', path: 'src' }, content: [{ type: 'text', text: 'match' }], time: { created: t0 + 1002 } } });
  spart(3, { type: 'tool', id: 'call4', name: 'grep', state: { status: 'completed', input: { pattern: 'needleGoal', path: 'src' }, content: [{ type: 'text', text: 'match' }], time: { created: t0 + 1003 } } });
  spart(4, { type: 'tool', id: 'call5', name: 'shell', state: { status: 'completed', input: { command: RAW_COMMAND }, content: [{ type: 'text', text: 'y'.repeat(21000) }], time: { created: t0 + 1004 } } });
  spart(5, { type: 'text', text: 'fixture v2 text (never printed)' });
  db.close();
  return dbPath;
}

test('data root and database path respect XDG and OPENCODE_DB', () => {
  assert.equal(oc.opencodeDataRoot({ home: '/home/fixture', env: {} }), join('/home/fixture', '.local', 'share', 'opencode'));
  assert.equal(oc.opencodeDataRoot({ home: '/home/fixture', env: { XDG_DATA_HOME: '/srv/data' } }), join('/srv/data', 'opencode'));
  assert.equal(oc.opencodeDatabasePath({ home: '/home/fixture', env: {} }), join('/home/fixture', '.local', 'share', 'opencode', 'opencode.db'));
  assert.equal(oc.opencodeDatabasePath({ home: '/home/fixture', env: { OPENCODE_DB: '/tmp/custom.db' } }), '/tmp/custom.db');
  assert.equal(oc.opencodeDatabasePath({ home: '/home/fixture', env: { OPENCODE_DB: 'custom.db' } }), join('/home/fixture', '.local', 'share', 'opencode', 'custom.db'));
  assert.equal(oc.opencodeDatabasePath({ home: '/home/fixture', env: { OPENCODE_DB: ':memory:' } }), ':memory:');
});

test('v1 database: usage, repeated reads/searches, large outputs, no raw content, no sidecars', async () => {
  const dir = tempDir('cairn-oc-v1-');
  const dbPath = buildV1Database(dir);
  const listingBefore = readdirSync(dir).sort();
  const statBefore = statSync(dbPath);
  try {
    const summary = await oc.readOpenCodeDatabase(dbPath);
    assert.equal(summary.schema, 'v1');
    assert.equal(summary.bounds.sessionsListed, 1);
    assert.equal(summary.bounds.sessionsScanned, 1);
    assert.equal(summary.bounds.malformedRows, 1);
    const session = summary.sessions[0];
    assert.equal(session.sessionId, 'ses_v1');
    assert.equal(session.project, 'C:\\repos\\demo');
    assert.deepEqual(session.usage, { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 500, cacheCreationTokens: 100, reasoningTokens: 40 });
    assert.deepEqual(session.usageByModel['test-provider/test-model'], session.usage);
    assert.equal(session.toolCalls, 7); // 3 reads + 2 greps + 1 bash + 1 errored read
    const read = session.reads.find((row) => row.path.endsWith('app.ts'));
    assert.equal(read.reads, 3);
    assert.equal(read.identicalRepeats, 1);
    assert.equal(read.versions, 2);
    assert.equal(session.searches.length, 1);
    assert.equal(session.searches[0].pattern, 'needleGoal');
    assert.equal(session.searches[0].calls, 2);
    assert.equal(session.largeOutputCount, 1);
    assert.equal(session.largeOutputChars, 25000);
    assert.equal(session.largeOutputs[0].tool, 'bash');
    assert.equal(session.largeOutputs[0].target, 'mytool'); // executable only, never the raw command
    // Privacy: fixture content, canary and raw command never appear in the summary.
    const serialized = JSON.stringify(summary);
    for (const leak of [READ_TEXT, READ_TEXT_CHANGED, CANARY, RAW_COMMAND, 'fixture assistant text']) {
      assert.ok(!serialized.includes(leak), `summary must not contain ${leak}`);
    }
    // Read-only: no database/journal/WAL/SHM file created, source file untouched.
    assert.deepEqual(readdirSync(dir).sort(), listingBefore);
    const statAfter = statSync(dbPath);
    assert.equal(statAfter.size, statBefore.size);
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
    assert.ok(!existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`) && !existsSync(`${dbPath}-journal`));

    const listed = await oc.listOpenCodeSessions(dbPath);
    assert.deepEqual(listed.map((row) => row.sessionId), ['ses_v1']);
    const single = await oc.readOpenCodeSession(dbPath, 'ses_v1');
    assert.equal(single.toolCalls, session.toolCalls);
    const viaClass = await new oc.OpenCodeTranscript(dbPath, 'ses_v1', session.project, session.bytes, 'v1').read();
    assert.equal(viaClass.sessionId, 'ses_v1');
    await assert.rejects(() => oc.readOpenCodeSession(dbPath, 'ses_missing'), DataError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v2 database: session_part tools, compaction excluded, shell command never raw', async () => {
  const dir = tempDir('cairn-oc-v2-');
  const dbPath = buildV2Database(dir);
  try {
    const summary = await oc.readOpenCodeDatabase(dbPath);
    assert.equal(summary.schema, 'v2');
    const session = summary.sessions[0];
    assert.deepEqual(session.usage, { inputTokens: 800, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 50, reasoningTokens: 10 });
    assert.ok(session.usageByModel['v2-provider/v2-model']);
    assert.equal(session.toolCalls, 5);
    assert.equal(session.reads.length, 1);
    assert.equal(session.reads[0].reads, 2);
    assert.equal(session.reads[0].identicalRepeats, 1);
    assert.equal(session.searches[0].calls, 2);
    assert.equal(session.largeOutputCount, 1);
    assert.equal(session.largeOutputs[0].tool, 'shell');
    assert.equal(session.largeOutputs[0].target, 'mytool');
    const serialized = JSON.stringify(summary);
    for (const leak of [READ_TEXT, CANARY, RAW_COMMAND, 'fixture v2 text', 'fixture prompt']) {
      assert.ok(!serialized.includes(leak), `summary must not contain ${leak}`);
    }
    assert.match(summary.limitations.join('\n'), /never converts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live WAL: a private snapshot copy is audited and the source is not mutated', async () => {
  const dir = tempDir('cairn-oc-live-wal-');
  const dbPath = join(dir, 'opencode.db');
  // Checkpointed schema and rows in the main file, then a live writer whose
  // newer rows exist only in the WAL.
  const setup = new Database(dbPath);
  setup.pragma('journal_mode = WAL');
  setup.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);');
  setup.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?)').run('checkpt', 'p', '/Work/Case', 1, 2);
  setup.close();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?)').run('walonly', 'p', '/Work/Case', 3, 4);
  // Keep the writer open so committed rows remain in the live WAL.
  const assertSourceIntact = (before) => {
    assert.deepEqual(readdirSync(dir).sort(), before.files);
    assert.equal(statSync(dbPath).mtimeMs, before.mtime);
    assert.equal(statSync(dbPath).size, before.size);
    assert.deepEqual(readFileSync(dbPath), before.content);
    assert.ok(existsSync(`${dbPath}-wal`));
    assert.ok(existsSync(`${dbPath}-shm`));
    assert.deepEqual([statSync(`${dbPath}-wal`).size, statSync(`${dbPath}-wal`).mtimeMs], [before.wal.size, before.wal.mtimeMs]);
    assert.deepEqual([statSync(`${dbPath}-shm`).size, statSync(`${dbPath}-shm`).mtimeMs], [before.shm.size, before.shm.mtimeMs]);
    assert.deepEqual(readFileSync(`${dbPath}-wal`), before.wal.content);
    assert.deepEqual(readFileSync(`${dbPath}-shm`), before.shm.content);
  };
  try {
    assert.ok(existsSync(`${dbPath}-wal`));
    const before = {
      files: readdirSync(dir).sort(),
      mtime: statSync(dbPath).mtimeMs,
      size: statSync(dbPath).size,
      content: readFileSync(dbPath),
      wal: { size: statSync(`${dbPath}-wal`).size, mtimeMs: statSync(`${dbPath}-wal`).mtimeMs, content: readFileSync(`${dbPath}-wal`) },
      shm: { size: statSync(`${dbPath}-shm`).size, mtimeMs: statSync(`${dbPath}-shm`).mtimeMs, content: readFileSync(`${dbPath}-shm`) },
    };
    const summary = await oc.readOpenCodeDatabase(dbPath, { project: '/Work/Case' });
    // The snapshot sees the checkpointed session; the WAL-only session is
    // invisible, never wrong.
    assert.deepEqual(summary.sessions.map((session) => session.sessionId), ['checkpt']);
    assert.match(summary.limitations.join('\n'), /snapshot/);
    assertSourceIntact(before);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transient sidecar files alongside a valid database do not block the audit and are not modified', async () => {
  const dir = tempDir('cairn-oc-transient-');
  const dbPath = buildV1Database(dir);
  // Simulate a live sidecar pair left by a running process.
  writeFileSync(`${dbPath}-wal`, 'transient wal placeholder bytes', 'utf8');
  writeFileSync(`${dbPath}-shm`, 'transient shm placeholder bytes', 'utf8');
  try {
    const before = {
      files: readdirSync(dir).sort(),
      mtime: statSync(dbPath).mtimeMs,
      size: statSync(dbPath).size,
      content: readFileSync(dbPath),
      wal: { size: statSync(`${dbPath}-wal`).size, mtimeMs: statSync(`${dbPath}-wal`).mtimeMs, content: readFileSync(`${dbPath}-wal`) },
      shm: { size: statSync(`${dbPath}-shm`).size, mtimeMs: statSync(`${dbPath}-shm`).mtimeMs, content: readFileSync(`${dbPath}-shm`) },
    };
    const summary = await oc.readOpenCodeDatabase(dbPath);
    assert.equal(summary.schema, 'v1');
    assert.deepEqual(summary.sessions.map((session) => session.sessionId), ['ses_v1']);
    assert.equal(summary.sessions[0].toolCalls, 7);
    // Source untouched: same listing, same sizes/mtimes/contents, same sidecars.
    assert.deepEqual(readdirSync(dir).sort(), before.files);
    assert.equal(statSync(dbPath).mtimeMs, before.mtime);
    assert.equal(statSync(dbPath).size, before.size);
    assert.deepEqual(readFileSync(dbPath), before.content);
    assert.deepEqual(readFileSync(`${dbPath}-wal`), before.wal.content);
    assert.deepEqual(readFileSync(`${dbPath}-shm`), before.shm.content);
    assert.equal(statSync(`${dbPath}-wal`).mtimeMs, before.wal.mtimeMs);
    assert.equal(statSync(`${dbPath}-shm`).mtimeMs, before.shm.mtimeMs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a database that cannot be opened alongside a sidecar still fails honestly as DataError', async () => {
  const dir = tempDir('cairn-oc-snap-fail-');
  const dbPath = join(dir, 'opencode.db');
  writeFileSync(dbPath, 'this is not sqlite', 'utf8');
  writeFileSync(`${dbPath}-wal`, 'transient wal placeholder bytes', 'utf8');
  const before = readdirSync(dir).sort();
  try {
    await assert.rejects(() => oc.readOpenCodeDatabase(dbPath), DataError);
    // Honest failure: no snapshot or database file was left behind.
    assert.deepEqual(readdirSync(dir).sort(), before);
    assert.equal(readFileSync(dbPath, 'utf8'), 'this is not sqlite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project and session limits select recent matching rows before session reads', async () => {
  const dir = tempDir('cairn-oc-filter-');
  const dbPath = buildV2Database(dir);
  const db = new Database(dbPath);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?)').run('ses_v2_new', 'proj2', 'slug', '/work/demo', 'Fixture', '2.0.0', Date.parse('2026-11-03T10:00:00Z'), Date.parse('2026-11-03T10:01:00Z'));
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?)').run('ses_v2_other', 'proj2', 'slug', '/Work/demo', 'Fixture', '2.0.0', Date.parse('2026-11-04T10:00:00Z'), Date.parse('2026-11-04T10:01:00Z'));
  db.close();
  try {
    const summary = await oc.readOpenCodeDatabase(dbPath, { project: '/work/demo', maxSessions: 1 });
    assert.deepEqual(summary.sessions.map((session) => session.sessionId), ['ses_v2_new']);
    assert.equal(summary.bounds.projectsListed, 2);
    assert.equal(summary.bounds.sessionsListed, 2);
    assert.equal(summary.bounds.sessionsScanned, 1);
    assert.equal(summary.bounds.sessionsSkipped, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrated v1+v2 schemas count a session once and use v2 rows once', async () => {
  const dir = tempDir('cairn-oc-migrated-');
  const dbPath = buildV1Database(dir);
  const db = new Database(dbPath);
  db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);');
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?)').run('ses_v1', 'proj1', 'C:\\repos\\demo', 100, 200);
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?)').run('v2_m', 'ses_v1', 'assistant', 1, 100, JSON.stringify({ type: 'assistant', model: { id: 'm2', providerID: 'p2' }, tokens: { input: 7, output: 3, cache: { read: 0, write: 0 } } }));
  db.close();
  try {
    const summary = await oc.readOpenCodeDatabase(dbPath);
    assert.equal(summary.schema, 'v1+v2');
    assert.equal(summary.bounds.sessionsListed, 1);
    assert.equal(summary.bounds.sessionsScanned, 1);
    assert.equal(summary.sessions[0].messages, 1);
    assert.deepEqual(summary.sessions[0].usage, { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('search identity includes include filter', async () => {
  const dir = tempDir('cairn-oc-includes-');
  const dbPath = buildV1Database(dir);
  const db = new Database(dbPath);
  try {
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_g3', 'msg_asst', 'ses_v1', 9999, 9999, JSON.stringify({ type: 'tool', tool: 'grep', state: { status: 'completed', input: { pattern: 'needleGoal', path: 'C:\\repos\\demo', include: '*.js' }, output: 'match' } }));
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('prt_g4', 'msg_asst', 'ses_v1', 10000, 10000, JSON.stringify({ type: 'tool', tool: 'grep', state: { status: 'completed', input: { pattern: 'needleGoal', path: 'C:\\repos\\demo', include: '*.js' }, output: 'match' } }));
    db.close();
    const summary = await oc.readOpenCodeDatabase(dbPath);
    assert.equal(summary.sessions[0].searches.length, 2);
    assert.deepEqual(summary.sessions[0].searches.map((search) => search.include).sort(), ['*.js', '*.ts']);
  } finally {
    try { db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing, incompatible, non-sqlite and :memory: databases fail honestly as DataError', async () => {
  const dir = tempDir('cairn-oc-bad-');
  try {
    await assert.rejects(() => oc.readOpenCodeDatabase(join(dir, 'opencode.db')), /No OpenCode database found/);
    await assert.rejects(() => oc.readOpenCodeDatabase(':memory:'), DataError);
    // Empty database: no recognised schema.
    const emptyPath = join(dir, 'empty.db');
    new Database(emptyPath).close();
    await assert.rejects(() => oc.readOpenCodeDatabase(emptyPath), /no recognised session schema/);
    // Incompatible v1 shape: session table missing the directory column.
    const badPath = join(dir, 'bad.db');
    const bad = new Database(badPath);
    bad.exec('CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL);');
    bad.close();
    await assert.rejects(() => oc.readOpenCodeDatabase(badPath), /incompatible/);
    // Not a database at all.
    const textPath = join(dir, 'text.db');
    writeFileSync(textPath, 'this is not sqlite', 'utf8');
    await assert.rejects(() => oc.readOpenCodeDatabase(textPath), DataError);
    // Sessions with no provider usage report usage as unknown (null), never zero.
    const noUsageDir = tempDir('cairn-oc-nousage-');
    try {
      const dbPath = join(noUsageDir, 'opencode.db');
      const db = new Database(dbPath);
      db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);');
      db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('ses_nousage', 'p', '/work/x', 1, 2);
      db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 'ses_nousage', 1, JSON.stringify({ role: 'assistant', providerID: 'p', modelID: 'm' }));
      db.close();
      const summary = await oc.readOpenCodeDatabase(dbPath);
      assert.equal(summary.sessions[0].usage, null);
    } finally {
      rmSync(noUsageDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
