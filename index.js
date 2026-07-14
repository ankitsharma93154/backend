require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const textToSpeech = require("@google-cloud/text-to-speech");
const cors = require("cors");
const NodeCache = require("node-cache");
const fs = require("fs").promises;
const path = require("path");
const compression = require("compression");
const etag = require("etag");
const { GoogleAuth } = require("google-auth-library");
const helmet = require("helmet");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
// getFromR2/saveToR2 now live in lib/r2.js with built-in timing logs,
// so every caller gets consistent [R2-GET]/[R2-PUT] logging for free.
const { getFromR2, saveToR2 } = require("./lib/r2");
const {
  recordRequest,
  recordError,
  getMonthlySummary,
  currentMonthKey,
  getRawValue,
  setRawValue,
  deleteRawValue,
} = require("./lib/metrics");

// ===== Cache Setup =====
const cache = new NodeCache({
  stdTTL: 604800, // 7 days
  checkperiod: 7200, // 2 hours
  maxKeys: 10000,
  useClones: false,
  deleteOnExpire: true,
});

const letterCache = new NodeCache({
  stdTTL: 86400, // 24 hours
  checkperiod: 3600, // 1 hour
  useClones: false,
  deleteOnExpire: true,
});

// ===== Abuse Protection Config =====
// Centralized so nothing below is a magic number.
const MAX_WORD_LENGTH = 80;
const MAX_WORDS = 4;
const MAX_COLD_MISSES = 50; // per IP, within COLD_MISS_WINDOW_SECONDS
const COLD_MISS_WINDOW_SECONDS = 600; // 10 minutes
const IP_BAN_DURATION = 60 * 60; // max/final tier ban, in seconds — see BAN_DURATIONS below
const REPUTATION_THRESHOLD = 20; // score at which an IP gets auto-banned
const REPUTATION_TTL_SECONDS = 300; // score decays to 0 after 5 min of good behavior

// Progressive bans: first offense is short, repeat offenses within a 24h
// window escalate. This limits collateral damage to a legitimate user who
// trips a threshold once (e.g. shared/NAT'd IP, an unusually heavy study
// session) while still coming down hard on sustained abuse.
const BAN_DURATIONS = [15 * 60, 30 * 60, IP_BAN_DURATION]; // 15min, 30min, 1hr
const BAN_HISTORY_TTL_SECONDS = 24 * 60 * 60; // offense count resets after 24h clean

// Point weights for the reputation system. Tune freely.
const POINTS_INVALID_INPUT = 3;
const POINTS_LONG_INPUT = 4;
const POINTS_RATE_LIMIT = 5;
const POINTS_BOT_UA = 2;

// IP reputation score. Using NodeCache's TTL as the decay mechanism: every
// increment refreshes the TTL, so a score only decays once an IP goes quiet
// for REPUTATION_TTL_SECONDS.
const ipScoreCache = new NodeCache({
  stdTTL: REPUTATION_TTL_SECONDS,
  checkperiod: 60,
  useClones: false,
});

// ip -> ban record. TTL enforces the current tier's ban duration
// automatically — no manual cleanup needed.
const bannedIpsCache = new NodeCache({
  stdTTL: IP_BAN_DURATION,
  checkperiod: 60,
  useClones: false,
});

// ip -> number of prior bans in the trailing 24h window. Used to pick which
// tier of BAN_DURATIONS applies on the next offense. A long TTL relative to
// the ban itself is intentional: an IP that keeps re-offending across
// several separate bans should keep escalating, not reset to "first offense"
// the moment its previous ban expires.
const banHistoryCache = new NodeCache({
  stdTTL: BAN_HISTORY_TTL_SECONDS,
  checkperiod: 300,
  useClones: false,
});

const persistentBanKey = (ip) => `abuse:ban:${ip}`;

// ip -> cold-miss count in the trailing window. Legitimate users mostly hit
// cache; a client generating lots of brand-new words in a few minutes is
// either a bot or scraping the dictionary, both of which cost real TTS money.
const coldMissCache = new NodeCache({
  stdTTL: COLD_MISS_WINDOW_SECONDS,
  checkperiod: 120,
  useClones: false,
});

// Lightweight in-process counters for observability. These are separate from
// lib/metrics.js (which persists per-month tier/error counts) — this block
// is specifically about how much abuse-prevention is doing.
const securityMetrics = {
  totalRequests: 0,
  acceptedRequests: 0,
  rejectedValidation: 0,
  rateLimited: 0,
  blockedIPs: 0,
  coldMisses: 0,
  memoryHits: 0,
  r2Hits: 0,
};

const getClientIp = (req) =>
  req.headers["cf-connecting-ip"] ||
  req.ip ||
  req.connection?.remoteAddress ||
  "unknown";

