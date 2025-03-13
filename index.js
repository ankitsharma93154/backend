const express = require("express");
const bodyParser = require("body-parser");
const textToSpeech = require("@google-cloud/text-to-speech");
const cors = require("cors");
const NodeCache = require("node-cache");
const axios = require("axios");
const compression = require("compression");
const etag = require("etag");

const app = express();
app.use(cors());
app.use(compression({ level: 6 }));
app.use(bodyParser.json({ limit: "1mb" }));
require("dotenv").config();

const cache = new NodeCache({
  stdTTL: 86400,
  checkperiod: 3600,
  maxKeys: 5000,
});

const { GoogleAuth } = require("google-auth-library");
const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
const client = new textToSpeech.TextToSpeechClient({
  auth: new GoogleAuth({
    credentials,
    scopes: "https://www.googleapis.com/auth/cloud-platform",
  }),
});

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

    if (Array.isArray(phonetics)) {
      return phonetics[0];
    }

    return phonetics || null;
  } catch (error) {
    console.error("Error fetching phonetic from JSON:", error);
    return null;
  }
};

const dictionaryApi = axios.create({
  baseURL: "https://api.dictionaryapi.dev/api/v2/entries/en",
  timeout: 2500,
  headers: { "Accept-Encoding": "gzip,deflate" },
  maxRedirects: 2,
});

// Fetch phonetic transcription from Dictionary API as fallback
const getWordDetails = async (word) => {
  try {
    const response = await dictionaryApi.get(`/${word}`);
    if (!response.data || !response.data[0])
      return { phonetic: null, meanings: [], examples: [] };

    const wordData = response.data[0];
    const phonetic = wordData.phonetic || null;
    return { phonetic, meanings: [], examples: [] };
  } catch (error) {
    console.error("Dictionary API error:", error.message);
    return { phonetic: null, meanings: [], examples: [] };
  }
};

app.get("/", (_, res) => res.send("Express on Vercel"));

app.post("/get-pronunciation", async (req, res) => {
  const { word: rawWord, accent, isMale } = req.body;

  if (!rawWord) return res.status(400).json({ error: "Word is required." });

  const word = rawWord.trim().toLowerCase();
  const accentConfig = voiceMap[accent];
  if (!accentConfig)
    return res.status(400).json({ error: "Invalid accent selected" });

  const voiceName = isMale ? accentConfig.male : accentConfig.female;
  const cacheKey = `${word}_${accent}_${isMale ? "male" : "female"}`;

  const cachedResponse = cache.get(cacheKey);
  if (cachedResponse) {
    res.setHeader("ETag", cachedResponse.etag || etag(word + accent));
    return res.json(cachedResponse.data);
  }

  try {
    // Try fetching phonetic transcription from JSON
    let phonetic = await getPhoneticFromJson(word, accent);

    // If not found in JSON, fallback to Dictionary API
    if (!phonetic) {
      const wordDetails = await getWordDetails(word);
      phonetic =
        wordDetails.phonetic || "Phonetic transcription not available.";
    }

    // Google TTS request
    const [ttsResponse] = await client.synthesizeSpeech({
      input: { text: word },
      voice: { languageCode: accent, name: voiceName },
      audioConfig: { audioEncoding: "MP3", speakingRate: 1.0 },
    });

    const base64Audio = ttsResponse.audioContent.toString("base64");

    const responseData = { audioContent: base64Audio, phonetic };
    const responseETag = etag(word + accent);

    cache.set(cacheKey, { data: responseData, etag: responseETag });

    res.setHeader("ETag", responseETag);
    res.json(responseData);
  } catch (error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: "Error processing pronunciation request" });
  }
});

// Fetch phonetic JSON on startup
fetchPhoneticJson();

module.exports = app;
