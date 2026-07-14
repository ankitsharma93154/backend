// lib/metrics.js
//
// Lightweight metrics counters using Upstash Redis's REST API. Writes are
// batched in-memory and flushed periodically as one pipelined multi-command
// request, instead of firing separate INCRBY calls per single request — on
// a serverless free tier, per-request writes exhaust the command quota
// almost immediately even at modest traffic.
//
// Requires two env vars (from your Upstash dashboard — same product
// you've already used for the other project's rate limiting):
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.warn(
    "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — metrics recording will silently no-op.",
  );
}

function currentMonthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ===== Kill switch =====
// Set METRICS_DISABLED=true in your environment to no-op all metrics
// recording and reading — useful when you're locked out of your Redis
// quota and don't want failed fetch calls / retry logic burning function
// time for nothing. Flip back to false (or unset) once quota resets.
const METRICS_DISABLED = process.env.METRICS_DISABLED === "true";

// ===== In-memory accumulator, flushed periodically =====
// Instead of writing to Redis on every request, increments pile up here and
// get flushed as one pipelined batch every FLUSH_INTERVAL_MS. Within a warm
// Vercel instance handling a burst of traffic, this cuts command usage by
// roughly the number of requests that land in one flush window — e.g. 50
// requests in a 30s window becomes 1 flush instead of 50+ separate writes.
let acc = {};
let flushTimer = null;
const FLUSH_INTERVAL_MS = 30_000; // tune: 15-60s is reasonable for a metrics dashboard

function bump(key, amount = 1) {
  if (METRICS_DISABLED) return;
  acc[key] = (acc[key] || 0) + amount;
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  // Don't let this timer keep a warm instance alive on its own.
  flushTimer.unref?.();
}

async function flush() {
  flushTimer = null;
  const toFlush = acc;
  acc = {};
  const entries = Object.entries(toFlush);
  if (entries.length === 0) return;
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;

  try {
    const res = await fetch(`${UPSTASH_URL}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        entries.map(([key, amount]) => ["INCRBY", key, amount]),
      ),
    });
    if (!res.ok) {
      throw new Error(`Upstash pipeline responded ${res.status}`);
    }
  } catch (err) {
    console.warn("Metrics flush failed:", err?.message || err);
    // Put the counts back so they aren't silently lost, and retry later.
    for (const [key, amount] of entries) acc[key] = (acc[key] || 0) + amount;
    scheduleFlush();
  }
}

// Forces any pending accumulated counts to Redis right now. Not required
// for normal operation, but handy for tests or a graceful-shutdown hook.
async function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();
}

async function getValue(key) {
  if (METRICS_DISABLED) return 0;
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return 0;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json();
    return Number(data?.result || 0);
  } catch (err) {
    console.warn(`Metrics getValue failed for ${key}:`, err?.message || err);
    return 0;
  }
}

// Records one pronunciation request outcome: which tier served it. Duration
// is only tracked for cold-miss (the real TTS round-trip) — memory-hit,
// in-flight-join, and r2-hit are all fast-by-construction, so timing them
// just adds writes without adding useful signal.
function recordRequest(tier, durationMs, month = currentMonthKey()) {
  const prefix = `metrics:${month}`;
  bump(`${prefix}:total`);
  bump(`${prefix}:tier:${tier}:count`);
  if (tier === "cold-miss") {
    bump(`${prefix}:tier:${tier}:durSum`, Math.round(durationMs));
  }
}

function recordR2Get(status, month = currentMonthKey()) {
  // status: "hit" | "miss" | "fail"
  bump(`metrics:${month}:r2get:${status}`);
}

function recordR2Put(status, month = currentMonthKey()) {
  // status: "ok" | "fail"
  bump(`metrics:${month}:r2put:${status}`);
}

// Records a request that ended in a 500. Only fires when something is
// actually broken (auth failure, TTS outage, etc.), so it costs virtually
// nothing in write volume but gives /metrics visibility into breakage that
// was previously only visible by combing through Vercel logs.
function recordError(month = currentMonthKey()) {
  bump(`metrics:${month}:errors`);
}

// Reads back a full summary for one month.
async function getMonthlySummary(month = currentMonthKey()) {
  const prefix = `metrics:${month}`;
  const tiers = ["memory-hit", "in-flight-join", "r2-hit", "cold-miss"];

  const [total, ...rest] = await Promise.all([
    getValue(`${prefix}:total`),
    ...tiers.flatMap((tier) => [
      getValue(`${prefix}:tier:${tier}:count`),
      getValue(`${prefix}:tier:${tier}:durSum`),
    ]),
    getValue(`${prefix}:r2get:hit`),
    getValue(`${prefix}:r2get:miss`),
    getValue(`${prefix}:r2get:fail`),
    getValue(`${prefix}:r2put:ok`),
    getValue(`${prefix}:r2put:fail`),
    getValue(`${prefix}:errors`),
  ]);

  const tierStats = {};
  tiers.forEach((tier, i) => {
    const count = rest[i * 2];
    const durSum = rest[i * 2 + 1];
    // avgDurationMs is only meaningful for cold-miss — durSum is never
    // written for the other tiers, so it naturally comes out as null there.
    tierStats[tier] = {
      count,
      avgDurationMs:
        tier === "cold-miss" && count ? Math.round(durSum / count) : null,
    };
  });

  const offset = tiers.length * 2;
  const r2get = {
    hit: rest[offset],
    miss: rest[offset + 1],
    fail: rest[offset + 2],
  };
  const r2put = { ok: rest[offset + 3], fail: rest[offset + 4] };
  const errors = rest[offset + 5];

  const hitTiers = ["memory-hit", "in-flight-join", "r2-hit"];
  const totalHits = hitTiers.reduce((sum, t) => sum + tierStats[t].count, 0);
  const totalTtsCalls = tierStats["cold-miss"].count;
  const hitRatio = total ? Number(((totalHits / total) * 100).toFixed(1)) : 0;

  return {
    month,
    totalRequests: total,
    hitRatio,
    totalHits,
    totalTtsCalls,
    tiers: tierStats,
    r2get,
    r2put,
    errors,
  };
}

module.exports = {
  currentMonthKey,
  recordRequest,
  recordR2Get,
  recordR2Put,
  recordError,
  getMonthlySummary,
  flushNow,
};
