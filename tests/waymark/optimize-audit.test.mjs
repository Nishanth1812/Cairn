import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const bin = resolve('bin/cairn.mjs');
const optimize = (args, home) => spawnSync(process.execPath, [bin, 'optimize', ...args], {
  encoding: 'utf8',
  env: { ...process.env, HOME: home ?? process.env.HOME, USERPROFILE: home ?? process.env.USERPROFILE },
});

const CANARY = 'super-secret-canary-987';
const APP_READ_TEXT = 'first version of app.ts content (fixture text, never a real file)';
const APP_READ_TEXT_CHANGED = 'second version of app.ts content (fixture text)';

const use = (id, tool, input) => ({ type: 'tool_use', id, name: tool, input });
const result = (id, text, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...extra });
const assistant = (timestamp, model, usage, tools) => ({ type: 'assistant', timestamp, message: { model, ...(usage ? { usage } : {}), content: tools ?? [] } });
const userLine = (timestamp, content) => ({ type: 'user', timestamp, message: { content } });

const USAGE_A = { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 100, cache_read_input_tokens: 500 };
const sessionALines = [
  JSON.stringify({ type: 'summary', summary: 'fixture summary line' }),
  JSON.stringify(assistant('2026-11-01T10:00:00.000Z', 'claude-test-model', USAGE_A, [
    use('u1', 'Read', { file_path: 'C:\\repos\\demo\\src\\app.ts' }),
    use('u2', 'Read', { file_path: 'C:\\REPOS\\DEMO\\SRC\\APP.TS' }), // same file, different casing: one file on Windows
    use('u3', 'Read', { file_path: 'C:\\repos\\demo\\src\\other.ts' }),
    use('u9', 'Grep', { pattern: 'needleGoal', path: 'C:\\repos\\demo' }),
    use('u10', 'Grep', { pattern: 'needleGoal', path: 'C:\\repos\\demo' }),
    use('u11', 'Bash', { command: 'npm test' }),
  ])),
  JSON.stringify(userLine('2026-11-01T10:00:20.000Z', [result('u1', APP_READ_TEXT), result('u2', APP_READ_TEXT), result('u3', 'single read of other.ts'), result('u9', '2 matches, small result'), result('u10', '3 matches, still small')])),
  JSON.stringify(assistant('2026-11-01T10:01:00.000Z', 'claude-test-model', null, [use('u5', 'Read', { file_path: 'C:\\repos\\demo\\src\\app.ts' })])),
  JSON.stringify(userLine('2026-11-01T10:01:30.000Z', [result('u5', APP_READ_TEXT_CHANGED)])), // re-read after a change: not identical
  JSON.stringify(userLine('2026-11-01T10:02:00.000Z', [result('u11', 'x'.repeat(25000))])),
  'not json at all', // malformed line: tolerated and counted
  '{"type":"user","timestamp":"2026-11-0', // truncated final write: no newline, in-flight rotation
].join('\n');

const sessionBLines = [
  JSON.stringify(assistant('2026-11-01T09:59:30.000Z', 'claude-second-model', null, [use('b1', 'Read', { file_path: 'D:\\work\\single\\read.ts' })])),
  JSON.stringify(userLine('2026-11-01T09:59:40.000Z', [result('b1', 'only read in this session')])), // no provider usage at all here
].join('\n');

const sessionCLines = [
  JSON.stringify(assistant('2026-11-01T09:45:00.000Z', 'claude-third-model', null, [
    use('c1', 'Read', { file_path: 'D:\\work\\shared\\read.ts' }),
    use('c9', 'Grep', { pattern: 'needleGoal', path: 'D:\\work' }),
    use('c10', 'Grep', { pattern: 'needleGoal', path: 'D:\\work' }),
  ])),
  JSON.stringify(userLine('2026-11-01T09:45:10.000Z', [result('c1', 'overlapping window with session A'), result('c9', 'match'), result(`c10`, CANARY)])),
].join('\n');