const logSuspiciousRequest = (req, { word, reason }) => {
  const ip = getClientIp(req);
  const ua = req.headers["user-agent"] || "unknown";
  const referer = req.headers["referer"] || req.headers["referrer"] || "none";
  console.warn(
    `[SUSPICIOUS] timestamp=${new Date().toISOString()} ip=${ip} ua="${ua}" referer="${referer}" reason=${reason} word="${word}"`,
  );
};

const banIp = (ip, reason) => {
  const priorBans = banHistoryCache.get(ip) || 0;
  const tierIndex = Math.min(priorBans, BAN_DURATIONS.length - 1);
  const duration = BAN_DURATIONS[tierIndex];
  banHistoryCache.set(ip, priorBans + 1); // refresh the 24h repeat-offense window
  const banRecord = {
    reason,
    bannedAt: Date.now(),
    tier: tierIndex + 1,
  };
  bannedIpsCache.set(ip, banRecord, duration);
  void setRawValue(
    persistentBanKey(ip),
    JSON.stringify(banRecord),
    duration,
  ).catch((err) => {
    console.warn(
      `[IP-BAN-PERSIST] ip=${ip} reason=${reason} err=${err?.message || err}`,
    );
  });
  securityMetrics.blockedIPs++;
  console.warn(
    `[IP-BANNED] ip=${ip} reason=${reason} tier=${tierIndex + 1}/${BAN_DURATIONS.length} duration=${duration}s`,
  );
};

const hydrateBlockedIp = async (ip) => {
  if (bannedIpsCache.has(ip)) return bannedIpsCache.get(ip);

  const rawBan = await getRawValue(persistentBanKey(ip));
  if (!rawBan) return null;

  try {
    const banRecord = JSON.parse(rawBan);
    const bannedAt = Number(banRecord?.bannedAt) || 0;
    const tier = Number(banRecord?.tier) || 1;
    const duration =
      BAN_DURATIONS[Math.min(Math.max(tier - 1, 0), BAN_DURATIONS.length - 1)];
    const expiresAt = bannedAt + duration * 1000;
    if (!bannedAt || expiresAt <= Date.now()) {
      bannedIpsCache.del(ip);
      void deleteRawValue(persistentBanKey(ip)).catch(() => {});
      return null;
    }

    bannedIpsCache.set(
      ip,
      banRecord,
      Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)),
    );
    return banRecord;
  } catch (err) {
    console.warn(`[IP-BAN-HYDRATE] ip=${ip} err=${err?.message || err}`);
    return null;
  }
};

const isIpBlocked = (ip) => bannedIpsCache.has(ip);

const incrementIpScore = (ip, points, reason) => {
  const current = ipScoreCache.get(ip) || 0;
  const next = current + points;
  ipScoreCache.set(ip, next); // refresh TTL -> sliding decay window
  console.warn(
    `[IP-SCORE] ip=${ip} score=${next} (+${points}) reason=${reason}`,
  );
  if (next >= REPUTATION_THRESHOLD && !isIpBlocked(ip)) {
    banIp(ip, `reputation-threshold:${reason}`);
  }
  return next;
};

const incrementColdMiss = (ip) => {
  const current = coldMissCache.get(ip) || 0;
  const next = current + 1;
  coldMissCache.set(ip, next); // sliding window, resets TTL on each new miss
  if (next > MAX_COLD_MISSES && !isIpBlocked(ip)) {
    banIp(ip, "cold-miss-abuse");
  }
  return next;
};

const recordRejectedRequest = (_reason) => {
  securityMetrics.rejectedValidation++;
};

const BOT_UA_PATTERNS = [
  /python-requests/i,
  /curl\//i,
  /wget/i,
  /go-http-client/i,
  /axios/i,
  /node-fetch/i,
  /^java\//i,
  /okhttp/i,
  /libwww-perl/i,
  /scrapy/i,
];

// A missing User-Agent is itself unusual for a browser-driven site, so it's
// treated as automated too (log + score bump only — never an outright block).
const isAutomatedClient = (ua) => {
  if (!ua) return true;
  return BOT_UA_PATTERNS.some((pattern) => pattern.test(ua));
};

