import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// dist/chunks/<chunk>.js -> repo root
const ODOMETER_DIR = join(import.meta.dirname, '..', '..', 'src', 'tally');
const ODOMETER_STATS = join(ODOMETER_DIR, 'stats.mjs');
const ODOMETER_SERVER = join(ODOMETER_DIR, 'server.mjs');
export const ODOMETER_URL = 'http://127.0.0.1:4747';

function resolveBinary(): string[] {
  return ['node', '--no-warnings', ODOMETER_STATS];
}

export type OdometerRow = {
  time: string;
  tool: string;
  provider: string;
  model: string;
  project: string | null;
  session: string;
  turn: string;
  tools?: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costUsd: number;
  durMs: number;
};

async function fetchOdometer(range: string): Promise<OdometerRow[]> {
  const bin = resolveBinary();
  const { stdout } = await exec(bin[0]!, [...bin.slice(1), '--json', `--range=${range}`, '--no-start'], {
    timeout: 20_000,
    maxBuffer: 512 * 1024 * 1024,
  });
  return JSON.parse(stdout) as OdometerRow[];
}

export function rangeForSince(since?: string): string {
  if (!since) return 'All';
  const days = (Date.now() - new Date(since).getTime()) / 86_400_000;
  if (days <= 2) return '1d';
  if (days <= 14) return '7d';
  if (days <= 45) return '30d';
  return 'All';
}

function resolveServerBinary(): string[] {
  return ['node', '--no-warnings', ODOMETER_SERVER];
}

export async function odometerReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${ODOMETER_URL}/`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function startOdometerServer(): void {
  void odometerReachable().then((reachable) => {
    if (reachable) return;
    const bin = resolveServerBinary();
    const child = spawn(bin[0]!, bin.slice(1), { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  });
}

export async function readOdometer(range: string): Promise<OdometerRow[]> {
  try {
    return await fetchOdometer(range);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Tally not found: run cairn tally serve (${message})`);
  }
}
