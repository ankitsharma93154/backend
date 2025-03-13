const express = require("express");
const bodyParser = require("body-parser");
const textToSpeech = require("@google-cloud/text-to-speech");
const cors = require("cors");
const NodeCache = require("node-cache");
const axios = require("axios");
const compression = require("compression");
const etag = require("etag");

// Create cache instance with increased TTL for better hit rate
const cache = new NodeCache({
  stdTTL: 86400, // Increased to 24 hours for better cache utilization
  checkperiod: 3600, // Check for expired keys every hour
  maxKeys: 5000, // Increased cache size
  useClones: false, // Disable cloning for better performance
});

// Initialize phonetic transcriptions cache
let phoneticTranscriptions = null;
const PHONETIC_JSON_URL =
  "https://phonetic-transcriptions.vercel.app/ipa_transcriptions.min.json";

// Function to load phonetic transcriptions
const loadPhoneticTranscriptions = async () => {
  try {
    const response = await axios.get(PHONETIC_JSON_URL, {
      headers: { "Accept-Encoding": "gzip,deflate" },
      timeout: 5000,
    });

    if (response.data) {
      phoneticTranscriptions = response.data;
      console.log("Phonetic transcriptions loaded successfully");
      return true;
    }
    return false;
  } catch (error) {
    console.error(
      "Error loading phonetic transcriptions:",
      error.message || error
    );
    return false;
  }
};

// Load phonetic data on startup
loadPhoneticTranscriptions().then((success) => {
  if (!success) {
    console.warn(
      "Failed to load initial phonetic transcriptions. Will retry when needed."
    );
  }
});

// Initialize Express app
const app = express();
app.use(cors());
app.use(compression({ level: 6 })); // Optimize compression level
app.use(bodyParser.json({ limit: "1mb" })); // Limit payload size
require("dotenv").config();
app.use(
  express.static("public", {
    maxAge: "1y",
    etag: false,
    immutable: true, // Add immutable flag for better caching
  })
);

// Creates a client with connection pooling
const { GoogleAuth } = require("google-auth-library");
const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
const client = new textToSpeech.TextToSpeechClient({
  auth: new GoogleAuth({
    credentials,
    scopes: "https://www.googleapis.com/auth/cloud-platform",
    // Add connection pooling
    poolSize: 5,
    keepAlive: true,
    keepAliveMsecs: 3000,
  }),
});

// Optimize cache key generation
const getCacheKey = (word, accent, voice) =>
  `${word.toLowerCase()}_${accent}_${voice}`;

//Predefine voiceMap with optimized object structure
const voiceMap = {
  "en-US": { male: "en-US-Wavenet-D", female: "en-US-Wavenet-F" },
  "en-GB": { male: "en-GB-Wavenet-D", female: "en-GB-Wavenet-F" },
  "en-AU": { male: "en-AU-Wavenet-B", female: "en-AU-Wavenet-C" },
  "en-IN": { male: "en-IN-Wavenet-C", female: "en-IN-Wavenet-D" },
};

// Create an axios instance with optimized settings
const dictionaryApi = axios.create({
  baseURL: "https://api.dictionaryapi.dev/api/v2/entries/en",
  timeout: 2500, // Reduced timeout for faster response
  headers: { "Accept-Encoding": "gzip,deflate" }, // Request compressed responses
  maxRedirects: 2, // Limit redirects
});

// Get phonetic transcription from JSON data
const getPhoneticFromJSON = (word) => {
  if (!phoneticTranscriptions) return null;

  // Normalize word to lowercase
  const normalizedWord = word.toLowerCase();

  // Check if word exists in our JSON data
  if (phoneticTranscriptions[normalizedWord]) {
    return {
      UK: phoneticTranscriptions[normalizedWord].UK || null,
      US: phoneticTranscriptions[normalizedWord].US || null,
    };
  }

  return null;
};

