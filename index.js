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

// Only proceed with cluster if in production environment
if (process.env.NODE_ENV === "production" && cluster.isMaster) {
  console.log(`Master ${process.pid} is running`);

  // Fork workers
  for (let i = 0; i < Math.min(numCPUs, 4); i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker) => {
    console.log(`Worker ${worker.process.pid} died, spawning a new one`);
    cluster.fork();
  });
} else {
  // Enhanced cache configuration with optimized TTL values
  const cache = new NodeCache({
    stdTTL: 604800, // 7 days for better hit rate
    checkperiod: 7200, // Check for expired keys every 2 hours
    maxKeys: 10000, // Increased cache size
    useClones: false, // Disable cloning for better performance
    deleteOnExpire: true, // Free memory as soon as items expire
  });

  // Dedicated phonetic cache with longer TTL
  const phoneticCache = new NodeCache({
    stdTTL: 2592000, // 30 days since phonetic data rarely changes
    checkperiod: 86400, // Check daily
    useClones: false,
    deleteOnExpire: true,
  });

  // Initialize phonetic transcriptions with lazy loading
  let phoneticTranscriptions = null;
  let phoneticLoadPromise = null;
  const PHONETIC_JSON_URL =
    "https://phonetic-transcriptions.vercel.app/ipa_transcriptions.min.json";

  // Lazy load function with promise caching to prevent multiple simultaneous loads
  const loadPhoneticTranscriptions = async () => {
    // Return existing promise if already loading
    if (phoneticLoadPromise) {
      return phoneticLoadPromise;
    }

    // Create new loading promise
    phoneticLoadPromise = new Promise(async (resolve) => {
      try {
        console.log("Loading phonetic transcriptions...");
        const response = await axios.get(PHONETIC_JSON_URL, {
          headers: {
            "Accept-Encoding": "gzip,deflate",
            "User-Agent": "pronunciation-app/1.0",
          },
          timeout: 4000,
          decompress: true,
        });

        if (response.data) {
          // Process the data once during load to optimize lookup
          const rawData = response.data;
          const processed = {};

          // Pre-process transcriptions with optimized structure
          for (const word in rawData) {
            processed[word] = {
              US: rawData[word].us_ipa || null,
              UK: rawData[word].uk_ipa || null,
              examples: (rawData[word].examples || []).slice(0, 3), // Only keep top 3 examples
            };
          }

          phoneticTranscriptions = processed;
          console.log("Phonetic transcriptions loaded successfully");
          resolve(true);
        } else {
          console.warn("Empty response when loading phonetic data");
          resolve(false);
        }
      } catch (error) {
        console.error(
          "Error loading phonetic transcriptions:",
          error.message || error
        );
        resolve(false);
      } finally {
        // Clear the promise after 5 minutes to allow future reload attempts
        setTimeout(() => {
          phoneticLoadPromise = null;
        }, 300000);
      }
    });

    return phoneticLoadPromise;
  };

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
        console.warn(
          `Slow request: ${req.method} ${req.url} took ${duration}ms`
        );
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
      const credentials = JSON.parse(
        process.env.GOOGLE_APPLICATION_CREDENTIALS
      );
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

  // Map to determine which phonetic transcription to use (US or UK) based on accent
  const accentToPhoneticMap = {
    "en-US": "US",
    "en-GB": "UK",
    "en-AU": "US", // Australian uses US phonetics
    "en-IN": "UK", // Indian uses UK phonetics
  };

  // Create an axios instance with optimized settings
  const dictionaryApi = axios.create({
    baseURL: "https://api.dictionaryapi.dev/api/v2/entries/en",
    timeout: 2000, // Reduced timeout for faster response
    headers: {
      "Accept-Encoding": "gzip,deflate",
      Accept: "application/json",
      "User-Agent": "pronunciation-app/1.0",
    },
    maxRedirects: 1, // Limit redirects
    validateStatus: (status) => status < 500, // Accept any status < 500
    responseType: "json",
    transitional: {
      clarifyTimeoutError: true,
    },
  });

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

  // Get phonetic transcription from JSON data with optimized lookup
  const getPhoneticFromJSON = (word, accent) => {
    // Normalize word to lowercase once
    const normalizedWord = word.toLowerCase();

    // Check cache first with combined key
    const cacheKey = normalizedWord + "_" + accent;
    const cachedPhonetic = phoneticCache.get(cacheKey);
    if (cachedPhonetic !== undefined) {
      return cachedPhonetic;
    }

    // If not in cache and no phonetic data loaded, return empty result
    if (!phoneticTranscriptions) {
      return { phonetic: null, examples: [] };
    }

    // Get the appropriate transcription based on accent mapping
    const accentKey = accentToPhoneticMap[accent] || "US";

    // Direct lookup with fallback
    const wordData = phoneticTranscriptions[normalizedWord];
    const result = wordData
      ? {
          phonetic: wordData[accentKey] || null,
          examples: wordData.examples || [],
        }
      : { phonetic: null, examples: [] };

    // Cache the result
    phoneticCache.set(cacheKey, result);

    return result;
  };

  // Optimized word details function with reduced API calls
  const getWordDetails = async (word) => {
    try {
      const response = await dictionaryApi.get(
        `/${encodeURIComponent(word.toLowerCase())}`
      );

      // Handle empty or error responses quickly
      if (!response.data || !response.data[0]) {
        return {
          phonetic: null,
          meanings: ["No details available"],
          examples: [],
        };
      }

      const wordData = response.data[0];
      const phonetic = wordData.phonetic || null;

      // Optimized meaning extraction with preallocated arrays
      const meanings = [];
      const examples = [];

      if (wordData.meanings && wordData.meanings.length > 0) {
        // Sort meanings to prioritize adjectives (better example sentences)
        const sortedMeanings = [...wordData.meanings].sort((a, b) =>
          a.partOfSpeech === "adjective"
            ? -1
            : b.partOfSpeech === "adjective"
            ? 1
            : 0
        );

        // Single loop for better performance
        for (
          let i = 0;
          i < sortedMeanings.length &&
          (meanings.length < 3 || examples.length < 3);
          i++
        ) {
          const meaning = sortedMeanings[i];
          const definitions = meaning.definitions || [];

          for (
            let j = 0;
            j < definitions.length &&
            (meanings.length < 3 || examples.length < 3);
            j++
          ) {
            const def = definitions[j];

            // Add definition if needed
            if (meanings.length < 3 && def.definition) {
              meanings.push(def.definition);
            }

            // Add example if needed
            if (examples.length < 3 && def.example) {
              examples.push({
                text: def.example,
                partOfSpeech: meaning.partOfSpeech,
              });
            }

            // Early break if we have all we need
            if (meanings.length >= 3 && examples.length >= 3) break;
          }
        }
      }

      return {
        phonetic,
        meanings: meanings.length > 0 ? meanings : ["No details available"],
        examples: examples.length > 0 ? examples : [],
      };
    } catch (error) {
      // Simplified error handling with less logging
      console.error(
        `Dictionary API error for ${word}: ${error.code || error.message}`
      );
      return {
        phonetic: null,
        meanings: ["Definition service unavailable."],
        examples: [],
      };
    }
  };

  // Root route with health check and caching
  app.get("/", (_, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send("Express on Vercel - Pronunciation API");
  });

  // Health check endpoint
  app.get("/health", (_, res) => {
    res.status(200).json({ status: "ok", timestamp: Date.now() });
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
    // Start request timer
    const requestStart = Date.now();

    // Destructure with defaults
    const { word: rawWord = "", accent = "en-US", isMale = true } = req.body;

    if (!rawWord) {
      return res.status(400).json({ error: "Word is required." });
    }

    // Process once
    const word = rawWord.trim().toLowerCase();

    // Validate accent quickly
    if (!voiceMap[accent]) {
      return res.status(400).json({ error: "Invalid accent selected" });
    }

    // Get voice directly
    const voiceName = isMale ? voiceMap[accent].male : voiceMap[accent].female;

    // Check cache with efficient key
    const cacheKey = getCacheKey(word, accent, isMale ? "male" : "female");
    const cachedResponse = cache.get(cacheKey);

    // If client sent If-None-Match and it matches our ETag, return 304
    const clientEtag = req.headers["if-none-match"];
    if (cachedResponse && clientEtag === cachedResponse.etag) {
      return res.status(304).end();
    }

    // Return cached response if available
    if (cachedResponse) {
      res.setHeader("ETag", cachedResponse.etag);
      res.setHeader("Cache-Control", "private, max-age=604800"); // 7 days
      return res.json(cachedResponse.data);
    }

    try {
      // Lazy load phonetic data if needed
      if (!phoneticTranscriptions) {
        await loadPhoneticTranscriptions();
      }

      // Direct data lookup
      const phoneticData = getPhoneticFromJSON(word, accent);

      // Prepare TTS request before Promise.all
      const ttsRequestObj = {
        input: { text: word },
        voice: { languageCode: accent, name: voiceName },
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate: 0.9, // Slightly slower for better pronunciation
          pitch: 0,
          volumeGainDb: 1,
        },
      };

      // Parallel requests for better performance
      const [wordDetails, ttsResponse] = await Promise.all([
        getWordDetails(word),
        getTtsClient().synthesizeSpeech(ttsRequestObj),
      ]);

      // Process results
      const finalPhonetic = phoneticData.phonetic || wordDetails.phonetic;

      // Prefer our curated examples
      const finalExamples =
        phoneticData.examples.length > 0
          ? phoneticData.examples.slice(0, 3).map((example) => ({
              text: example,
              partOfSpeech: "",
            }))
          : wordDetails.examples.slice(0, 3);

      // Always use API meanings when available
      const finalMeanings = wordDetails.meanings.slice(0, 3);

      // Direct base64 conversion
      const base64Audio = ttsResponse[0].audioContent.toString("base64");

      // Build response once
      const responseData = {
        audioContent: base64Audio,
        phonetic: finalPhonetic || "Phonetic transcription not available.",
        meanings: finalMeanings,
        examples: finalExamples,
        // Include audio metadata for better caching
        audioMetadata: {
          format: "mp3",
          accent: accent,
          voice: voiceName,
        },
      };

      // Generate ETag
      const responseETag = etag(word + accent + (isMale ? "m" : "f"));

      // Store in cache with metadata
      cache.set(cacheKey, {
        data: responseData,
        etag: responseETag,
        timestamp: Date.now(),
      });

      // Set response headers
      res.setHeader("ETag", responseETag);
      res.setHeader("Cache-Control", "private, max-age=604800"); // 7 days
      res.setHeader("Timing-Allow-Origin", "*");
      res.setHeader("Server-Timing", `total;dur=${Date.now() - requestStart}`);

      // Send the response
      res.json(responseData);
    } catch (error) {
      console.error(
        `Error processing ${word}: ${error.message || "Unknown error"}`
      );

      // Return a helpful error with suggestion
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
}