// Allows unicode letters/marks/numbers, spaces, apostrophes and hyphens.
// This deliberately keeps foreign alphabets, names, brand names, made-up
// words, and hyphenated/apostrophe'd names working (see requirement #14) —
// it only excludes things a real dictionary word would never contain:
// HTML/URL/email syntax, control characters, and stray symbols/punctuation
// (which also happens to catch sentence-like input, since periods,
// exclamation points, commas etc. aren't in the allowed set).
const ALLOWED_WORD_CHARS_PATTERN = /^[\p{L}\p{M}\p{N}\s'’\-]+$/u;
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
const HTML_TAG_PATTERN = /<[^>]*>/;
const URL_PATTERN = /(https?:\/\/|www\.)/i;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

const validateWordInput = (rawWord) => {
  const value = String(rawWord ?? "");
  const trimmed = value.trim();

  if (!trimmed) return { valid: false, reason: "empty" };
  if (trimmed.length > MAX_WORD_LENGTH)
    return { valid: false, reason: "too-long" };
  if (CONTROL_CHAR_PATTERN.test(trimmed))
    return { valid: false, reason: "control-chars" };
  if (HTML_TAG_PATTERN.test(trimmed))
    return { valid: false, reason: "html-tag" };
  if (URL_PATTERN.test(trimmed)) return { valid: false, reason: "url" };
  if (EMAIL_PATTERN.test(trimmed)) return { valid: false, reason: "email" };

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > MAX_WORDS) return { valid: false, reason: "too-many-words" };

  if (!ALLOWED_WORD_CHARS_PATTERN.test(trimmed)) {
    return { valid: false, reason: "unsupported-symbols" };
  }

  return { valid: true };
};

const validateAccentInput = (rawAccent) => {
  const accent = String(rawAccent || "en-US").trim();
  if (!voiceMap[accent]) return { valid: false, reason: "invalid-accent" };
  return { valid: true, value: accent };
};

const validateSpeedInput = (rawSpeed) => {
  if (rawSpeed === undefined || rawSpeed === null || rawSpeed === "") {
    return { valid: true, value: "normal" };
  }
  const normalized = String(rawSpeed).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(speedMap, normalized)) {
    return { valid: false, reason: "invalid-speed" };
  }
  return { valid: true, value: normalized };
};

const TRUE_TOKENS = new Set(["true", "1", "yes", "male", "m"]);
const FALSE_TOKENS = new Set(["false", "0", "no", "female", "f"]);

const validateIsMaleInput = (rawIsMale) => {
  if (rawIsMale === undefined || rawIsMale === null || rawIsMale === "") {
    return { valid: true, value: true };
  }
  if (typeof rawIsMale === "boolean") return { valid: true, value: rawIsMale };
  const normalized = String(rawIsMale).trim().toLowerCase();
  if (TRUE_TOKENS.has(normalized)) return { valid: true, value: true };
  if (FALSE_TOKENS.has(normalized)) return { valid: true, value: false };
  return { valid: false, reason: "invalid-isMale" };
};

// ===== User-facing validation messages =====
// The `reason` codes above (e.g. "too-many-words") are useful in logs but
// meaningless to an actual visitor. This maps each one to a plain-English
// sentence the frontend can show directly under the input box, so someone
// whose input got rejected understands why instead of just seeing a
// generic "something went wrong."
const USER_FACING_REASONS = {
  empty: "Please enter a word or short phrase to look up.",
  "too-long": `That entry is too long — please keep it under ${MAX_WORD_LENGTH} characters.`,
  "control-chars":
    "That entry contains characters we can't process. Please remove any special/invisible characters and try again.",
  "html-tag": "That entry can't contain HTML tags.",
  url: "That entry looks like a link — please enter a word or phrase instead.",
  email:
    "That entry looks like an email address — please enter a word or phrase instead.",
  "too-many-words": `Please enter up to ${MAX_WORDS} words at a time — that looked more like a full sentence.`,
  "unsupported-symbols":
    "That entry contains symbols we don't support. Please use letters, numbers, spaces, hyphens, or apostrophes only.",
  "invalid-accent":
    "That accent isn't supported. Please choose one of the available accents.",
  "invalid-speed":
    "That speed option isn't supported. Please choose slow, normal, or fast.",
  "invalid-isMale": "That voice option isn't valid.",
};

const getUserFacingMessage = (reason) =>
  USER_FACING_REASONS[reason] ||
  "We couldn't process that entry. Please try a different word or phrase.";

// ===== TTS budget guard =====
// Everything above limits *requests*. This limits *dollars* — the actual
// cost driver is Google TTS synthesis, which only happens on a cold-miss.
// This is a soft, in-memory monthly cap: it resets on redeploy/restart, so
// treat it as a safety net that stops a slow leak from becoming a shock
// bill between now and when you notice, NOT a replacement for a real budget
// alert configured in Google Cloud Console (which persists regardless of
// this process's lifecycle).
//
// Disabled by default (0). Set TTS_MONTHLY_SOFT_LIMIT to the number of
// cold-miss TTS calls you're comfortable with per month to enable it.
const TTS_MONTHLY_SOFT_LIMIT = Number(process.env.TTS_MONTHLY_SOFT_LIMIT) || 0;
let ttsUsageMonthKey = currentMonthKey();
let ttsUsageCount = 0;

