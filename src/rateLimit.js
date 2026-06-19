const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;

/** @type {Map<string, number[]>} sliding-window request timestamps per user */
const buckets = new Map();

/** @type {Map<string, Promise<void>>} serializes check-and-consume per userId */
const chains = new Map();

function consumeSync(userId, nowMs) {
  const windowStart = nowMs - WINDOW_MS;
  let timestamps = buckets.get(userId);
  if (!timestamps) {
    timestamps = [];
    buckets.set(userId, timestamps);
  }

  while (timestamps.length > 0 && timestamps[0] <= windowStart) {
    timestamps.shift();
  }

  const ok = timestamps.length < RATE;
  if (ok) timestamps.push(nowMs);

  const remaining = Math.max(RATE - timestamps.length, 0);
  const resetMs =
    timestamps.length > 0 ? timestamps[0] + WINDOW_MS : nowMs + WINDOW_MS;

  return { ok, remaining, resetMs };
}

export function checkAndConsume(userId, nowMs = Date.now()) {
  return consumeSync(userId, nowMs);
}

/** Async entry point: serializes concurrent requests for the same userId. */
export async function checkAndConsumeAsync(userId, nowMs = Date.now()) {
  const prev = chains.get(userId) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  chains.set(userId, prev.then(() => gate));

  await prev;
  try {
    return consumeSync(userId, nowMs);
  } finally {
    release();
    if (chains.get(userId) === gate) chains.delete(userId);
  }
}
