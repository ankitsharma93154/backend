// const express = require("express");
// const bodyParser = require("body-parser");
// const textToSpeech = require("@google-cloud/text-to-speech");
// const cors = require("cors");
// const NodeCache = require("node-cache");
// const fs = require("fs").promises;
// const path = require("path");
// const compression = require("compression");
// const etag = require("etag");
// const { GoogleAuth } = require("google-auth-library");
// const helmet = require("helmet");
// const crypto = require("crypto");
// const { r2, GetObjectCommand, PutObjectCommand } = require("./lib/r2");

// // ===== Cache Setup =====
// const cache = new NodeCache({
//   stdTTL: 604800, // 7 days
//   checkperiod: 7200, // 2 hours
//   maxKeys: 10000,
//   useClones: false,
//   deleteOnExpire: true,
// });

// const letterCache = new NodeCache({
//   stdTTL: 86400, // 24 hours
//   checkperiod: 3600, // 1 hour
//   useClones: false,
//   deleteOnExpire: true,
// });

// // ===== Express Setup =====
// const app = express();

// app.use(
//   helmet({
//     contentSecurityPolicy: false,
//     crossOriginEmbedderPolicy: false,
//   }),
// );

// app.use(
//   cors({
//     origin: true,
//     methods: ["GET", "POST"],
//     allowedHeaders: ["Content-Type", "Authorization"],
//     maxAge: 86400,
//   }),
// );

// app.use(
//   compression({
//     level: 6,
//     threshold: 1024,
//     filter: (req, res) => {
//       const contentType = res.getHeader("Content-Type") || "";
//       if (contentType.includes("audio")) return false;
//       return compression.filter(req, res);
//     },
//   }),
// );

// app.use(
//   bodyParser.json({
//     limit: "10kb",
//     strict: true,
//   }),
// );

// require("dotenv").config();

// // ===== Static File Serving =====
// app.use(
//   express.static("public", {
//     maxAge: "1y",
//     etag: true,
//     lastModified: true,
//     immutable: true,
//     setHeaders: (res, path) => {
//       if (path.endsWith(".html")) {
//         res.setHeader("Cache-Control", "public, max-age=3600");
//       } else if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg)$/)) {
//         res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
//       }
//     },
//   }),
// );

// // ===== Global Response Timing =====
// app.use((req, res, next) => {
//   const start = Date.now();
//   res.on("finish", () => {
//     const duration = Date.now() - start;
//     if (duration > 500)
//       console.warn(`Slow request: ${req.method} ${req.url} took ${duration}ms`);
//   });
//   next();
// });

// // ===== TTS Client =====
// let ttsClient = null;
// const getTtsClient = () => {
//   if (!ttsClient) {
//     const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
//     ttsClient = new textToSpeech.TextToSpeechClient({
//       auth: new GoogleAuth({
//         credentials,
//         scopes: "https://www.googleapis.com/auth/cloud-platform",
//       }),
//     });
//   }
//   return ttsClient;
// };

// // ===== Voice & Cache Helpers =====
// const voiceMap = {
//   "en-US": { male: "en-US-Wavenet-D", female: "en-US-Wavenet-F" },
//   "en-GB": { male: "en-GB-Wavenet-D", female: "en-GB-Wavenet-F" },
//   "en-AU": { male: "en-AU-Wavenet-B", female: "en-AU-Wavenet-C" },
//   "en-IN": { male: "en-IN-Wavenet-C", female: "en-IN-Wavenet-D" },
// };

// const speedMap = { slow: 0.6, normal: 0.9, fast: 1.2 };
// const inFlightPronunciations = new Map();

// const getCacheKey = (word, accent, voice, speed) =>
//   `${word.toLowerCase()}_${accent}_${voice}_${speed}`;

// const getR2Key = (word, accent, voice, speed) => {
//   return (
//     crypto
//       .createHash("sha256")
//       .update(`${word}_${accent}_${voice}_${speed}`)
//       .digest("hex") + ".json"
//   );
// };

// async function getFromR2(key) {
//   try {
//     const response = await r2.send(
//       new GetObjectCommand({
//         Bucket: process.env.R2_BUCKET,
//         Key: key,
//       }),
//     );

//     const text = await response.Body.transformToString();

//     return JSON.parse(text);
//   } catch {
//     return null;
//   }
// }

// async function saveToR2(key, data) {
//   await r2.send(
//     new PutObjectCommand({
//       Bucket: process.env.R2_BUCKET,
//       Key: key,
//       Body: JSON.stringify(data),
//       ContentType: "application/json",
//     }),
//   );
// }

