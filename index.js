const express = require("express");
const bodyParser = require("body-parser");
const textToSpeech = require("@google-cloud/text-to-speech");
const cors = require("cors");
const NodeCache = require("node-cache");
const axios = require("axios");
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

const DATA_BASE_URL = "https://dictionary-gamma-tan.vercel.app/data/";

// ===== Express Setup =====
const app = express();

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
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
  })
);

app.use(
  bodyParser.json({
    limit: "10kb",
    strict: true,
  })
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
  })
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

const getCacheKey = (word, accent, voice, speed) =>
  `${word.toLowerCase()}_${accent}_${voice}_${speed}`;

// ===== Fetch Word Data =====
const fetchWordData = async (word) => {
  if (!word) return null;
  try {
    const normalized = String(word).trim().toLowerCase();
    const letter = normalized[0];
    if (!letter || letter < "a" || letter > "z") return null;

    let data = letterCache.get(letter);
    if (!data) {
      const url = `${DATA_BASE_URL}${letter}.json`;
      const response = await axios.get(url, {
        timeout: 5000,
        responseType: "json",
      });
      data = response.data || {};
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
    };
  } catch (err) {
    console.warn(`fetchWordData failed for ${word}:`, err?.message);
    return null;
  }
};

// ===== Global Error Handling =====
process.on("uncaughtException", (error) =>
  console.error("Uncaught Exception:", error)
);
process.on("unhandledRejection", (reason, promise) =>
  console.error("Unhandled Rejection at:", promise, "reason:", reason)
);

// ===== Routes =====
app.get("/", (_, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send("Express on Vercel - Pronunciation API");
});

app.get("/health", (_, res) => {
  res.status(200).json({ status: "ok", timestamp: Date.now() });
});

app.get("/data/:letter.json", async (req, res) => {
  const letter = String(req.params.letter || "").toLowerCase()[0];
  if (!letter || letter < "a" || letter > "z")
    return res.status(400).json({ error: "Invalid letter" });
  try {
    const cachedData = letterCache.get(letter);
    if (cachedData) return res.json(cachedData);

    const url = `${DATA_BASE_URL}${letter}.json`;
    const response = await axios.get(url, { timeout: 5000 });
    letterCache.set(letter, response.data);
    res.type("application/json").status(200).send(response.data);
  } catch (err) {
    console.error(`Failed to proxy data for ${letter}:`, err?.message);
    res.status(502).json({ error: "Upstream data unavailable" });
  }
});

app.post("/get-pronunciation", async (req, res) => {
  const requestStart = Date.now();
  const {
    word: rawWord = "",
    accent = "en-US",
    isMale = true,
    speed = "normal",
  } = req.body;

  if (!rawWord) return res.status(400).json({ error: "Word is required." });
  if (!voiceMap[accent])
    return res.status(400).json({ error: "Invalid accent selected" });

  const word = rawWord.trim().toLowerCase();
  const speedMap = { slow: 0.6, normal: 0.9, fast: 1.2 };
  const speakingRate = speedMap[speed] || speedMap.normal;
  const voiceName = isMale ? voiceMap[accent].male : voiceMap[accent].female;

  const cacheKey = getCacheKey(word, accent, isMale ? "male" : "female", speed);
  const cachedResponse = cache.get(cacheKey);
  const clientEtag = req.headers["if-none-match"];

  if (cachedResponse && clientEtag === cachedResponse.etag)
    return res.status(304).end();
  if (cachedResponse) {
    res.setHeader("ETag", cachedResponse.etag);
    res.setHeader("Cache-Control", "private, max-age=604800");
    return res.json(cachedResponse.data);
  }

  try {
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
      audioMetadata: { format: "mp3", accent, voice: voiceName, speed },
    };

    const responseETag = etag(word + accent + (isMale ? "m" : "f") + speed);
    cache.set(cacheKey, {
      data: responseData,
      etag: responseETag,
      timestamp: Date.now(),
    });

    res.setHeader("ETag", responseETag);
    res.setHeader("Cache-Control", "private, max-age=604800");
    res.setHeader("Timing-Allow-Origin", "*");
    res.setHeader("Server-Timing", `total;dur=${Date.now() - requestStart}`);
    res.json(responseData);
  } catch (error) {
    console.error(
      `Error processing ${word}: ${error.message || "Unknown error"}`
    );
    res.status(500).json({
      error: "Error processing pronunciation request",
      suggestion: "Please try again in a moment",
      word,
    });
  }
});

// ===== Graceful Shutdown =====
const shutdown = () => {
  console.log("Shutting down gracefully...");
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

module.exports = app;
