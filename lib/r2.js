const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { NodeHttpHandler } = require("@smithy/node-http-handler");

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

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
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
    requestTimeout: 5000, // ms to wait for a response
  }),
});

module.exports = {
  r2,
  GetObjectCommand,
  PutObjectCommand,
};