// const normalizeIsMale = (value) => {
//   if (typeof value === "boolean") return value;
//   if (typeof value === "string") {
//     const normalized = value.trim().toLowerCase();
//     if (["true", "1", "yes", "male", "m"].includes(normalized)) return true;
//     if (["false", "0", "no", "female", "f"].includes(normalized)) return false;
//   }
//   return true;
// };

// const applyPronunciationCacheHeaders = (req, res) => {
//   if (req.method === "GET") {
//     res.setHeader(
//       "Cache-Control",
//       "public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400",
//     );
//     res.setHeader("CDN-Cache-Control", "public, s-maxage=604800");
//     res.setHeader("Vercel-CDN-Cache-Control", "public, s-maxage=604800");
//     return;
//   }

//   res.setHeader("Cache-Control", "private, max-age=604800");
// };

// const buildPronunciationResponse = async ({
//   word,
//   accent,
//   isMale,
//   speed,
//   speakingRate,
//   voiceName,
// }) => {
//   const wordData = await fetchWordData(word);
//   const ttsRequestObj = {
//     input: { text: word },
//     voice: { languageCode: accent, name: voiceName },
//     audioConfig: {
//       audioEncoding: "MP3",
//       speakingRate,
//       pitch: 0,
//       volumeGainDb: 1,
//     },
//   };

//   const ttsResponse = await getTtsClient().synthesizeSpeech(ttsRequestObj);
//   const base64Audio = ttsResponse[0].audioContent.toString("base64");

//   const responseData = {
//     audioContent: base64Audio,
//     phonetic: wordData
//       ? accent === "en-GB"
//         ? wordData.uk_ipa
//         : wordData.us_ipa
//       : null,
//     // New format: structured entries with pos, definitions, examples per entry
//     entries: wordData?.entries ?? [],
//     default_pos: wordData?.default_pos ?? null,
//     // Old format fallbacks for backward compatibility
//     synonyms: wordData?.synonyms ?? [],
//     antonyms: wordData?.antonyms ?? [],
//     syllables: wordData?.syllables ?? [],
//     audioMetadata: { format: "mp3", accent, voice: voiceName, speed },
//   };

//   const responseETag = etag(word + accent + (isMale ? "m" : "f") + speed);
//   return {
//     data: responseData,
//     etag: responseETag,
//     timestamp: Date.now(),
//   };
// };

// const handlePronunciationRequest = async (req, res, payload = {}) => {
//   const requestStart = Date.now();
//   const rawWord = String(payload.word || "");
//   const accent = String(payload.accent || "en-US");
//   const isMale = normalizeIsMale(payload.isMale);
//   const speed = String(payload.speed || "normal").toLowerCase();

//   if (!rawWord) return res.status(400).json({ error: "Word is required." });
//   if (!voiceMap[accent])
//     return res.status(400).json({ error: "Invalid accent selected" });

//   const word = rawWord.trim().toLowerCase();
//   const speakingRate = speedMap[speed] || speedMap.normal;
//   const voiceName = isMale ? voiceMap[accent].male : voiceMap[accent].female;
//   const cacheKey = getCacheKey(word, accent, isMale ? "male" : "female", speed);
//   const r2Key = getR2Key(word, accent, isMale ? "male" : "female", speed);
//   const clientEtag = req.headers["if-none-match"];

//   const cachedResponse = cache.get(cacheKey);
//   const r2Response = await getFromR2(r2Key);

//   if (r2Response) {
//     console.log("R2 CACHE HIT");

//     cache.set(cacheKey, r2Response);

//     if (clientEtag === r2Response.etag) {
//       return res.status(304).end();
//     }

//     res.setHeader("ETag", r2Response.etag);
//     applyPronunciationCacheHeaders(req, res);

//     return res.json(r2Response.data);
//   }
//   if (cachedResponse && clientEtag === cachedResponse.etag)
//     return res.status(304).end();
//   if (cachedResponse) {
//     res.setHeader("ETag", cachedResponse.etag);
//     applyPronunciationCacheHeaders(req, res);
//     return res.json(cachedResponse.data);
//   }

//   try {
//     if (inFlightPronunciations.has(cacheKey)) {
//       await inFlightPronunciations.get(cacheKey);
//       const warmedCache = cache.get(cacheKey);
//       if (warmedCache) {
//         if (clientEtag === warmedCache.etag) return res.status(304).end();
//         res.setHeader("ETag", warmedCache.etag);
//         applyPronunciationCacheHeaders(req, res);
//         return res.json(warmedCache.data);
//       }
//     }

