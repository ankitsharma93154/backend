const express = require("express");
const bodyParser = require("body-parser");
const textToSpeech = require("@google-cloud/text-to-speech");
const cors = require("cors");
const NodeCache = require("node-cache");
const axios = require("axios");
const compression = require("compression");
const etag = require("etag");
const { promisify } = require("util");
const helmet = require("helmet"); // Add security headers
const cluster = require("cluster");
const numCPUs = require("os").cpus().length;

// Enhanced cache configuration with optimized TTL values
const cache = new NodeCache({
  stdTTL: 604800, // 7 days for better hit rate
  checkperiod: 7200, // Check for expired keys every 2 hours
  maxKeys: 10000, // Increased cache size
  useClones: false, // Disable cloning for better performance
  deleteOnExpire: true, // Free memory as soon as items expire
});

// New: Fetch word data from hosted a-z JSON files
const DATA_BASE_URL = "https://dictionary-gamma-tan.vercel.app/data/";
const wordDataCache = new NodeCache({
  stdTTL: 2592000,
  checkperiod: 86400,
  useClones: false,
  deleteOnExpire: true,
});

async function fetchWordData(word) {
  if (!word || typeof word !== "string" || word.length === 0) return null;
  const firstLetter = word[0].toLowerCase();
  const cacheKey = `data_${firstLetter}`;
  let data = wordDataCache.get(cacheKey);
  if (!data) {
    try {
      const url = `${DATA_BASE_URL}${firstLetter}.json`;
      const response = await axios.get(url, { timeout: 4000 });
      data = response.data;
      wordDataCache.set(cacheKey, data);
    } catch (e) {
      console.error(`Failed to fetch data for ${firstLetter}:`, e.message);
      return null;
    }
  }
  return data[word.toLowerCase()] || null;
}

// Initialize Express app with security and performance enhancements
const app = express();

// Add helmet for security headers
app.use(
  helmet({
    contentSecurityPolicy: false, // Customize as needed
    crossOriginEmbedderPolicy: false,
  })
);

// Enhanced CORS configuration
app.use(
  cors({
    origin: true, // Can be replaced with specific domains
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400, // Cache preflight requests for 24 hours
  })
);

// Optimized compression settings
app.use(
  compression({
    level: 6,
    threshold: 1024, // Only compress responses larger than 1KB
    filter: (req, res) => {
      const contentType = res.getHeader("Content-Type") || "";
      // Skip compression for audio files as they're already compressed
      if (contentType.includes("audio")) return false;
      // Use standard filter for everything else
      return compression.filter(req, res);
    },
  })
);

// Optimized JSON parser
app.use(
  bodyParser.json({
    limit: "10kb", // Reduced limit for security
    strict: true,
  })
);

// Load environment variables
require("dotenv").config();

// Enhanced static file serving with optimized caching
app.use(
  express.static("public", {
    maxAge: "1y",
    etag: true,
    lastModified: true,
    immutable: true,
    setHeaders: (res, path) => {
      // Add cache control headers based on file type
      if (path.endsWith(".html")) {
        // HTML files should be revalidated more frequently
        res.setHeader("Cache-Control", "public, max-age=3600"); // 1 hour
      } else if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg)$/)) {
        // Static assets can be cached longer
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  })
);

// Add global response time tracking middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (duration > 500) {
      // Log slow requests
      console.warn(`Slow request: ${req.method} ${req.url} took ${duration}ms`);
    }
  });
  next();
});

// Singleton TTS client with connection pooling
const { GoogleAuth } = require("google-auth-library");
let ttsClient = null;

// Lazy initialize TTS client
const getTtsClient = () => {
  if (!ttsClient) {
    const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    ttsClient = new textToSpeech.TextToSpeechClient({
      auth: new GoogleAuth({
        credentials,
        scopes: "https://www.googleapis.com/auth/cloud-platform",
        // Improved connection pooling
        poolSize: 10,
        keepAlive: true,
        keepAliveMsecs: 30000,
      }),
    });
  }
  return ttsClient;
};

// Optimized cache key generation with string concatenation
const getCacheKey = (word, accent, voice) =>
  word.toLowerCase() + "_" + accent + "_" + voice;

// Predefined voice map with optimized structure
const voiceMap = {
  "en-US": { male: "en-US-Wavenet-D", female: "en-US-Wavenet-F" },
  "en-GB": { male: "en-GB-Wavenet-D", female: "en-GB-Wavenet-F" },
  "en-AU": { male: "en-AU-Wavenet-B", female: "en-AU-Wavenet-C" },
  "en-IN": { male: "en-IN-Wavenet-C", female: "en-IN-Wavenet-D" },
};

// Add global error handling for uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  // Keep process alive
});

// Add global promise rejection handling
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Keep process alive
});

// Root route with health check and caching
app.get("/", (_, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send("Express on Vercel - Pronunciation API");
});

// Health check endpoint
app.get("/health", (_, res) => {
  res.status(200).json({ status: "ok", timestamp: Date.now() });
});

