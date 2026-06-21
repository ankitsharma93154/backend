const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { NodeHttpHandler } = require("@smithy/node-http-handler");
const https = require("https");

// ===== Fail loud at startup instead of failing mysteriously at request time =====
// Without this, a missing/misspelled env var (e.g. in Vercel project settings)
// just becomes "https://undefined.r2.cloudflarestorage.com" — and the actual
// error surfaces later as a confusing DNS/connection failure deep in the SDK.
const requiredEnvVars = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
];
const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key]);

if (missingEnvVars.length > 0) {
  console.error(
    `R2 is misconfigured — missing env var(s): ${missingEnvVars.join(", ")}. ` +
      "R2 reads/writes will fail until these are set.",
  );
}

const r2Endpoint = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

// Diagnostic only — R2_ACCOUNT_ID is not a secret, so logging the full
// endpoint is safe and helps catch typos/whitespace/wrong-value issues
// that are otherwise invisible (e.g. a trailing newline from copy-paste).
console.log(`R2 endpoint configured as: ${r2Endpoint}`);
console.log(`R2 bucket configured as: ${process.env.R2_BUCKET}`);

const r2 = new S3Client({
  region: "auto",
  endpoint: r2Endpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  // Fail fast instead of hanging. On a serverless platform like Vercel, a
  // slow/unreachable R2 endpoint with default (long, retrying) SDK behavior
  // can quietly eat into your function's execution time budget before your
  // own try/catch fallback logic ever gets a chance to kick in.
  maxAttempts: 2,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 3000, // ms to establish a connection
    requestTimeout: 8000, // ms to wait for a response
    // The SDK defaults to keepAlive: true on its connection pool, which
    // tries to reuse TCP/TLS sockets across requests. On serverless
    // platforms (Vercel/Lambda), function instances get frozen/thawed
    // between invocations, and a reused socket can have a TLS session
    // that's no longer valid on Cloudflare's end — which surfaces as a
    // confusing "SSL alert number 40 / handshake failure" on what looks
    // like a brand new request. Disabling keepAlive forces a fresh
    // connection each time, trading a little latency for reliability.
    httpsAgent: new https.Agent({ keepAlive: false }),
  }),
});

module.exports = {
  r2,
  GetObjectCommand,
  PutObjectCommand,
};