//     const buildPromise = buildPronunciationResponse({
//       word,
//       accent,
//       isMale,
//       speed,
//       speakingRate,
//       voiceName,
//     });
//     inFlightPronunciations.set(cacheKey, buildPromise);

//     const freshResponse = await buildPromise;
//     cache.set(cacheKey, freshResponse);
//     await saveToR2(r2Key, freshResponse);

//     res.setHeader("ETag", freshResponse.etag);
//     applyPronunciationCacheHeaders(req, res);
//     res.setHeader("Timing-Allow-Origin", "*");
//     res.setHeader("Server-Timing", `total;dur=${Date.now() - requestStart}`);
//     res.json(freshResponse.data);
//   } catch (error) {
//     console.error(
//       `Error processing ${word}: ${error.message || "Unknown error"}`,
//     );
//     res.status(500).json({
//       error: "Error processing pronunciation request",
//       suggestion: "Please try again in a moment",
//       word,
//     });
//   } finally {
//     inFlightPronunciations.delete(cacheKey);
//   }
// };

// // ===== Fetch Word Data (local data folder) =====
// const fetchWordData = async (word) => {
//   if (!word) return null;
//   try {
//     const normalized = String(word).trim().toLowerCase();
//     const letter = normalized[0];
//     if (!letter || letter < "a" || letter > "z") return null;

//     let data = letterCache.get(letter);
//     if (!data) {
//       const filePath = path.join(__dirname, "data", `${letter}.json`); // ← must be inside here
//       const fileContent = await fs.readFile(filePath, "utf-8");
//       const parsed = JSON.parse(fileContent);
//       data = Array.isArray(parsed)
//         ? Object.fromEntries(parsed.map((e) => [e.word, e]))
//         : parsed;
//       letterCache.set(letter, data);
//     }

//     const entry = Array.isArray(data)
//       ? data.find((e) => e.word === normalized) || null
//       : data[normalized] || null;
//     if (!entry) return null;

//     return {
//       us_ipa: entry.us_ipa || entry.us || null,
//       uk_ipa: entry.uk_ipa || entry.uk || null,
//       // New format fields
//       entries: entry.entries || [],
//       default_pos: entry.default_pos || null,
//       // Old format fallbacks
//       synonyms: entry.synonyms || [],
//       antonyms: entry.antonyms || [],
//       syllables: entry.syllables || [],
//     };
//   } catch (err) {
//     console.warn(`fetchWordData failed for ${word}:`, err?.message);
//     return null;
//   }
// };

// // ===== Global Error Handling =====
// process.on("uncaughtException", (error) =>
//   console.error("Uncaught Exception:", error),
// );
// process.on("unhandledRejection", (reason, promise) =>
//   console.error("Unhandled Rejection at:", promise, "reason:", reason),
// );

// // ===== Routes =====
// app.get("/", (_, res) => {
//   res.setHeader("Cache-Control", "public, max-age=3600");
//   res.send("Express on Vercel - Pronunciation API");
// });

// app.get("/health", (_, res) => {
//   res.status(200).json({ status: "ok", timestamp: Date.now() });
// });

// app.get("/data/:letter.json", async (req, res) => {
//   const letter = String(req.params.letter || "").toLowerCase()[0];
//   if (!letter || letter < "a" || letter > "z")
//     return res.status(400).json({ error: "Invalid letter" });

//   try {
//     let cachedData = letterCache.get(letter);
//     if (cachedData) return res.json(cachedData);

//     const filePath = path.join(__dirname, "data", `${letter}.json`);
//     const fileContent = await fs.readFile(filePath, "utf-8");
//     const data = JSON.parse(fileContent);

//     letterCache.set(letter, data);
//     res.setHeader("Cache-Control", "public, max-age=86400");
//     res.json(data);
//   } catch (err) {
//     console.error(`Failed to read local data for ${letter}:`, err?.message);
//     res.status(500).json({ error: "Data unavailable" });
//   }
// });

// app.post("/get-pronunciation", async (req, res) => {
//   await handlePronunciationRequest(req, res, req.body || {});
// });

// app.get("/get-pronunciation", async (req, res) => {
//   await handlePronunciationRequest(req, res, req.query || {});
// });

// // ===== Graceful Shutdown =====
// const shutdown = () => {
//   console.log("Shutting down gracefully...");
//   process.exit(0);
// };

