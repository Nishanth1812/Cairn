import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), 'weft-pack-'));
const sandbox = join(temp, 'sandbox');
const prefix = join(temp, 'prefix');
const home = join(sandbox, 'home');
const local = join(sandbox, 'local');
const config = join(sandbox, 'config');
const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: local, APPDATA: join(sandbox, 'roaming'), XDG_CONFIG_HOME: config, XDG_STATE_HOME: join(sandbox, 'state'), XDG_CACHE_HOME: join(sandbox, 'cache') };

function run(command, args, { quiet = false, ...options } = {}) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', shell: process.platform === 'win32' && command.endsWith('.cmd'), ...options });
  if (!quiet) process.stdout.write(`$ ${command} ${args.join(' ')}\n${result.stdout ?? ''}`);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.error}`);
  return result.stdout ?? '';
}

try {
  await mkdir(home, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const dryRun = JSON.parse(run(npm, ['pack', '--dry-run', '--json'], { quiet: true }));
  const files = dryRun[0].files.map(({ path }) => path);
  const required = ['LICENSE', 'dist/cli/index.js'];
  const forbidden = files.filter((path) => /^(?:\.claude\/|\.mcp\.json$|tests\/|\.env(?:\.|$))/.test(path));
  if (required.some((path) => !files.includes(path)) || forbidden.length) throw new Error(`Unexpected npm pack contents: missing ${required.filter((path) => !files.includes(path)).join(', ')}; forbidden ${forbidden.join(', ')}`);
  process.stdout.write(`Dry-run package contents: ${files.length} files; required files present; no local harness config, tests, or env files.\n`);
  const packOutput = run(npm, ['pack', '--silent', '--pack-destination', temp]);
  const tarball = join(temp, packOutput.trim().split(/\r?\n/).at(-1));
  run(npm, ['install', '--prefix', prefix, tarball]);

  const bin = join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'weft.cmd' : 'weft');
  const invoke = (args) => run(bin, args, { cwd: temp });
  invoke(['--version']);
  invoke(['--help']);
  invoke(['init']);
  invoke(['doctor']);

  for (const path of ['.claude', '.codex', join('.config', 'opencode')]) await mkdir(join(home, path), { recursive: true });
  invoke(['setup']);
  const created = [join(home, '.claude', 'settings.json'), join(home, '.claude.json'), join(home, '.codex', 'config.toml'), join(home, '.config', 'opencode', 'opencode.json')];
  const before = await Promise.all(created.map(async (path) => `${path}: ${await readFile(path, 'utf8').then(() => 'created').catch(() => 'not created')}`));
  process.stdout.write(`${before.join('\n')}\n`);
  invoke(['setup', '--uninstall']);
  const after = await Promise.all(created.map(async (path) => {
    const text = await readFile(path, 'utf8').catch(() => '');
    return `${path}: ${text.includes('weft') || text.includes('Weft Core Guidelines') ? 'still contains Weft entries' : 'Weft entries removed'}`;
  }));
  process.stdout.write(`${after.join('\n')}\n`);
  if (after.some((line) => !line.endsWith('Weft entries removed'))) throw new Error('Uninstall left Weft integration entries behind');
  const sqlite = run(process.execPath, ['-e', "require('better-sqlite3')(':memory:').close(); console.log('better-sqlite3 loaded')"], { cwd: join(prefix, 'node_modules', 'weft') });
  if (!sqlite.includes('better-sqlite3 loaded')) throw new Error('better-sqlite3 did not load');
} finally {
  await rm(temp, { recursive: true, force: true });
}