// This host also writes agent transcripts nested under per-session subdirectories; the audit must
// cover them as separate sessions.
const agentLines = [
  JSON.stringify(assistant('2026-11-01T09:46:00.000Z', 'claude-agent-model', { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, [use('g1', 'Read', { file_path: 'D:\\work\\agent\\read.ts' })])),
  JSON.stringify(userLine('2026-11-01T09:46:10.000Z', [result('g1', 'agent transcript content (never printed)')])),
].join('\n');

function writeHome() {
  const home = mkdtempSync(join(tmpdir(), 'cairn-optimize-'));
  const projectA = join(home, '.claude', 'projects', 'H--Personal-Projects-demoA');
  const projectB = join(home, '.claude', 'projects', 'H--Personal-Projects-demoB');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  writeFileSync(join(projectA, 'session-a.jsonl'), sessionALines, 'utf8');
  writeFileSync(join(projectA, 'session-b.jsonl'), sessionBLines, 'utf8');
  writeFileSync(join(projectB, 'session-c.jsonl'), sessionCLines, 'utf8');
  mkdirSync(join(projectB, 'session-c-parent', 'subagents'), { recursive: true });
  writeFileSync(join(projectB, 'session-c-parent', 'subagents', 'agent-1.jsonl'), agentLines, 'utf8');
  mkdirSync(join(home, '.codex', 'sessions'), { recursive: true });
  return home;
}

const files = (home) => [
  join(home, '.claude', 'projects', 'H--Personal-Projects-demoA', 'session-a.jsonl'),
  join(home, '.claude', 'projects', 'H--Personal-Projects-demoA', 'session-b.jsonl'),
  join(home, '.claude', 'projects', 'H--Personal-Projects-demoB', 'session-c.jsonl'),
  join(home, '.claude', 'projects', 'H--Personal-Projects-demoB', 'session-c-parent', 'subagents', 'agent-1.jsonl'),
];
const snapshot = (home) => files(home).map((file) => { const stats = statSync(file); return { size: stats.size, mtimeMs: stats.mtimeMs }; });

test('optimize help exposes coverage and audit; unknown subcommands exit 2', () => {
  const help = optimize(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /cairn optimize audit --consent/);
  assert.match(help.stdout, /coverage/);
  const unknown = optimize(['bogus']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown optimize command "bogus"/);
});

test('coverage matrix lists all three hosts with honest statuses and reads no private data', () => {
  const home = writeHome();
  try {
    const text = optimize(['coverage', '--home', home]);
    assert.equal(text.status, 0);
    assert.match(text.stdout, /Claude Code \(claude-code\) — installed/);
    assert.match(text.stdout, /Codex \(codex\) — installed/);
    assert.match(text.stdout, /OpenCode \(opencode\) — not detected via/);
    assert.match(text.stdout, /audit reader: implemented/);
    assert.match(text.stdout, /limit and quota status\s+unavailable/);
    const json = JSON.parse(optimize(['coverage', '--json', '--home', home]).stdout);
    assert.equal(json.schema_version, 1);
    assert.equal(json.command, 'optimize coverage');
    assert.equal(json.ok, true);
    assert.equal(json.data.hosts.length, 3);
    const hosts = json.data.hosts;
    assert.equal(hosts[0].id, 'claude-code');
    assert.equal(hosts[0].reader, 'implemented');
    assert.deepEqual(hosts.slice(1).map((host) => host.reader), ['not implemented', 'not implemented']);
    for (const host of hosts) {
      assert.equal(host.categories['limit and quota status'].coverage, 'unavailable', `${host.id} must not claim quota observability`);
    }
    const codex = hosts.find((host) => host.id === 'codex');
    assert.equal(codex.categories['re-read identity'].coverage, 'unavailable');
    assert.match(hosts[0].categories.sessions.detail, /not a documented stable API/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('audit requires consent and reads nothing before it', () => {
  const home = writeHome();
  try {
    const refused = optimize(['audit', '--home', home]);
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, /requires consent/);
    assert.match(refused.stderr, /--consent/);
    assert.equal(refused.stdout, '');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('audit reports observed opportunities with evidence, keeps estimates separate, prints no content', () => {
  const home = writeHome();
  const before = snapshot(home);
  try {
    const run = optimize(['audit', '--consent', '--json', '--home', home]);
    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout);
    assert.equal(output.command, 'optimize audit');
    const report = output.data;

    assert.equal(report.host, 'claude-code');
    assert.equal(report.bounds.projectsScanned, 2);
    assert.equal(report.bounds.sessionsScanned, 4); // includes the nested agent transcript
    assert.equal(report.bounds.malformedLines, 2); // the malformed line plus the truncated write
    assert.equal(report.overhead.elapsedMs >= 0, true);

    assert.equal(report.usage.sessionsWithProviderUsage, 2);
    assert.equal(report.usage.sessionsWithoutProviderUsage, 2);
    assert.ok(report.usage.estimatedTokensWithoutUsage > 0);
    assert.deepStrictEqual(report.usage.byModel['claude-test-model'], { sessions: 1, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 500, cacheCreationTokens: 100 });
    assert.match(report.usage.notes.join('\n'), /summed per model/);

    const read = report.opportunities.repeatedReads.find((row) => row.path.endsWith('app.ts'));
    assert.equal(read.session, 'session-a');
    assert.equal(read.reads, 3); // two identical plus one after a change
    assert.equal(read.identicalRepeats, 1); // exactly one re-read observed the same content again
    assert.equal(read.versions, 2);
    assert.ok(!report.opportunities.repeatedReads.some((row) => row.path.includes('other.ts') || row.path.includes('single\\read.ts')));

    const search = report.opportunities.repeatedSearches.find((row) => row.session === 'session-a');
    assert.equal(search.tool, 'Grep');
    assert.equal(search.pattern, 'needleGoal');
    assert.equal(search.calls, 2);

    const big = report.opportunities.largeToolOutputs;
    assert.equal(big.count, 1);
    assert.equal(big.chars, 25000);
    assert.equal(big.samples[0].tool, 'Bash');
    assert.equal(big.samples[0].target, 'npm test');
    assert.equal(big.samples[0].chars, 25000);
    assert.ok(big.estimatedTokens > 0);

    const limits = report.limitations.join('\n');
    assert.match(limits, /estimates|estimator/);
    assert.match(limits, /never converts/);
    assert.match(limits, /2 of 4 audited sessions/);
    assert.match(limits, /2 transcript line\(s\) were unparseable/);

    // Privacy guarantee: tool output and read content are never in the report.
    for (const leak of [APP_READ_TEXT, APP_READ_TEXT_CHANGED, CANARY]) {
      assert.ok(!run.stdout.includes(leak), `report must not contain ${leak}`);
      assert.ok(!run.stderr.includes(leak), `report must not contain ${leak}`);
    }

    // Read-only guarantee: session files are untouched after the audit.
    const after = snapshot(home);
    assert.deepEqual(after, before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('absent and partially missing session data degrade honestly, never to zero', () => {
  const empty = mkdtempSync(join(tmpdir(), 'cairn-optimize-empty-'));
  try {
    mkdirSync(join(empty, '.claude', 'projects'), { recursive: true });
    const run = optimize(['audit', '--consent', '--json', '--home', empty]);
    assert.equal(run.status, 3);
    assert.match(run.stderr, /No Claude Code project transcripts found/);
  } finally { rmSync(empty, { recursive: true, force: true }); }
  const gone = mkdtempSync(join(tmpdir(), 'cairn-optimize-gone-'));
  try {
    mkdirSync(join(gone, '.claude'), { recursive: true });
    const run = optimize(['audit', '--consent', '--home', gone]);
    assert.equal(run.status, 3);
    assert.match(run.stderr, /not run here|lives somewhere else/);
  } finally { rmSync(gone, { recursive: true, force: true }); }
});

test('project focus scans one project; unknown projects fail with the available list', () => {
  const home = writeHome();
  try {
    const focused = JSON.parse(optimize(['audit', '--consent', '--json', '--home', home, '--project', 'demoA']).stdout).data;
    assert.equal(focused.bounds.projectsPresent, 2);
    assert.equal(focused.bounds.projectsScanned, 1);
    assert.equal(focused.scope.project, 'demoA');
    assert.equal(focused.bounds.sessionsScanned, 2);    const missing = optimize(['audit', '--consent', '--home', home, '--project', 'nope']);
    assert.equal(missing.status, 3);
    assert.match(missing.stderr, /Available project directories: H--Personal-Projects-demoA, H--Personal-Projects-demoB/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('session cap and skips are reported, not silently truncated', () => {
  const home = writeHome();
  try {
    const capped = JSON.parse(optimize(['audit', '--consent', '--json', '--home', home, '--sessions', '2']).stdout).data;
    assert.equal(capped.bounds.sessionsScanned, 2);
    assert.equal(capped.bounds.sessionsSkipped, 2);
    assert.match(capped.limitations.join('\n'), /2-session cap/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('sessions stay isolated despite overlapping time windows; compact mode prints a summary', () => {
  const home = writeHome();
  try {
    const report = JSON.parse(optimize(['audit', '--consent', '--json', '--home', home]).stdout).data;
    const repeatSearchSessions = report.opportunities.repeatedSearches.filter((row) => row.pattern === 'needleGoal');
    assert.deepEqual(repeatSearchSessions.map((row) => row.project).sort(), ['H--Personal-Projects-demoA', 'H--Personal-Projects-demoB']); // two sessions, two rows, never merged
    assert.ok(repeatSearchSessions.every((row) => row.calls === 2));

    const human = optimize(['audit', '--consent', '--home', home]);
    assert.equal(human.status, 0);
    assert.match(human.stdout, /read-only/);
    assert.match(human.stdout, /Large tool outputs: 1 result/);
    assert.match(human.stdout, /Top repeated reads/);
    assert.ok(!human.stdout.includes(CANARY));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