// Serve per-letter JSON through our server with strong caching headers
app.get("/data/:letter.json", async (req, res) => {
  const letter = String(req.params.letter || "").toLowerCase()[0];
  if (!letter || letter < "a" || letter > "z") {
    return res.status(400).json({ error: "Invalid letter" });
  }
  const cacheKey = `data_${letter}`;
  let data = wordDataCache.get(cacheKey);
  if (!data) {
    try {
      const url = `${DATA_BASE_URL}${letter}.json`;
      const response = await axios.get(url, { timeout: 5000 });
      data = response.data;
      wordDataCache.set(cacheKey, data);
    } catch (err) {
      console.error(`Failed to proxy data for ${letter}:`, err.message || err);
      return res.status(502).json({ error: "Upstream data unavailable" });
    }
  }

  try {
    // Serialize deterministically and compute ETag so clients can do conditional GETs
    const body = JSON.stringify(data);
    const responseETag = etag(body);
    const clientEtag = req.headers["if-none-match"];
    if (clientEtag && clientEtag === responseETag) {
      // Not modified
      res.status(304).end();
      return;
    }

    // Strong cache-control for these static JSON files
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Vary", "Accept-Encoding");
    res.setHeader("ETag", responseETag);
    res.type("application/json");
    return res.send(body);
  } catch (err) {
    console.error("Error serializing data for", letter, err && err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Endpoint to force reload of phonetic transcriptions
app.get("/reload-phonetics", async (_, res) => {
  // Reset the promise to force a fresh load
  phoneticLoadPromise = null;
  const success = await loadPhoneticTranscriptions();

  if (success) {
    res.json({
      status: "success",
      message: "Phonetic transcriptions reloaded",
    });
  } else {
    res.status(500).json({
      status: "error",
      message: "Failed to reload phonetic transcriptions",
    });
  }
});

// Optimized pronunciation route with streaming capability

app.post("/get-pronunciation", async (req, res) => {
  const requestStart = Date.now();
  const {
    word: rawWord = "",
    accent = "en-US",
    isMale = true,
    speed = "normal",
  } = req.body;

  if (!rawWord) {
    return res.status(400).json({ error: "Word is required." });
  }
  const word = rawWord.trim().toLowerCase();
  if (!voiceMap[accent]) {
    return res.status(400).json({ error: "Invalid accent selected" });
  }
  const speedMap = { slow: 0.6, normal: 0.9, fast: 1.2 };
  const speakingRate = speedMap[speed] || speedMap.normal;
  const voiceName = isMale ? voiceMap[accent].male : voiceMap[accent].female;
  const cacheKey =
    getCacheKey(word, accent, isMale ? "male" : "female") + `_${speed}`;
  const cachedResponse = cache.get(cacheKey);
  const clientEtag = req.headers["if-none-match"];
  if (cachedResponse && clientEtag === cachedResponse.etag) {
    return res.status(304).end();
  }
  if (cachedResponse) {
    res.setHeader("ETag", cachedResponse.etag);
    res.setHeader("Cache-Control", "private, max-age=604800");
    return res.json(cachedResponse.data);
  }
  try {
    // Fetch word data from hosted JSON
    const wordData = await fetchWordData(word);
    // Always generate audio, even if wordData is null
    const ttsRequestObj = {
      input: { text: word },
      voice: { languageCode: accent, name: voiceName },
      audioConfig: {
        audioEncoding: "MP3",
        speakingRate: speakingRate,
        pitch: 0,
        volumeGainDb: 1,
      },
    };
    const ttsResponse = await getTtsClient().synthesizeSpeech(ttsRequestObj);
    const base64Audio = ttsResponse[0].audioContent.toString("base64");
    // Build response, fallback to empty/defaults if not found
    const responseData = {
      audioContent: base64Audio,
      phonetic: wordData
        ? accent === "en-GB"
          ? wordData.uk_ipa
          : wordData.us_ipa
        : null,
      meanings: wordData && wordData.meanings ? wordData.meanings : [],
      examples:
        wordData && wordData.examples
          ? wordData.examples.map((ex) => ({ text: ex, partOfSpeech: "" }))
          : [],
      synonyms: wordData && wordData.synonyms ? wordData.synonyms : [],
      antonyms: wordData && wordData.antonyms ? wordData.antonyms : [],
      audioMetadata: {
        format: "mp3",
        accent: accent,
        voice: voiceName,
        speed: speed,
      },
    };
    const responseETag = etag(word + accent + (isMale ? "m" : "f"));
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
      word: word,
    });
  }
});

// Add graceful shutdown
const shutdown = () => {
  console.log("Shutting down gracefully...");
  // Close any open connections
  if (ttsClient) {
    // ttsClient connection cleanup if supported
  }
  process.exit(0);
};

// Listen for termination signals
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Expose app for serverless environments
module.exports = app;

// Start server if not in serverless environment
// if (
//   process.env.NODE_ENV !== "production" ||
//   process.env.START_SERVER === "true"
// ) {
//   const PORT = process.env.PORT || 3000;
//   app.listen(PORT, () => {
//     console.log(`Server running on port ${PORT}`);
//     // Start loading phonetic data in background
//     loadPhoneticTranscriptions();
//   });
// }
