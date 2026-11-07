#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
};
const runs = Number(option('--runs', '15'));
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
const cli = resolve(option('--cli', join(root, 'bin', 'cairn.mjs')));
const targets = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--runs' && args[index - 1] !== '--cli');
const defaultBase = 'H:\\Personal\\Projects\\Cairn\\.test-tmp\\ab2\\repos';
const repos = targets.length ? targets : [join(defaultBase, 'playwright'), join(defaultBase, 'django')];
const queryFor = (repo) => /playwright/i.test(repo) ? ['route', 'BrowserContext'] : ['model', 'Model'];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

function invoke(repo, home, command, timed = false) {
  const env = {
    ...process.env,
    HOME: join(home, 'home'), USERPROFILE: join(home, 'profile'), APPDATA: join(home, 'appdata'),
    LOCALAPPDATA: join(home, 'localappdata'), XDG_CONFIG_HOME: join(home, 'config'),
    XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache'),
    ...(timed ? { CAIRN_TIMING: '1' } : {}),
  };
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) mkdirSync(env[key], { recursive: true });
  const preload = timed ? ['--import', pathToFileURL(join(root, 'tools', 'lookup-timing-preload.mjs')).href] : [];
  const started = performance.now();
  const result = spawnSync(process.execPath, [...preload, cli, 'context', ...command], { cwd: repo, env, encoding: 'utf8', windowsHide: true });
  const elapsed = performance.now() - started;
  if (result.error || result.status !== 0) throw new Error(`${command.join(' ')} failed: ${result.stderr || result.error || result.status}`);
  const phases = Object.fromEntries([...result.stderr.matchAll(/^CAIRN_TIMING ([a-z_]+)=([\d.]+)ms$/gm)].map((match) => [match[1], Number(match[2])]));
  return { elapsed, phases, outputHash: createHash('sha256').update(result.stdout).digest('hex') };
}

const results = [];
for (const repo of repos) {
  const label = /playwright/i.test(repo) ? 'playwright' : /django/i.test(repo) ? 'django' : repo;
  const isolatedRoot = join(root, '.test-tmp', 'lookup-latency');
  mkdirSync(isolatedRoot, { recursive: true });
  const home = mkdtempSync(join(isolatedRoot, `${label}-`));
  try {
    invoke(repo, home, ['init']);
    invoke(repo, home, ['repos', 'register', repo]);
    invoke(repo, home, ['index', repo]);
    const [query, symbol] = queryFor(repo);
    const commands = [
      ['search', ['search', query]],
      ['context', ['context', query]],
      ['search --refs', ['search', '--refs', symbol]],
    ];
    invoke(repo, home, ['search', query]); // Prime the cached HEAD; timed calls then measure only warm refreshes.
    for (const [name, command] of commands) {
      const samples = Array.from({ length: runs }, () => invoke(repo, home, command, true));
      if (new Set(samples.map(({ outputHash }) => outputHash)).size !== 1) throw new Error(`${label} ${name} returned inconsistent warm results`);
      const totals = samples.map(({ elapsed }) => elapsed);
      const phases = ['node_startup', 'module_load', 'db_open', 'refresh', 'query_pack'];
      results.push({ repo: label, command: name, median: percentile(totals, 0.5), p95: percentile(totals, 0.95), outputHash: samples[0].outputHash, phases: Object.fromEntries(phases.map((phase) => {
        const values = samples.map((sample) => sample.phases[phase]).filter((value) => value !== undefined);
        return [phase, values.length ? percentile(values, 0.5) : null];
      })) });
    }
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
}

console.log('repo\tcommand\tmedian ms\tp95 ms\tstartup\tmodule load\tDB open\trefresh\tquery+pack\tresult SHA-256 (phase medians ms)');
for (const row of results) console.log(`${row.repo}\t${row.command}\t${row.median.toFixed(1)}\t${row.p95.toFixed(1)}\t${Object.values(row.phases).map((value) => value === null ? 'N/A' : value.toFixed(1)).join('\t')}\t${row.outputHash}`);