const checkTtsBudget = () => {
  const nowMonthKey = currentMonthKey();
  if (nowMonthKey !== ttsUsageMonthKey) {
    ttsUsageMonthKey = nowMonthKey;
    ttsUsageCount = 0;
  }
  if (TTS_MONTHLY_SOFT_LIMIT > 0 && ttsUsageCount >= TTS_MONTHLY_SOFT_LIMIT) {
    return false;
  }
  return true;
};

const recordTtsUsage = () => {
  ttsUsageCount += 1;
  if (
    TTS_MONTHLY_SOFT_LIMIT > 0 &&
    ttsUsageCount === Math.floor(TTS_MONTHLY_SOFT_LIMIT * 0.9)
  ) {
    console.error(
      `[TTS-BUDGET] WARNING: ${ttsUsageCount}/${TTS_MONTHLY_SOFT_LIMIT} monthly TTS calls used (90%).`,
    );
  }
};

// ===== Origin / API-key gate for the expensive endpoint =====
// The /get-pronunciation hammering came from clients with no relationship
// to the actual site — curl/scripts hitting the API directly. This ties
// requests to either (a) a browser sending Origin/Referer that matches your
// own site, or (b) a shared-secret header for non-browser clients you
// control (a mobile app, a server-to-server integration, etc).
//
// ALLOWED_ORIGINS: comma-separated list, e.g. "https://example.com,https://www.example.com"
// API_SHARED_SECRET: a long random string; clients you control send it as X-API-Key
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const API_SHARED_SECRET = process.env.API_SHARED_SECRET || null;

// Exact-match (or proper path-boundary) origin check. A naive
// candidate.startsWith(allowed) is bypassable — e.g. allowed
// "https://quickpronounce.site" would also match
// "https://quickpronounce.site.evil.com", since that string literally
// starts with the allowed origin as a substring. Requiring an exact match,
// or a match followed by "/", closes that off.
const originMatches = (candidate, allowed) =>
  candidate === allowed || candidate.startsWith(allowed + "/");

const verifyRequestOrigin = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (API_SHARED_SECRET && apiKey === API_SHARED_SECRET) return next();

  // Not configured yet — don't silently break the whole site on deploy.
  // The startup warning below makes sure this doesn't stay unnoticed.
  if (ALLOWED_ORIGINS.length === 0) return next();

  const origin = req.headers["origin"];
  const referer = req.headers["referer"] || req.headers["referrer"];
  const candidate = origin || referer;

  const isAllowed =
    !!candidate &&
    ALLOWED_ORIGINS.some((allowed) => originMatches(candidate, allowed));

  if (!isAllowed) {
    const ip = getClientIp(req);
    const word = String(req.body?.word || req.query?.word || "");
    logSuspiciousRequest(req, { word, reason: "bad-origin" });
    incrementIpScore(ip, POINTS_INVALID_INPUT, "bad-origin");
    recordRejectedRequest("bad-origin");
    return res.status(403).json({
      error: "Forbidden",
      reason: "Requests must originate from an authorized client.",
    });
  }

  next();
};

// ===== Express Setup =====
const app = express();

// App Platform sits behind a load balancer/proxy, so Express needs this to
// read the real client IP from X-Forwarded-For instead of seeing every
// request as coming from the same internal address. Without it, the rate
// limiter below would group all users together instead of limiting per-IP.
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

// Belt-and-suspenders on top of Helmet's defaults — explicit so these are
// guaranteed present regardless of Helmet version/config changes.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=()",
  );
  next();
});

app.use(
  cors({
    origin: (origin, callback) => {
      // Non-browser clients (curl, server-to-server) don't send an Origin
      // header at all — CORS doesn't apply to them anyway; the
      // verifyRequestOrigin middleware on /get-pronunciation is what
      // actually gates those. Browser requests get checked against the
      // allowlist below.
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.length === 0) return callback(null, true); // not configured yet
      if (ALLOWED_ORIGINS.some((allowed) => originMatches(origin, allowed))) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    maxAge: 86400,
  }),
);

app.use(
  compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
      const contentType = res.getHeader("Content-Type") || "";
      if (contentType.includes("audio")) return false;
      return compression.filter(req, res);
    },
  }),
);

app.use(
  bodyParser.json({
    limit: "10kb",
    strict: true,
  }),
);

// ===== Startup sanity checks (fail loud, not silently, on misconfig) =====
if (!process.env.R2_BUCKET) {
  console.error(
    "WARNING: R2_BUCKET is not set. R2 caching will fail on every request and silently fall back to regenerating audio via TTS every time.",
  );
}

