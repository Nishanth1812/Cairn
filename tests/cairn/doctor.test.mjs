// Black-box test of `doctor`: an output-compression hook in the Claude Code settings is reported, since it hides code from Read.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const BIN = resolve('dist/context.js');
const home = mkdtempSync(join(tmpdir(), 'cairn-home-'));
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'r'), LOCALAPPDATA: join(home, 'l'), XDG_CONFIG_HOME: join(home, 'c'), XDG_STATE_HOME: join(home, 's'), XDG_CACHE_HOME: join(home, 'k') };
const doctor = () => execFileSync('node', ['--no-warnings', BIN, 'doctor'], { env, encoding: 'utf8' });

before(() => { execFileSync('node', ['--no-warnings', BIN, 'init'], { env, encoding: 'utf8' }); });
after(() => { rmSync(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); });

test('doctor is silent about compression until a caveman hook is configured', () => {
  assert.doesNotMatch(doctor(), /output compression/);
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'caveman shrink-hook' }] }] } }));
  assert.match(doctor(), /output compression: conflict .*body elided/);
});
