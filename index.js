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

// Function to get the correct phonetic key based on accent
const getCountryCode = (accent) => {
  const mapping = {
    "en-US": "US",
    "en-GB": "UK",
    "en-AU": "UK", // Use UK phonetics for AU
    "en-IN": "US", // Use US phonetics for IN
  };
  return mapping[accent] || null;
};

// Hosted JSON file URL
const PHONETIC_JSON_URL =
  "https://phonetic-transcriptions.vercel.app/ipa_transcriptions.min.json";

// Cache phonetic data globally
let phoneticCache = null;

// Function to fetch phonetic JSON once
const fetchPhoneticJson = async () => {
  try {
    if (!phoneticCache) {
      console.log("Fetching phonetic JSON...");
      const response = await axios.get(PHONETIC_JSON_URL);
      phoneticCache = response.data;
    }
  } catch (error) {
    console.error("Error fetching phonetic JSON:", error.message);
    phoneticCache = {};
  }
};

// Fetch phonetic transcription from hosted JSON
const getPhoneticFromJson = async (word, accent) => {
  try {
    await fetchPhoneticJson(); // Ensure JSON is fetched before accessing
    const countryCode = getCountryCode(accent);
    if (!countryCode) return null;

    const phonetics = phoneticCache[word]?.[countryCode];

    phonetics = phonetics.split(",")[0].trim();

    return phonetics || null;
  } catch (error) {
    console.error("Error fetching phonetic from JSON:", error);
    return null;
  }
};

// Create an axios instance with optimized settings
const dictionaryApi = axios.create({
  baseURL: "https://api.dictionaryapi.dev/api/v2/entries/en",
  timeout: 2500, // Reduced timeout for faster response
  headers: { "Accept-Encoding": "gzip,deflate" }, // Request compressed responses
  maxRedirects: 2, // Limit redirects
});

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

    // Try fetching phonetic transcription from JSON
    const phonetic = await getPhoneticFromJson(word, accent);
    // phonetic = wordData.phonetic || null;

    // If not found in JSON, fallback to Dictionary API
    if (!phonetic) {
      phonetic = wordData.phonetic || "Phonetic transcription not available.";
    }

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
    const [wordDetails, ttsResponse] = await Promise.all([
      getWordDetails(word),
      client.synthesizeSpeech(ttsRequestObj),
    ]);

    const { phonetic, meanings, examples } = wordDetails;

    // Direct base64 conversion
    const base64Audio = ttsResponse[0].audioContent.toString("base64");

    // Create response data once
    const responseData = {
      audioContent: base64Audio,
      phonetic: phonetic || "Phonetic transcription not available.",
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

// Fetch phonetic JSON on startup
fetchPhoneticJson();

module.exports = app;