if (ALLOWED_ORIGINS.length === 0) {
  console.error(
    "WARNING: ALLOWED_ORIGINS is not set. The origin/API-key gate on /get-pronunciation is running in PERMISSIVE mode — anyone can call it directly, same as before. Set ALLOWED_ORIGINS (comma-separated site origins) and/or API_SHARED_SECRET to actually enforce it.",
  );
}

// ===== Static File Serving =====
app.use(
  express.static("public", {
    maxAge: "1y",
    etag: true,
    lastModified: true,
    immutable: true,
    setHeaders: (res, path) => {
      if (path.endsWith(".html")) {
        res.setHeader("Cache-Control", "public, max-age=3600");
      } else if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg)$/)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }),
);

// ===== Global Response Timing =====
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (duration > 500)
      console.warn(`Slow request: ${req.method} ${req.url} took ${duration}ms`);
  });
  next();
});

// ===== TTS Client =====
let ttsClient = null;
const getTtsClient = () => {
  if (!ttsClient) {
    const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    ttsClient = new textToSpeech.TextToSpeechClient({
      auth: new GoogleAuth({
        credentials,
        scopes: "https://www.googleapis.com/auth/cloud-platform",
      }),
    });
  }
  return ttsClient;
};

// ===== Voice & Cache Helpers =====
const voiceMap = {
  "en-US": { male: "en-US-Wavenet-D", female: "en-US-Wavenet-F" },
  "en-GB": { male: "en-GB-Wavenet-D", female: "en-GB-Wavenet-F" },
  "en-AU": { male: "en-AU-Wavenet-B", female: "en-AU-Wavenet-C" },
  "en-IN": { male: "en-IN-Wavenet-C", female: "en-IN-Wavenet-D" },
};

const speedMap = { slow: 0.6, normal: 0.9, fast: 1.2 };
const inFlightPronunciations = new Map();

const getCacheKey = (word, accent, voice, speed) =>
  `${word.toLowerCase()}_${accent}_${voice}_${speed}`;

const getR2Key = (word, accent, voice, speed) => {
  return (
    crypto
      .createHash("sha256")
      .update(`${word}_${accent}_${voice}_${speed}`)
      .digest("hex") + ".json"
  );
};

const applyPronunciationCacheHeaders = (req, res) => {
  if (req.method === "GET") {
    res.setHeader(
      "Cache-Control",
      "public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400",
    );
    res.setHeader("CDN-Cache-Control", "public, s-maxage=604800");
    res.setHeader("Vercel-CDN-Cache-Control", "public, s-maxage=604800");
    return;
  }

  res.setHeader("Cache-Control", "private, max-age=604800");
};

const buildPronunciationResponse = async ({
  word,
  accent,
  isMale,
  speed,
  speakingRate,
  voiceName,
}) => {
  const wordData = await fetchWordData(word);
  const ttsRequestObj = {
    input: { text: word },
    voice: { languageCode: accent, name: voiceName },
    audioConfig: {
      audioEncoding: "MP3",
      speakingRate,
      pitch: 0,
      volumeGainDb: 1,
    },
  };

  const ttsResponse = await getTtsClient().synthesizeSpeech(ttsRequestObj);
  const base64Audio = ttsResponse[0].audioContent.toString("base64");

  const responseData = {
    audioContent: base64Audio,
    phonetic: wordData
      ? accent === "en-GB"
        ? wordData.uk_ipa
        : wordData.us_ipa
      : null,
    // New format: structured entries with pos, definitions, examples per entry
    entries: wordData?.entries ?? [],
    default_pos: wordData?.default_pos ?? null,
    // Old format fallbacks for backward compatibility
    synonyms: wordData?.synonyms ?? [],
    antonyms: wordData?.antonyms ?? [],
    syllables: wordData?.syllables ?? [],
    audioMetadata: { format: "mp3", accent, voice: voiceName, speed },
  };

  const responseETag = etag(word + accent + (isMale ? "m" : "f") + speed);
  return {
    data: responseData,
    etag: responseETag,
    timestamp: Date.now(),
  };
};

