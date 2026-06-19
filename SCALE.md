# Scale Plan

## Data model / indexes

- **Primary table:** `signals(id, user_id, type, payload, idempotency_key UNIQUE, created_at)`
- **Indexes:**
  - `UNIQUE(idempotency_key)` — atomic dedupe on insert; concurrent writers get `SQLITE_CONSTRAINT_UNIQUE` and re-read the existing row.
  - `(user_id, created_at DESC)` — fast per-user listing for `GET /v1/signals`.
- **Production:** move to PostgreSQL (or CockroachDB) with the same constraints; use read replicas for list queries.

## Idempotency across instances

- **Single source of truth:** the database unique constraint on `idempotency_key`, not an in-memory cache.
- **Write path:** `INSERT` → on unique violation, `SELECT` by key and return the stored resource (same body/status as the original).
- **Optional cache:** Redis `SET idem:{key} {response} NX EX 86400` for hot keys; still fall back to DB on miss.
- **Restarts:** durable store survives process restarts; no local state required.

## Rate limiting across instances

- **Current (single instance):** sliding-window counter per `userId` in memory, serialized per user via an async lock chain to avoid lost updates under concurrent requests.
- **Multi-instance:** replace in-memory buckets with **Redis**:
  - Sorted set per user: `ZADD rl:{userId} {timestamp} {timestamp}`, trim entries older than 60s, `ZCARD` vs limit.
  - Or fixed window: `INCR rl:{userId}:{minute_bucket}` with `EXPIRE 120`.
- **Edge:** enforce at API gateway (Envoy/Kong) + app layer for defense in depth.

## Observability (logs / metrics / alerts)

- **Logs:** structured JSON (request id, userId, idempotency key hash, status, latency, retry count).
- **Metrics:** RPS, p50/p99 latency, 429 rate, 503 rate, DB retry count, idempotency replay rate.
- **Tracing:** OpenTelemetry spans around DB + rate-limit checks.
- **Alerts:** 503 spike, DB pool exhaustion, 429 anomaly per user, error budget burn.

## Failure modes (DB down / partial outages / retries)

- **Transient errors (`SQLITE_BUSY`, simulated failures):** exponential backoff with jitter (max 5 attempts); idempotent inserts mean retries never create duplicates.
- **Unique conflicts:** treated as success path — fetch and return existing row.
- **Sustained DB outage:** return `503 db_unavailable` after retries exhausted; clients should retry with same `Idempotency-Key`.
- **Circuit breaker (future):** open after N consecutive DB failures; half-open probe; fail fast while open.

## 10k RPS design sketch (infra & cost ballpark)

| Layer | Approach |
|---|---|
| **App** | 8–16 stateless Fastify pods (Node 20), ~700–1.2k RPS each |
| **Load balancer** | ALB / nginx, connection pooling, HTTP/2 |
| **DB** | PostgreSQL primary + 2 read replicas; PgBouncer pool (~200 connections) |
| **Idempotency / rate limit** | Redis Cluster (3 nodes) — ~50k ops/s headroom |
| **Queue (optional)** | SQS/Kafka for async signal fan-out if writes can be async |
| **Caching** | Redis for hot list queries (userId → last N signals, TTL 30s) |

**Rough cost (AWS, us-east-1):** ~$800–1.5k/mo — 8× `c6i.large` app nodes, `db.r6g.large` Postgres, `cache.r6g.large` Redis, ALB.

**Capacity math:** 10k RPS × ~2ms app + ~5ms DB (pooled) ≈ 70ms aggregate; horizontal scale keeps per-node load under ~1k RPS with headroom for bursts.

The complete architecture diagram is available here:
**Figma Board:**  
https://www.figma.com/board/tCEo4KhURg4m64LspHYdec/Signals-Service---10k-RPS-Architecture
