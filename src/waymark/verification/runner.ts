import { spawn } from 'node:child_process';
import { getWorkingTreeStatus } from '../core/gitstate/gitRunner.js';
import { redactSafe } from '../core/security/redactor.js';

export interface VerificationRecord { command: string; exitCode: number; durationMs: number; outputTail: string; ranAt: string; changedFiles: string[] }

export async function runVerification(repoRoot: string, command: string, options: { timeoutMs?: number } = {}): Promise<VerificationRecord> {
  const started = Date.now(), ranAt = new Date().toISOString(), timeoutMs = options.timeoutMs ?? 120_000;
  const status = await getWorkingTreeStatus(repoRoot).catch(() => ({ staged: [], unstaged: [], untracked: [] }));
  const changedFiles = [...new Set([...status.staged, ...status.unstaged, ...status.untracked])].sort();
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh';
    const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    const child = spawn(shell, shellArgs, { cwd: repoRoot, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false, timedOut = false;
    const finish = (exitCode: number) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ command, exitCode, durationMs: Date.now() - started, outputTail: redactSafe(Buffer.from(output).subarray(-4096).toString('utf8')), ranAt, changedFiles });
    };
    const killTree = () => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
      else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    const append = (chunk: Buffer) => { output += chunk.toString(); if (Buffer.byteLength(output) > 8192) output = Buffer.from(output).subarray(-8192).toString('utf8'); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', (error) => { output += `\n${error.message}`; finish(127); });
    child.once('close', (code) => finish(timedOut ? 124 : code ?? 1));
  });
}