const handlePronunciationRequest = async (req, res, payload = {}) => {
  const requestStart = Date.now();
  const ip = getClientIp(req);
  const ua = req.headers["user-agent"] || "";
  securityMetrics.totalRequests++;

  const rawWord = String(payload.word || "");

  // ---- Strict parameter validation (Fix #10: never silently default a bad
  // value — reject it with 400 instead) ----
  const accentResult = validateAccentInput(payload.accent);
  if (!accentResult.valid) {
    logSuspiciousRequest(req, { word: rawWord, reason: accentResult.reason });
    incrementIpScore(ip, POINTS_INVALID_INPUT, accentResult.reason);
    recordRejectedRequest(accentResult.reason);
    return res.status(400).json({
      error: "Invalid accent selected",
      reason: accentResult.reason,
      message: getUserFacingMessage(accentResult.reason),
    });
  }

  const speedResult = validateSpeedInput(payload.speed);
  if (!speedResult.valid) {
    logSuspiciousRequest(req, { word: rawWord, reason: speedResult.reason });
    incrementIpScore(ip, POINTS_INVALID_INPUT, speedResult.reason);
    recordRejectedRequest(speedResult.reason);
    return res.status(400).json({
      error: "Invalid speed selected",
      reason: speedResult.reason,
      message: getUserFacingMessage(speedResult.reason),
    });
  }

  const isMaleResult = validateIsMaleInput(payload.isMale);
  if (!isMaleResult.valid) {
    logSuspiciousRequest(req, { word: rawWord, reason: isMaleResult.reason });
    incrementIpScore(ip, POINTS_INVALID_INPUT, isMaleResult.reason);
    recordRejectedRequest(isMaleResult.reason);
    return res.status(400).json({
      error: "Invalid isMale value",
      reason: isMaleResult.reason,
      message: getUserFacingMessage(isMaleResult.reason),
    });
  }

  // ---- Word input validation (Fix #1: highest priority — runs before any
  // cache lookup or R2 request) ----
  const wordValidation = validateWordInput(rawWord);
  if (!wordValidation.valid) {
    logSuspiciousRequest(req, { word: rawWord, reason: wordValidation.reason });
    incrementIpScore(
      ip,
      wordValidation.reason === "too-long"
        ? POINTS_LONG_INPUT
        : POINTS_INVALID_INPUT,
      wordValidation.reason,
    );
    recordRejectedRequest(wordValidation.reason);
    return res.status(400).json({
      error: "Invalid word input.",
      reason: wordValidation.reason,
      message: getUserFacingMessage(wordValidation.reason),
    });
  }

  if (isAutomatedClient(ua)) {
    console.warn(`[BOT-UA] ip=${ip} ua="${ua}" word="${rawWord}"`);
    incrementIpScore(ip, POINTS_BOT_UA, "automated-client");
  }

  const accent = accentResult.value;
  const isMale = isMaleResult.value;
  const speed = speedResult.value;
  const word = rawWord.trim().toLowerCase();
  const speakingRate = speedMap[speed] || speedMap.normal;
  const voiceName = isMale ? voiceMap[accent].male : voiceMap[accent].female;
  const cacheKey = getCacheKey(word, accent, isMale ? "male" : "female", speed);
  const r2Key = getR2Key(word, accent, isMale ? "male" : "female", speed);
  const clientEtag = req.headers["if-none-match"];

  // helper so every exit path logs total duration + which tier served it,
  // and also records it to persistent monthly metrics (non-blocking), plus
  // the in-process security counters used by /metrics.
  //
  // NOTE: no waitUntil here anymore. On App Platform the process is a
  // persistent long-lived server, not a serverless function that freezes
  // right after res.json() — so this promise just runs to completion in
  // the background naturally. waitUntil was only ever needed to prevent
  // Vercel from freezing the invocation before a background task finished.
  const logTotal = (tier) => {
    const dur = Date.now() - requestStart;
    console.log(`[TOTAL] tier=${tier} word=${word} dur=${dur}ms`);
    recordRequest(tier, dur); // synchronous now — no .catch() needed
    securityMetrics.acceptedRequests++;
    if (tier === "memory-hit") securityMetrics.memoryHits++;
    if (tier === "r2-hit") securityMetrics.r2Hits++;
    if (tier === "cold-miss") {
      securityMetrics.coldMisses++;
      incrementColdMiss(ip);
    }
  };

  // Fix #2: check the cheap in-memory cache FIRST.
  const cachedResponse = cache.get(cacheKey);
  if (cachedResponse) {
    logTotal("memory-hit");
    if (clientEtag === cachedResponse.etag) return res.status(304).end();
    res.setHeader("ETag", cachedResponse.etag);
    applyPronunciationCacheHeaders(req, res);
    return res.json(cachedResponse.data);
  }

  // Fix #3: in-flight check registered BEFORE the R2 round trip.
  if (inFlightPronunciations.has(cacheKey)) {
    try {
      await inFlightPronunciations.get(cacheKey);
      const warmedCache = cache.get(cacheKey);
      if (warmedCache) {
        logTotal("in-flight-join");
        if (clientEtag === warmedCache.etag) return res.status(304).end();
        res.setHeader("ETag", warmedCache.etag);
        applyPronunciationCacheHeaders(req, res);
        return res.json(warmedCache.data);
      }
      // Fall through if the in-flight request didn't warm the cache.
    } catch {
      // The in-flight request failed for the other caller; fall through
      // and let this request try again independently below.
    }
  }

  try {
    const buildPromise = (async () => {
      // getFromR2 logs its own [R2-GET] hit/miss/fail + duration internally.
      const r2Response = await getFromR2(r2Key);
      if (r2Response) {
        cache.set(cacheKey, r2Response);
        return { tier: "r2-hit", response: r2Response };
      }

      if (!checkTtsBudget()) {
        console.error(
          `[TTS-BUDGET] Monthly cap reached (${ttsUsageCount}/${TTS_MONTHLY_SOFT_LIMIT}) — rejecting cold-miss for "${word}"`,
        );
        return { tier: "budget-exhausted" };
      }
      recordTtsUsage();

      const freshResponse = await buildPronunciationResponse({
        word,
        accent,
        isMale,
        speed,
        speakingRate,
        voiceName,
      });

      cache.set(cacheKey, freshResponse);
      saveToR2(r2Key, freshResponse).catch((err) => {
        console.error(
          `Unexpected R2 save error for ${r2Key}:`,
          err?.message || err,
        );
      });

      return { tier: "cold-miss", response: freshResponse };
    })();
    inFlightPronunciations.set(cacheKey, buildPromise);

    const buildResult = await buildPromise;

    if (buildResult?.tier === "budget-exhausted") {
      return res.status(503).json({
        error: "Service temporarily unavailable",
        reason:
          "Monthly speech-synthesis budget reached. Please try again later.",
      });
    }

    const { tier, response } = buildResult;
    logTotal(tier); // response-sent duration; does NOT include the async R2 save below

    res.setHeader("ETag", response.etag);
    applyPronunciationCacheHeaders(req, res);
    res.setHeader("Timing-Allow-Origin", "*");
    res.setHeader("Server-Timing", `total;dur=${Date.now() - requestStart}`);
    res.json(response.data);
  } catch (error) {
    console.error(
      `Error processing ${word}: ${error.message || "Unknown error"}`,
    );
    recordError(); // synchronous now — no .catch() needed
    res.status(500).json({
      error: "Error processing pronunciation request",
      suggestion: "Please try again in a moment",
      word,
    });
  } finally {
    inFlightPronunciations.delete(cacheKey);
  }
};

