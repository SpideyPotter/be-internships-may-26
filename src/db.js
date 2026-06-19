import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { setTimeout as sleep } from 'node:timers/promises';

const dbPath = process.env.DATABASE_URL || './data/signals.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_created ON signals(user_id, created_at);
`);

const MAX_RETRIES = Number(process.env.DB_MAX_RETRIES || 5);
const BASE_BACKOFF_MS = Number(process.env.DB_BASE_BACKOFF_MS || 50);

function maybeFail() {
  const rate = Number(process.env.DB_FAIL_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    const err = new Error('simulated_db_failure');
    err.code = 'SQLITE_BUSY';
    throw err;
  }
}

export function isRetriableError(err) {
  if (!err) return false;
  const code = err.code || '';
  return (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    err.message === 'simulated_db_failure'
  );
}

export function isUniqueViolation(err) {
  return err?.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function backoffMs(attempt) {
  const exp = BASE_BACKOFF_MS * 2 ** attempt;
  const jitter = Math.random() * BASE_BACKOFF_MS;
  return exp + jitter;
}

export async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!isRetriableError(err) || attempt === MAX_RETRIES - 1) throw err;
      await sleep(backoffMs(attempt));
    }
  }
  throw lastErr;
}

function rowToSignal(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    payload: row.payload,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
  };
}

export function insertSignal(userId, type, payload, idemKey, nowMs) {
  maybeFail();
  const stmt = db.prepare(
    'INSERT INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?,?,?,?,?)'
  );
  const info = stmt.run(userId, type, String(payload), idemKey || null, nowMs);
  return {
    id: info.lastInsertRowid,
    userId,
    type,
    payload: String(payload),
    idempotencyKey: idemKey,
    createdAt: nowMs,
  };
}

export function getByIdemKey(idemKey) {
  maybeFail();
  const stmt = db.prepare(
    'SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE idempotency_key = ?'
  );
  return rowToSignal(stmt.get(idemKey));
}

export function listSignals(userId, limit) {
  maybeFail();
  const stmt = db.prepare(
    'SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  );
  return stmt.all(userId, limit);
}