// process.on("SIGTERM", shutdown);
// process.on("SIGINT", shutdown);
// module.exports = app;

// dotenv MUST be loaded before anything that reads process.env at import
// time (like lib/r2.js, which builds the S3Client as soon as it's required).
// Loading it later meant R2's env vars were always undefined when lib/r2.js
// ran, even though .env had them — GOOGLE_APPLICATION_CREDENTIALS only
// "worked" because it's read lazily inside a function, not at import time.
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
const { waitUntil } = require("@vercel/functions");
const { r2, GetObjectCommand, PutObjectCommand } = require("./lib/r2");

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

// ===== Express Setup =====
const app = express();

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
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

// ===== R2 Helpers =====
// Read failures are logged (not just swallowed) so a real misconfig
// (bad bucket name, bad credentials, R2 outage) is visible in logs
// instead of silently looking like "every word is just a cold cache miss."
async function getFromR2(key) {
  try {
    const response = await r2.send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      }),
    );

    const text = await response.Body.transformToString();
    return JSON.parse(text);
  } catch (err) {
    // NoSuchKey is expected on a genuine cache miss — don't log that as an error.
    if (err?.name !== "NoSuchKey") {
      console.warn(`R2 GET failed for key ${key}:`, err?.message || err);
    }
    return null;
  }
}

// Write failures are caught HERE and never thrown to the caller.
// Caching must never be allowed to turn a successful TTS generation
// into a failed user-facing request.
async function saveToR2(key, data) {
  try {
    await r2.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: JSON.stringify(data),
        ContentType: "application/json",
      }),
    );
    return true;
  } catch (err) {
    console.error(`R2 PUT failed for key ${key}:`, err?.message || err);
    return false;
  }
}

const normalizeIsMale = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "male", "m"].includes(normalized)) return true;
    if (["false", "0", "no", "female", "f"].includes(normalized)) return false;
  }
  return true;
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
  const rawWord = String(payload.word || "");
  const accent = String(payload.accent || "en-US");
  const isMale = normalizeIsMale(payload.isMale);
  const speed = String(payload.speed || "normal").toLowerCase();

  if (!rawWord) return res.status(400).json({ error: "Word is required." });
  if (!voiceMap[accent])
    return res.status(400).json({ error: "Invalid accent selected" });

  const word = rawWord.trim().toLowerCase();
  const speakingRate = speedMap[speed] || speedMap.normal;
  const voiceName = isMale ? voiceMap[accent].male : voiceMap[accent].female;
  const cacheKey = getCacheKey(word, accent, isMale ? "male" : "female", speed);
  const r2Key = getR2Key(word, accent, isMale ? "male" : "female", speed);
  const clientEtag = req.headers["if-none-match"];

  // --- Fix #2: check the cheap in-memory cache FIRST. ---
  // Previously R2 was queried unconditionally on every single request,
  // even when the word was already warm in memory. That meant every
  // request paid R2 round-trip latency regardless of whether it was needed,
  // defeating half the point of having a memory cache in front of R2.
  const cachedResponse = cache.get(cacheKey);
  if (cachedResponse) {
    if (clientEtag === cachedResponse.etag) return res.status(304).end();
    res.setHeader("ETag", cachedResponse.etag);
    applyPronunciationCacheHeaders(req, res);
    return res.json(cachedResponse.data);
  }

  // Only hit R2 on a memory-cache miss.
  const r2Response = await getFromR2(r2Key);
  if (r2Response) {
    console.log("R2 CACHE HIT");
    cache.set(cacheKey, r2Response);

    if (clientEtag === r2Response.etag) {
      return res.status(304).end();
    }

    res.setHeader("ETag", r2Response.etag);
    applyPronunciationCacheHeaders(req, res);
    return res.json(r2Response.data);
  }

  try {
    if (inFlightPronunciations.has(cacheKey)) {
      await inFlightPronunciations.get(cacheKey);
      const warmedCache = cache.get(cacheKey);
      if (warmedCache) {
        if (clientEtag === warmedCache.etag) return res.status(304).end();
        res.setHeader("ETag", warmedCache.etag);
        applyPronunciationCacheHeaders(req, res);
        return res.json(warmedCache.data);
      }
    }

    const buildPromise = buildPronunciationResponse({
      word,
      accent,
      isMale,
      speed,
      speakingRate,
      voiceName,
    });
    inFlightPronunciations.set(cacheKey, buildPromise);

    const freshResponse = await buildPromise;
    cache.set(cacheKey, freshResponse);

    // --- Fix #1 (revised): R2 write failures must never fail the request,
    // AND the background write must not get cut off by the platform
    // freezing this function right after the response is sent. A plain
    // unawaited promise risks being silently killed mid-flight on
    // serverless platforms once the handler returns — waitUntil tells
    // Vercel to keep this execution context alive until the save settles,
    // without making the user's response wait for it.
    waitUntil(
      saveToR2(r2Key, freshResponse).catch((err) => {
        console.error(
          `Unexpected R2 save error for ${r2Key}:`,
          err?.message || err,
        );
      }),
    );

    res.setHeader("ETag", freshResponse.etag);
    applyPronunciationCacheHeaders(req, res);
    res.setHeader("Timing-Allow-Origin", "*");
    res.setHeader("Server-Timing", `total;dur=${Date.now() - requestStart}`);
    res.json(freshResponse.data);
  } catch (error) {
    console.error(
      `Error processing ${word}: ${error.message || "Unknown error"}`,
    );
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

    let data = letterCache.get(letter);
    if (!data) {
      const filePath = path.join(__dirname, "data", `${letter}.json`); // ← must be inside here
      const fileContent = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(fileContent);
      data = Array.isArray(parsed)
        ? Object.fromEntries(parsed.map((e) => [e.word, e]))
        : parsed;
      letterCache.set(letter, data);
    }

    const entry = Array.isArray(data)
      ? data.find((e) => e.word === normalized) || null
      : data[normalized] || null;
    if (!entry) return null;

    return {
      us_ipa: entry.us_ipa || entry.us || null,
      uk_ipa: entry.uk_ipa || entry.uk || null,
      // New format fields
      entries: entry.entries || [],
      default_pos: entry.default_pos || null,
      // Old format fallbacks
      synonyms: entry.synonyms || [],
      antonyms: entry.antonyms || [],
      syllables: entry.syllables || [],
    };
  } catch (err) {
    console.warn(`fetchWordData failed for ${word}:`, err?.message);
    return null;
  }
};