// ===== Fetch Word Data (local data folder) =====
const fetchWordData = async (word) => {
  if (!word) return null;
  try {
    const normalized = String(word).trim().toLowerCase();
    const letter = normalized[0];
    if (!letter || letter < "a" || letter > "z") return null;

    // Namespaced separately from the raw /data/:letter.json route below —
    // they store different shapes, so each route must only read back what
    // it itself wrote.
    const indexedCacheKey = `indexed:${letter}`;
    let data = letterCache.get(indexedCacheKey);
    if (!data) {
      const filePath = path.join(__dirname, "data", `${letter}.json`);
      const fileContent = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(fileContent);
      data = Array.isArray(parsed)
        ? Object.fromEntries(parsed.map((e) => [e.word, e]))
        : parsed;
      letterCache.set(indexedCacheKey, data);
    }

    const entry = Array.isArray(data)
      ? data.find((e) => e.word === normalized) || null
      : data[normalized] || null;
    if (!entry) return null;

    return {
      us_ipa: entry.us_ipa || entry.us || null,
      uk_ipa: entry.uk_ipa || entry.uk || null,
      entries: entry.entries || [],
      default_pos: entry.default_pos || null,
      synonyms: entry.synonyms || [],
      antonyms: entry.antonyms || [],
      syllables: entry.syllables || [],
    };
  } catch (err) {
    console.warn(`fetchWordData failed for ${word}:`, err?.message);
    return null;
  }
};

// ===== IP Blocking Middleware =====
// Runs before the rate limiters on the pronunciation routes. Anyone whose
// reputation score crossed REPUTATION_THRESHOLD, or who tripped the
// cold-miss abuse threshold, gets a flat 403 for the remainder of their ban.
const blockBannedIps = (req, res, next) => {
  (async () => {
    const ip = getClientIp(req);
    const banRecord = await hydrateBlockedIp(ip);
    if (banRecord || isIpBlocked(ip)) {
      const ttl = bannedIpsCache.getTtl(ip); // epoch ms when the ban expires
      const retryAfter = ttl
        ? Math.max(1, Math.ceil((ttl - Date.now()) / 1000))
        : IP_BAN_DURATION;
      return res.status(403).json({
        error: "Forbidden",
        reason:
          "This IP has been temporarily blocked due to abusive request patterns.",
        retryAfter,
      });
    }
    next();
  })().catch((err) => {
    console.error(`[IP-BLOCK-CHECK] unexpected error: ${err?.message || err}`);
    next();
  });
};

