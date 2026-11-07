import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { VerificationRecord } from '../verification/runner.js';
import { redactDeep } from '../core/security/redactor.js';

export interface Task {
  id: string; repoId: string; title: string; status: 'active' | 'blocked' | 'complete'; createdAt: string; updatedAt: string;
}

export interface CheckpointInput {
  taskId: string;
  workingTreeFingerprint: string;
  objective: string;
  status: Task['status'];
  findings: Array<{ text: string; evidence: Array<{ path: string; startLine?: number; endLine?: number; hash: string }>; verifiedAt?: string }>;
  decisions: string[];
  verification: Array<{ command: string; result: string; at: string }>;
  nextAction: string;
  revision?: string;
  importedNotePayload?: string;
  verificationRecords?: VerificationRecord[];
}

export interface Checkpoint extends CheckpointInput {
  id: string; schemaVersion: number; createdAt: string;
}

export interface ResumeTaskResult {
  task: Task;
  checkpoint: Checkpoint | null;
  isStale: boolean;
  staleEvidence: string[];
  verificationText?: string;
}

const now = () => new Date().toISOString();

export function createTask(db: Database.Database, repoId: string, title: string): Task {
  const timestamp = now();
  const task: Task = { id: randomUUID(), repoId, title, status: 'active', createdAt: timestamp, updatedAt: timestamp };
  db.prepare('INSERT INTO tasks (id, repo_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(task.id, task.repoId, task.title, task.status, task.createdAt, task.updatedAt);
  return task;
}

export function saveCheckpoint(db: Database.Database, input: CheckpointInput): Checkpoint {
  const previous = input.verificationRecords ? undefined : db.prepare('SELECT payload_json AS payloadJson FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(input.taskId) as { payloadJson: string } | undefined;
  const existing = previous ? (JSON.parse(previous.payloadJson) as CheckpointInput).verificationRecords : undefined;
  const payload = redactDeep({ ...input, verificationRecords: [...(input.verificationRecords ?? existing ?? [])].slice(-5) });
  const checkpoint: Checkpoint = { ...payload, id: randomUUID(), schemaVersion: 1, createdAt: now() };
  db.transaction(() => {
    db.prepare(`INSERT INTO checkpoints (id, task_id, schema_version, revision, working_tree_fingerprint, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      checkpoint.id, checkpoint.taskId, checkpoint.schemaVersion, checkpoint.revision ?? null,
      checkpoint.workingTreeFingerprint, JSON.stringify(payload), checkpoint.createdAt,
    );
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(input.status, checkpoint.createdAt, input.taskId);
  }).immediate();
  return checkpoint;
}

export function recordVerification(db: Database.Database, taskId: string, record: VerificationRecord): void {
  const row = db.prepare('SELECT payload_json AS payloadJson FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId) as { payloadJson: string } | undefined;
  const payload = row ? JSON.parse(row.payloadJson) as CheckpointInput : { taskId, workingTreeFingerprint: '', objective: '', status: 'active' as const, findings: [], decisions: [], verification: [], nextAction: '' };
  payload.verificationRecords = [...(payload.verificationRecords ?? []), record].slice(-5);
  saveCheckpoint(db, payload);
}

export function latestVerification(db: Database.Database, taskId: string): VerificationRecord | undefined {
  const row = db.prepare('SELECT payload_json AS payloadJson FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(taskId) as { payloadJson: string } | undefined;
  return row ? (JSON.parse(row.payloadJson) as CheckpointInput).verificationRecords?.at(-1) : undefined;
}

export function resumeTask(db: Database.Database, taskId: string, currentFingerprint: string): ResumeTaskResult {
  const row = db.prepare('SELECT id, repo_id AS repoId, title, status, created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
  if (!row) throw new Error(`Task not found: ${taskId}`);
  const checkpointRow = db.prepare(`SELECT id, schema_version AS schemaVersion, revision, working_tree_fingerprint AS workingTreeFingerprint,
      payload_json AS payloadJson, created_at AS createdAt FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(taskId) as { id: string; schemaVersion: number; revision: string | null; workingTreeFingerprint: string; payloadJson: string; createdAt: string } | undefined;
  if (!checkpointRow) return { task: row, checkpoint: null, isStale: false, staleEvidence: [] };
  const checkpoint: Checkpoint = {
    ...JSON.parse(checkpointRow.payloadJson) as CheckpointInput,
    id: checkpointRow.id, schemaVersion: checkpointRow.schemaVersion, createdAt: checkpointRow.createdAt,
    workingTreeFingerprint: checkpointRow.workingTreeFingerprint, revision: checkpointRow.revision ?? undefined,
  };
  const isStale = checkpoint.workingTreeFingerprint !== currentFingerprint;
  const staleEvidence = isStale ? [...new Set(checkpoint.findings.flatMap(finding => finding.evidence.map(evidence => evidence.path)))] : [];
  const latest = checkpoint.verificationRecords?.at(-1);
  const verificationText = latest ? `Verification: ${latest.command} — ${latest.exitCode === 0 ? 'passed' : `failed (exit ${latest.exitCode})`}, exit ${latest.exitCode}${latest.exitCode === 0 ? '' : `\n${latest.outputTail}`}` : undefined;
  return { task: row, checkpoint, isStale, staleEvidence, ...(verificationText ? { verificationText } : {}) };
}
