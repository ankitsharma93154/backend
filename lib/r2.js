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
    // CONFIRMED (Jul 2026): logs showed 500-750ms per R2 call, almost
    // entirely handshake overhead (payloads are tiny; real transfer time
    // is tens of ms). keepAlive: false was forcing a fresh TCP+TLS
    // handshake on every single send(), which is what was driving the
    // GB-Hrs spike since the R2 rollout.
    //
    // Re-enabling keepAlive gets connection reuse back within a warm
    // invocation/container, but with a short keepAliveMsecs so idle
    // sockets don't survive long enough to go stale across a Vercel
    // freeze/thaw cycle — which is what caused the original "SSL alert
    // number 40 / handshake failure" bug that led to disabling it.
    // maxSockets caps how many concurrent connections one instance holds
    // open, rather than unbounded growth under concurrent requests.
    httpsAgent: new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 10,
    }),
  }),
});

// If a reused socket happens to be dead on Cloudflare's end (frozen
// mid-TLS-session, resumed with a now-invalid session), the failure
// surfaces as a handshake/connection-reset error on an otherwise-normal
// request. Rather than fail the request outright, retry once with a
// guaranteed-fresh connection before giving up.
const isHandshakeLikeError = (err) => {
  const msg = String(err?.message || "");
  const code = err?.code || err?.cause?.code;
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    msg.includes("SSL alert") ||
    msg.includes("handshake") ||
    msg.includes("socket hang up")
  );
};

async function sendWithHandshakeRetry(command) {
  try {
    return await r2.send(command);
  } catch (err) {
    if (!isHandshakeLikeError(err)) throw err;
    console.warn(
      `[R2] stale-connection retry triggered: ${err?.message || err}`,
    );
    // Force a fresh connection for just this retry, without flipping the
    // shared client's keepAlive setting back off for every other call.
    return await r2.send(command, {
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 3000,
        requestTimeout: 8000,
        httpsAgent: new https.Agent({ keepAlive: false }),
      }),
    });
  }
}

// ===== Instrumented R2 helpers =====
// Logged here (not in index.js) so ANY caller of getFromR2/saveToR2 gets
// consistent timing, and so index.js doesn't need to duplicate Date.now()
// bookkeeping per call site.

async function getFromR2(key) {
  const start = Date.now();
  try {
    const response = await sendWithHandshakeRetry(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      }),
    );

    const text = await response.Body.transformToString();
    const data = JSON.parse(text);
    console.log(`[R2-GET] hit  key=${key} dur=${Date.now() - start}ms`);
    return data;
  } catch (err) {
    const dur = Date.now() - start;
    if (err?.name === "NoSuchKey") {
      console.log(`[R2-GET] miss key=${key} dur=${dur}ms`);
    } else {
      console.warn(
        `[R2-GET] fail key=${key} dur=${dur}ms err=${err?.message || err}`,
      );
    }
    return null;
  }
}

async function saveToR2(key, data) {
  const start = Date.now();
  try {
    await sendWithHandshakeRetry(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: JSON.stringify(data),
        ContentType: "application/json",
      }),
    );
    console.log(`[R2-PUT] ok   key=${key} dur=${Date.now() - start}ms`);
    return true;
  } catch (err) {
    console.error(
      `[R2-PUT] fail key=${key} dur=${Date.now() - start}ms err=${err?.message || err}`,
    );
    return false;
  }
}

module.exports = {
  r2,
  GetObjectCommand,
  PutObjectCommand,
  getFromR2,
  saveToR2,
};
