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

require("dotenv").config();

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
    meanings: wordData?.meanings ?? [],
    examples:
      wordData?.examples?.map((ex) => ({ text: ex, partOfSpeech: "" })) ?? [],
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
  const clientEtag = req.headers["if-none-match"];

  const cachedResponse = cache.get(cacheKey);
  if (cachedResponse && clientEtag === cachedResponse.etag)
    return res.status(304).end();
  if (cachedResponse) {
    res.setHeader("ETag", cachedResponse.etag);
    applyPronunciationCacheHeaders(req, res);
    return res.json(cachedResponse.data);
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
      // Read from local data folder
      const filePath = path.join(__dirname, "data", `${letter}.json`);
      const fileContent = await fs.readFile(filePath, "utf-8");
      data = JSON.parse(fileContent);
      letterCache.set(letter, data);
    }

    const entry = data[normalized] || null;
    if (!entry) return null;

    return {
      us_ipa: entry.us_ipa || entry.us || null,
      uk_ipa: entry.uk_ipa || entry.uk || null,
      meanings: entry.meanings || [],
      examples: entry.examples || [],
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

// ===== Serve local JSON instead of remote URL =====
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
    res.setHeader("Cache-Control", "public, max-age=86400"); // 1 day
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
