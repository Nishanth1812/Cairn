import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export interface GitOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WorkingTreeStatus {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  branch: string;
  clean: boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER_BYTES = 5 * 1024 * 1024;
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'diff.useTextconv=false'];

export function runGit(repoPath: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...SAFE_CONFIG, ...args], {
      cwd: repoPath,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => finishError(new Error(`Git command timed out after ${timeoutMs}ms`)), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBufferBytes) return finishError(new Error(`Git stdout exceeded ${maxBufferBytes} byte limit`));
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBufferBytes) return finishError(new Error(`Git stderr exceeded ${maxBufferBytes} byte limit`));
      stderr.push(chunk);
    });
    child.on('error', (error) => finishError(error));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code ?? 1 });
    });
  });
}

export async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const result = await runGit(cwd, ['rev-parse', '--show-toplevel']);
    return result.exitCode === 0 && result.stdout.trim() ? resolve(result.stdout.trim()) : null;
  } catch {
    return null;
  }
}

export async function getWorkingTreeStatus(repoPath: string): Promise<WorkingTreeStatus> {
  const [status, branchResult] = await Promise.all([
    runGit(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
  ]);
  if (status.exitCode !== 0) throw new Error(status.stderr.trim() || 'Unable to read Git working tree status');
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const entries = status.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const x = entry[0] ?? ' ';
    const y = entry[1] ?? ' ';
    const path = entry.slice(3) || entry.slice(2);
    if (x === '?' && y === '?') untracked.push(path);
    else {
      if (x !== ' ') staged.push(path);
      if (y !== ' ') unstaged.push(path);
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++;
    }
  }
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : 'HEAD';
  return { staged, unstaged, untracked, branch, clean: staged.length + unstaged.length + untracked.length === 0 };
}

export async function getHeadCommit(repoPath: string): Promise<string | null> {
  try {
    const result = await runGit(repoPath, ['rev-parse', '--verify', 'HEAD']);
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

export async function getUnmergedBranches(repoPath: string): Promise<string[]> {
  try {
    const result = await runGit(repoPath, ['branch', '--no-color', '--no-merged']);
    if (result.exitCode !== 0) return [];
    return result.stdout.split(/\r?\n/).map((line) => line.replace(/^\*?\s+/, '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}
