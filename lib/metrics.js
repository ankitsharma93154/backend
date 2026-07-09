// lib/metrics.js
//
// Lightweight metrics counters using Upstash Redis's REST API (plain
// fetch, no redis client library needed). Counters are bucketed by month
// so "monthly numbers" is just reading back one month's set of keys.
// Atomic INCRBY means concurrent serverless instances can't stomp on
// each other's counts, unlike a naive in-memory counter.
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

// Fire-and-forget INCRBY. Never throws — a metrics failure must never
// affect the actual user-facing request.
async function incrBy(key, amount = 1) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(`${UPSTASH_URL}/incrby/${encodeURIComponent(key)}/${amount}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
  } catch (err) {
    console.warn(`Metrics incrBy failed for ${key}:`, err?.message || err);
  }
}

async function getValue(key) {
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

// Records one pronunciation request outcome: which tier served it, and how
// long it took (durationMs accumulated so we can compute an average later).
function recordRequest(tier, durationMs, month = currentMonthKey()) {
  const prefix = `metrics:${month}`;
  return Promise.allSettled([
    incrBy(`${prefix}:total`),
    incrBy(`${prefix}:tier:${tier}:count`),
    incrBy(`${prefix}:tier:${tier}:durSum`, Math.round(durationMs)),
  ]);
}

function recordR2Get(status, month = currentMonthKey()) {
  // status: "hit" | "miss" | "fail"
  return incrBy(`metrics:${month}:r2get:${status}`);
}

function recordR2Put(status, month = currentMonthKey()) {
  // status: "ok" | "fail"
  return incrBy(`metrics:${month}:r2put:${status}`);
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
  ]);

  const tierStats = {};
  tiers.forEach((tier, i) => {
    const count = rest[i * 2];
    const durSum = rest[i * 2 + 1];
    tierStats[tier] = {
      count,
      avgDurationMs: count ? Math.round(durSum / count) : 0,
    };
  });

  const offset = tiers.length * 2;
  const r2get = {
    hit: rest[offset],
    miss: rest[offset + 1],
    fail: rest[offset + 2],
  };
  const r2put = { ok: rest[offset + 3], fail: rest[offset + 4] };

  const hitTiers = ["memory-hit", "in-flight-join", "r2-hit"];
  const totalHits = hitTiers.reduce((sum, t) => sum + tierStats[t].count, 0);
  const totalTtsCalls = tierStats["cold-miss"].count;
  const hitRatio = total ? Number(((totalHits / total) * 100).toFixed(1)) : 0;

  return {
    month,
    totalRequests: total,
    hitRatio,
    totalTtsCalls,
    tiers: tierStats,
    r2get,
    r2put,
  };
}

module.exports = {
  currentMonthKey,
  recordRequest,
  recordR2Get,
  recordR2Put,
  getMonthlySummary,
};