// ===== Global Error Handling =====
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

// ===== TEMPORARY DEBUG ROUTE — remove once R2 issue is resolved =====
// Tests raw TLS connectivity to the R2 endpoint with zero AWS SDK
// involvement, to isolate whether the handshake failure is an SDK/signing
// issue or a fundamental network/TLS compatibility problem between
// Vercel and this specific Cloudflare hostname.
app.get("/r2-raw-test", (req, res) => {
  const https = require("https");
  const hostname = `${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

  const options = {
    hostname,
    port: 443,
    path: "/",
    method: "GET",
    timeout: 8000,
  };

  const testReq = https.request(options, (testRes) => {
    let body = "";
    testRes.on("data", (chunk) => (body += chunk));
    testRes.on("end", () => {
      res.json({
        success: true,
        hostname,
        statusCode: testRes.statusCode,
        headers: testRes.headers,
        bodySnippet: body.slice(0, 300),
      });
    });
  });

  testReq.on("error", (err) => {
    res.status(500).json({
      success: false,
      hostname,
      errorCode: err.code,
      errorMessage: err.message,
    });
  });

  testReq.on("timeout", () => {
    testReq.destroy();
    res
      .status(500)
      .json({ success: false, hostname, error: "Request timed out" });
  });

  testReq.end();
});

app.get("/data/:letter.json", async (req, res) => {
  const letter = String(req.params.letter || "").toLowerCase()[0];
  if (!letter || letter < "a" || letter > "z")
    return res.status(400).json({ error: "Invalid letter" });

  try {
    let cachedData = letterCache.get(letter);
    if (cachedData) return res.json(cachedData);

    const filePath = path.join(__dirname, "data", `${letter}.json`);
    const fileContent = await fs.readFile(filePath, "utf-8");
    const data = JSON.parse(fileContent);

    letterCache.set(letter, data);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.json(data);
  } catch (err) {
    console.error(`Failed to read local data for ${letter}:`, err?.message);
    res.status(500).json({ error: "Data unavailable" });
  }
});

app.post("/get-pronunciation", async (req, res) => {
  await handlePronunciationRequest(req, res, req.body || {});
});

app.get("/get-pronunciation", async (req, res) => {
  await handlePronunciationRequest(req, res, req.query || {});
});

// ===== Graceful Shutdown =====
const shutdown = () => {
  console.log("Shutting down gracefully...");
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
module.exports = app;
