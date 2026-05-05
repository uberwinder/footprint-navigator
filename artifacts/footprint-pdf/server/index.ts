import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import app from "./app.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProduction = process.env["NODE_ENV"] === "production";

if (isProduction) {
  // dist/server/index.js -> dist/public
  const webDist = path.resolve(__dirname, "../public");
  app.use(express.static(webDist));
  app.get(/^\/(?!pdf-api).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

const rawPort =
  process.env["EXPRESS_PORT"] ?? process.env["PORT"] ?? "4001";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid port value: "${rawPort}"`);
}

// ── Secret presence check ────────────────────────────────────────────────────
const checkSecret = (name: string, expected?: string) => {
  const val = process.env[name];
  if (!val) {
    console.log(`[secrets] ${name}: NOT SET ✗`);
    return;
  }
  const preview = val.slice(0, 8) + "...";
  const hint    = expected ? (val.startsWith(expected) ? " ✓" : ` ✓ (unexpected prefix, got ${val.slice(0, 4)})`) : " ✓";
  console.log(`[secrets] ${name}: ${preview}${hint}`);
};

checkSecret("GROQ_API_KEY",    "gsk_");
checkSecret("GEMINI_API_KEY",  "AIza");
checkSecret("SESSION_SECRET");
checkSecret("RESEND_API_KEY",  "re_");
// ─────────────────────────────────────────────────────────────────────────────

app.listen(port, (err) => {
  if (err) {
    console.error("Error listening on port", err);
    process.exit(1);
  }
  console.log(`footprint-pdf server listening on port ${port}`);
});
