const express = require("express");
const bodyParser = require("body-parser");
const textToSpeech = require("@google-cloud/text-to-speech");
const cors = require("cors");
const NodeCache = require("node-cache");
const axios = require("axios");
const compression = require("compression");
const etag = require("etag");

// Create cache instance (keeps pronunciations for 1 hour)
const cache = new NodeCache({
  stdTTL: 3600,
  maxKeys: 1000, // Limit to 1000 entries to prevent memory leaks
});

// Initialize Express app
const app = express();
app.use(cors());
app.use(compression()); // Add compression for response optimization
app.use(bodyParser.json());
require("dotenv").config();
app.use(
  express.static("public", {
    maxAge: "1y", // Cache for 1 year
    etag: false,
  })
);

// Creates a client
const { GoogleAuth } = require("google-auth-library");

// Create a client using environment variables
const client = new textToSpeech.TextToSpeechClient({
  auth: new GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS),
  }),
});

// Helper function to generate cache key
const getCacheKey = (word, accent, voice) => {
  return `${word.toLowerCase()}_${accent}_${voice}`;
};

// **Updated: Define valid voices per accent**
const voiceMap = {
  "en-US": { male: "en-US-Wavenet-D", female: "en-US-Wavenet-F" },
  "en-GB": { male: "en-GB-Wavenet-D", female: "en-GB-Wavenet-F" },
  "en-AU": { male: "en-AU-Wavenet-B", female: "en-AU-Wavenet-C" },
  "en-IN": { male: "en-IN-Wavenet-B", female: "en-IN-Wavenet-D" },
};

// Fetch phonetic transcription and meaning from Free Dictionary API with timeout
const getWordDetails = async (word) => {
  try {
    const response = await axios.get(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${word}`,
      { timeout: 3000 } // 3 second timeout
    );

    if (response.data && response.data[0]) {
      const wordData = response.data[0];

      // Get phonetic if available
      const phonetic = wordData.phonetic || null;

      let meanings = [];

      if (wordData.meanings) {
        // Separate adjectives first (higher priority)
        const adjectiveMeanings = wordData.meanings.filter(
          (m) => m.partOfSpeech === "adjective"
        );
        const otherMeanings = wordData.meanings.filter(
          (m) => m.partOfSpeech !== "adjective"
        );

        const sortedMeanings = [...adjectiveMeanings, ...otherMeanings];

        sortedMeanings.forEach((meaning) => {
          meaning.definitions.forEach((def) => {
            if (meanings.length < 3) {
              meanings.push(def.definition);
            }
          });
        });
      }

      return { phonetic, meanings };
    } else {
      return { phonetic: null, meanings: ["No details available"] };
    }
  } catch (error) {
    // Better error handling with timeout detection
    if (error.code === "ECONNABORTED") {
      console.error("Dictionary API timeout");
      return { phonetic: null, meanings: ["Service unavailable (timeout)"] };
    }
    console.error("Error fetching word details:", error);
    return {
      phonetic: null,
      meanings: [
        `${
          /^[A-Z][a-z]+$/.test(word) ? "This looks like a name! " : ""
        }Hmm... we couldn't find a meaning for this word. Try another word!`,
      ],
    };
  }
};

app.get("/", (req, res) => res.send("Express on Vercel"));

app.post("/get-pronunciation", async (req, res) => {
  // Sanitize and trim input
  const word = (req.body.word || "").trim().toLowerCase();
  const accent = req.body.accent;
  const isMale = Boolean(req.body.isMale);

  // Quick validation with early returns
  if (!word) {
    return res.status(400).json({ error: "Word is required." });
  }

  if (!voiceMap[accent]) {
    return res.status(400).json({ error: "Invalid accent selected" });
  }

  const voiceName = isMale ? voiceMap[accent].male : voiceMap[accent].female;
  console.log("Selected Voice:", voiceName);

  // Create a cache key and check cache first
  const cacheKey = getCacheKey(word, accent, isMale ? "male" : "female");
  const cachedResponse = cache.get(cacheKey);

  if (cachedResponse) {
    console.log("Cache hit for:", word);

    // Set ETag header for cached response
    const responseETag = etag(JSON.stringify(cachedResponse));
    res.setHeader("ETag", responseETag);

    return res.json(cachedResponse);
  }

  try {
    // Set up parallel API calls for better performance
    const ttsRequestObj = {
      input: { text: word },
      voice: { languageCode: accent, name: voiceName },
      audioConfig: {
        audioEncoding: "MP3",
        speakingRate: 1.0,
      },
    };

    // Run API calls in parallel
    const [wordDetails, ttsResponse] = await Promise.all([
      getWordDetails(word),
      client.synthesizeSpeech(ttsRequestObj),
    ]);

    const { phonetic, meanings } = wordDetails;
    console.log("Fetched Meanings:", meanings);

    // Ensure meanings is always an array and only return the first 3 definitions
    const formattedMeanings =
      Array.isArray(meanings) && meanings.length > 0
        ? meanings.slice(0, 3)
        : ["Meaning not available."];

    const base64Audio = ttsResponse[0].audioContent.toString("base64");

    // Prepare the response data
    const responseData = {
      audioContent: base64Audio,
      phonetic: phonetic || "Phonetic transcription not available.",
      meanings: formattedMeanings,
    };

    // Store in cache
    cache.set(cacheKey, responseData);

    // Generate and set ETag
    const responseETag = etag(JSON.stringify(responseData));
    res.setHeader("ETag", responseETag);

    // Send response
    res.json(responseData);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: "Error processing pronunciation request",
      details: error.message,
    });
  }
});

// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
// });

module.exports = app;
