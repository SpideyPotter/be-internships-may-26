import {
  insertSignal,
  getByIdemKey,
  listSignals,
  withRetry,
  isUniqueViolation,
} from './db.js';
import { checkAndConsumeAsync } from './rateLimit.js';

function nowMs() {
  return Date.now();
}

/** @type {Map<string, Promise<void>>} */
const idemChains = new Map();

async function withIdemLock(idemKey, fn) {
  const prev = idemChains.get(idemKey) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  idemChains.set(idemKey, prev.then(() => gate));

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (idemChains.get(idemKey) === gate) idemChains.delete(idemKey);
  }
}

async function createSignal(req, reply, { userId, type, payload, idem }) {
  const { ok, remaining, resetMs } = await checkAndConsumeAsync(userId, nowMs());
  if (!ok) {
    return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });
  }

  const t = nowMs();
  try {
    return await withRetry('insertSignal', () =>
      insertSignal(userId, type, payload, idem, t)
    );
  } catch (e) {
    if (idem && isUniqueViolation(e)) {
      try {
        const existing = await withRetry('getByIdemKey', () => getByIdemKey(idem));
        if (existing) return existing;
      } catch (lookupErr) {
        req.log.error({ err: lookupErr, ctx: 'getByIdemKey_after_conflict' });
        return reply.code(503).send({ error: 'db_unavailable' });
      }
    }
    req.log.error({ err: e, ctx: 'insertSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};
  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  if (idem) {
    return withIdemLock(idem, async () => {
      try {
        const existing = await withRetry('getByIdemKey', () => getByIdemKey(idem));
        if (existing) return existing;
        if (existing) return existing;
      } catch (e) {
        req.log.error({ err: e, ctx: 'getByIdemKey' });
        return reply.code(503).send({ error: 'db_unavailable' });
      }
      return createSignal(req, reply, { userId, type, payload, idem });
    });
  }

  return createSignal(req, reply, { userId, type, payload, idem: null });
}

export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });
  const lim = Math.min(Number(limit) || 20, 100);
  try {
    const rows = await withRetry('listSignals', () => listSignals(userId, lim));
    return { items: rows };
  } catch (e) {
    req.log.error({ err: e, ctx: 'listSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}
