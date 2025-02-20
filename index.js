const express = require('express');
const bodyParser = require('body-parser');
const textToSpeech = require('@google-cloud/text-to-speech');
const cors = require('cors');
const NodeCache = require('node-cache');
const axios = require('axios');

// Create cache instance (keeps pronunciations for 1 hour)
const cache = new NodeCache({ stdTTL: 3600 });

// Initialize Express app
const app = express();
app.use(cors());
app.use(bodyParser.json());
require("dotenv").config();


// Creates a client
const { GoogleAuth } = require('google-auth-library');

// Create a client using environment variables
const client = new textToSpeech.TextToSpeechClient({
  auth: new GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  })
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

// Fetch phonetic transcription and meaning from Free Dictionary API
const getWordDetails = async (word) => {
  try {
    const response = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
    if (response.data && response.data[0]) {
      const wordData = response.data[0];

      // Get phonetic if available
      const phonetic = wordData.phonetic || null;

      // Look for an adjective definition first
      let meaning = 'No definition available';
      if (wordData.meanings) {
        const adjectiveMeaning = wordData.meanings.find(m => m.partOfSpeech === 'adjective');
        if (adjectiveMeaning) {
          meaning = adjectiveMeaning.definitions[0].definition;
        } else {
          // Fallback to first available definition
          meaning = wordData.meanings[0].definitions[0].definition;
        }
      }

      return { phonetic, meaning };
    } else {
      return { phonetic: null, meaning: 'No details available' };
    }
  } catch (error) {
    console.error('Error fetching word details:', error);
    return { phonetic: null, meaning: 'Error fetching details' };
  }
};

app.get("/", (req, res) => res.send("Express on Vercel"));

app.post('/get-pronunciation', async (req, res) => {
  console.log("Received request:", req.body); // Debugging

  const { word, accent, isMale } = req.body;

  if (!word?.trim()) {
    return res.status(400).json({ error: 'Word is required.' });
  }

  if (!voiceMap[accent]) {
    return res.status(400).json({ error: 'Invalid accent selected' });
  }

  const voiceName = isMale === true ? voiceMap[accent].male : voiceMap[accent].female;
  console.log("Selected Voice:", voiceName);  // Debugging log

  try {
    const { phonetic, meaning } = await getWordDetails(word);

    const request = {
      input: { text: word },
      voice: { languageCode: accent, name: voiceName },
      audioConfig: { 
        audioEncoding: 'MP3',
        speakingRate: 1.0,  // Normal speed
      },
    };

    const [response] = await client.synthesizeSpeech(request);
    const base64Audio = response.audioContent.toString('base64');

    res.json({ 
      audioContent: base64Audio, 
      phonetic: phonetic || "Phonetic transcription not available.", 
      meaning: meaning || "Meaning not available." // Send the meaning
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Error processing pronunciation request', details: error.message });
  }
});

// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
// });

module.exports = app;