// ===== Rate Limiting =====
// Scoped to /get-pronunciation specifically, since that's the only route
// that costs real money (TTS synthesis on cold-miss) and the only one
// that's been seeing scripted/abusive traffic. GET and POST are split
// (Fix #4) since POST is the more common scripted-abuse vector; health
// routes stay unrestricted.
//
// Fix #7 revisited: originally this also folded User-Agent into the key for
// "suspicious" clients, on the theory that it would reduce bypasses. On
// review that was backwards — a script can set an arbitrary User-Agent on
// every request (unlike a browser, which can't override it), so keying by
// IP+UA would let a bot multiply its effective rate-limit budget just by
// rotating UA strings from the same IP. Plain IP is simpler and doesn't
// have that hole; UA is still used elsewhere (reputation scoring) where it
// can only ever add friction, never subtract it.
const buildRateLimitKey = (req) => getClientIp(req);

// Fix #11: graceful abuse responses instead of a bare "too many requests"
// string — include a retryAfter and bump the IP's reputation score, since a
// rate-limit hit is itself a signal.
const rateLimitHandler = (windowMs) => (req, res) => {
  const ip = getClientIp(req);
  incrementIpScore(ip, POINTS_RATE_LIMIT, "rate-limit");
  securityMetrics.rateLimited++;
  res.status(429).json({
    error: "Rate limit exceeded",
    retryAfter: Math.ceil(windowMs / 1000),
  });
};

const GET_WINDOW_MS = 60 * 1000;
const POST_WINDOW_MS = 60 * 1000;

const getPronunciationLimiter = rateLimit({
  windowMs: GET_WINDOW_MS,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: buildRateLimitKey,
  handler: rateLimitHandler(GET_WINDOW_MS),
});

const postPronunciationLimiter = rateLimit({
  windowMs: POST_WINDOW_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: buildRateLimitKey,
  handler: rateLimitHandler(POST_WINDOW_MS),
});

process.on("uncaughtException", (error) =>
  console.error("Uncaught Exception:", error),
);
process.on("unhandledRejection", (reason, promise) =>
  console.error("Unhandled Rejection at:", promise, "reason:", reason),
);

// ===== Routes =====
app.get("/", (_, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send("Express on Vercel - Pronunciation API");
});

app.get("/health", (_, res) => {
  res.status(200).json({ status: "ok", timestamp: Date.now() });
});

// GET /metrics?month=2026-07  (defaults to current month if omitted)
app.get("/metrics", async (req, res) => {
  const month = String(req.query.month || currentMonthKey());
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "month must be in YYYY-MM format" });
  }
  try {
    const summary = await getMonthlySummary(month);
    res.json({ ...summary, security: securityMetrics });
  } catch (err) {
    console.error("Failed to load metrics summary:", err?.message || err);
    res.status(500).json({ error: "Could not load metrics" });
  }
});

app.get("/data/:letter.json", async (req, res) => {
  const letter = String(req.params.letter || "").toLowerCase()[0];
  if (!letter || letter < "a" || letter > "z")
    return res.status(400).json({ error: "Invalid letter" });

  try {
    const rawCacheKey = `raw:${letter}`;
    let cachedData = letterCache.get(rawCacheKey);
    if (cachedData) return res.json(cachedData);

    const filePath = path.join(__dirname, "data", `${letter}.json`);
    const fileContent = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(fileContent);

    letterCache.set(rawCacheKey, data);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.json(data);
  } catch (err) {
    console.error(`Failed to read local data for ${letter}:`, err?.message);
    res.status(500).json({ error: "Data unavailable" });
  }
});

app.post(
  "/get-pronunciation",
  blockBannedIps,
  verifyRequestOrigin,
  postPronunciationLimiter,
  async (req, res) => {
    await handlePronunciationRequest(req, res, req.body || {});
  },
);

app.get(
  "/get-pronunciation",
  blockBannedIps,
  verifyRequestOrigin,
  getPronunciationLimiter,
  async (req, res) => {
    await handlePronunciationRequest(req, res, req.query || {});
  },
);

// ===== Graceful Shutdown =====
const shutdown = () => {
  console.log("Shutting down gracefully...");
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ===== Start Server =====
// App Platform (and most non-serverless hosts) expect the app to actually
// bind to a port. Vercel handled this invisibly by wrapping the exported
// app itself; here we need to do it ourselves. App Platform injects PORT
// via env — 8080 is just a sane local fallback.
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