// Optimized word details function with example sentences
const getWordDetails = async (word) => {
  try {
    const response = await dictionaryApi.get(`/${word}`);

    if (!response.data || !response.data[0]) {
      return {
        phonetic: null,
        meanings: ["No details available"],
        examples: [],
      };
    }

    const wordData = response.data[0];
    console.log("Word data:", wordData);
    const phonetic = wordData.phonetic || null;

    // Fast array population with early returns
    const meanings = [];
    const examples = [];

    if (wordData.meanings && wordData.meanings.length > 0) {
      // Get adjectives first (faster than filtering twice)
      const allMeanings = wordData.meanings;
      const adjectives = [];
      const others = [];

      for (const m of allMeanings) {
        if (m.partOfSpeech === "adjective") {
          adjectives.push(m);
        } else {
          others.push(m);
        }
      }

      // Combine sorted meanings
      const sortedMeanings = [...adjectives, ...others];

      // Faster loop for gathering definitions and examples
      for (const meaning of sortedMeanings) {
        if (meanings.length >= 3 && examples.length >= 3) break; // Early exit if we have enough of both

        for (const def of meaning.definitions) {
          if (meanings.length < 3) {
            meanings.push(def.definition);
          }

          // Extract example if available and we need more
          if (examples.length < 3 && def.example) {
            examples.push({
              text: def.example,
              partOfSpeech: meaning.partOfSpeech,
            });
          }
        }
      }
    }

    return {
      phonetic,
      meanings: meanings.length > 0 ? meanings : ["No details available"],
      examples: examples.length > 0 ? examples : [],
    };
  } catch (error) {
    console.error("Dictionary API error:", error.code || error.message);
    return {
      phonetic: null,
      meanings: [
        "Definition service unavailable. This might be a name. Try another word.",
      ],
      examples: [],
    };
  }
};

// Root route with minimal processing
app.get("/", (_, res) => res.send("Express on Vercel"));

// Endpoint to force reload of phonetic transcriptions
app.get("/reload-phonetics", async (_, res) => {
  const success = await loadPhoneticTranscriptions();
  if (success) {
    res.json({
      status: "success",
      message: "Phonetic transcriptions reloaded",
    });
  } else {
    res
      .status(500)
      .json({
        status: "error",
        message: "Failed to reload phonetic transcriptions",
      });
  }
});

// Optimized pronunciation route
app.post("/get-pronunciation", async (req, res) => {
  // Destructure and validate in one step
  const { word: rawWord, accent, isMale } = req.body;

  if (!rawWord) {
    return res.status(400).json({ error: "Word is required." });
  }

  // Trim once and reuse
  const word = rawWord.trim().toLowerCase();

  // Fast validation
  const accentConfig = voiceMap[accent];
  if (!accentConfig) {
    return res.status(400).json({ error: "Invalid accent selected" });
  }

  // Get voice directly
  const voiceName = isMale ? accentConfig.male : accentConfig.female;

  // Check cache with efficient key generation
  const cacheKey = getCacheKey(word, accent, isMale ? "male" : "female");
  const cachedResponse = cache.get(cacheKey);

  if (cachedResponse) {
    // Set ETag without stringify for better performance
    res.setHeader("ETag", cachedResponse.etag || etag(word + accent));
    return res.json(cachedResponse.data);
  }

  try {
    // Ensure phonetic data is loaded
    if (!phoneticTranscriptions) {
      await loadPhoneticTranscriptions();
    }

    // Check if the word exists in our JSON file first for phonetic transcription
    let phoneticTranscription = null;
    const jsonPhonetic = getPhoneticFromJSON(word);

    if (jsonPhonetic) {
      // Map API accent codes to JSON accent keys
      const accentKey = accent.startsWith("en-US") ? "US" : "UK";
      if (jsonPhonetic[accentKey]) {
        phoneticTranscription = jsonPhonetic[accentKey];
      }
    }

    // Prepare request objects before Promise.all for better performance
    const ttsRequestObj = {
      input: { text: word },
      voice: { languageCode: accent, name: voiceName },
      audioConfig: {
        audioEncoding: "MP3",
        speakingRate: 1.0,
      },
    };

    // Run API calls in parallel with Promise.all
    // Always get definitions from the API, but maybe use our JSON for phonetics
    const [wordDetails, ttsResponse] = await Promise.all([
      getWordDetails(word),
      client.synthesizeSpeech(ttsRequestObj),
    ]);

    // If we didn't find phonetic in our JSON, use the one from the API
    if (!phoneticTranscription) {
      phoneticTranscription = wordDetails.phonetic;
    }

    const { meanings, examples } = wordDetails;

    // Direct base64 conversion
    const base64Audio = ttsResponse[0].audioContent.toString("base64");

    // Create response data once
    const responseData = {
      audioContent: base64Audio,
      phonetic:
        phoneticTranscription || "Phonetic transcription not available.",
      meanings: meanings.slice(0, 3),
      examples: examples.slice(0, 3),
    };

    // Generate ETag only once
    const responseETag = etag(word + accent);

    // Store both data and etag in cache to avoid regenerating etag
    cache.set(cacheKey, { data: responseData, etag: responseETag });

    // Set header and send response
    res.setHeader("ETag", responseETag);
    res.json(responseData);
  } catch (error) {
    console.error("Error:", error.message || error);
    res.status(500).json({
      error: "Error processing pronunciation request",
      details: error.message || "Unknown error",
    });
  }
});

module.exports = app;
