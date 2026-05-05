import { Router, type Request, type Response } from "express";
import pkg from "pg";
import { Resend } from "resend";
import { google } from "googleapis";

const { Pool } = pkg;
const router = Router();

const ADMIN_KEY = "FootprintAdmin2026";
const TO_EMAIL  = "info@footprintnavigator.com";

// Exact column order for the Google Sheet
const SHEET_FEATURES = [
  "PDF Upload",
  "Sheet and Thumbnail Detection",
  "Keyword Search",
  "Length Measurement",
  "Area Measurement",
  "Perimeter Measurement",
  "Angle Measurement",
  "Navigator AI Chat",
  "Page Navigation",
  "Zoom and Pan",
  "Overall Experience",
];

const SHEET_HEADERS = [
  "Submitted At",
  "First Name",
  "Last Name",
  "Work Email",
  "Company",
  ...SHEET_FEATURES,
  "Open Feedback",
];

const RATING_LABELS: Record<number, string> = {
  0: "Did not use",
  1: "Bad",
  2: "Poor",
  3: "Fair",
  4: "Good",
  5: "Excellent",
};

// ── Database pool ────────────────────────────────────────────────────────────
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

// Create table on startup
(async () => {
  if (!pool) { console.log("[feedback] No DATABASE_URL — DB disabled"); return; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS feedback_submissions (
        id            SERIAL PRIMARY KEY,
        submitted_at  TIMESTAMPTZ DEFAULT NOW(),
        first_name    TEXT,
        last_name     TEXT,
        email         TEXT,
        company       TEXT,
        ratings       JSONB,
        open_feedback TEXT
      )
    `);
    console.log("[feedback] table ready");
  } catch (err) {
    console.error("[feedback] table init error:", err);
  }
})();

// ── Google Sheets helper ─────────────────────────────────────────────────────
async function appendToSheet(data: {
  firstName?: string;
  lastName?: string;
  email?: string;
  company?: string;
  ratings?: Record<string, number>;
  openFeedback?: string;
}): Promise<void> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!sheetId || !clientEmail || !rawKey) {
    console.log("[feedback] Google Sheets env vars not set — skipping");
    return;
  }

  // Unescape literal \n sequences that may arrive from env var storage
  const privateKey = rawKey.replace(/\\n/g, "\n");

  const auth = new google.auth.JWT({
    email:  clientEmail,
    key:    privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  // Check if the sheet has any data; if empty write headers first
  const check = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "A1:A2",
  });

  if (!check.data.values || check.data.values.length === 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId:   sheetId,
      range:           "A1",
      valueInputOption: "RAW",
      requestBody:     { values: [SHEET_HEADERS] },
    });
    console.log("[feedback] wrote header row to sheet");
  }

  // Build the data row in exact column order
  const row: (string | number)[] = [
    new Date().toISOString(),
    data.firstName  || "",
    data.lastName   || "",
    data.email      || "",
    data.company    || "",
    ...SHEET_FEATURES.map((f) => data.ratings?.[f] ?? ""),
    data.openFeedback || "",
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId:   sheetId,
    range:           "A1",
    valueInputOption: "RAW",
    requestBody:     { values: [row] },
  });

  console.log("[feedback] row appended to Google Sheet");
}

// ── Email builder ────────────────────────────────────────────────────────────
function buildEmailHtml(body: {
  firstName?: string;
  lastName?: string;
  email?: string;
  company?: string;
  ratings?: Record<string, number>;
  openFeedback?: string;
}): string {
  const now = new Date().toLocaleString("en-US", {
    timeZone: "UTC", dateStyle: "full", timeStyle: "short",
  });

  const ratingsRows = Object.entries(body.ratings ?? {})
    .map(([feature, score]) => {
      const label = RATING_LABELS[score] ?? String(score);
      const color = score === 0 ? "#666" : score >= 4 ? "#22c55e" : score >= 2 ? "#f59e0b" : "#ef4444";
      return `
        <tr>
          <td style="padding:7px 14px;border-bottom:1px solid #222;color:#bbb;font-size:13px;">${feature}</td>
          <td style="padding:7px 14px;border-bottom:1px solid #222;color:${color};font-weight:700;font-size:13px;">${score} — ${label}</td>
        </tr>`;
    })
    .join("");

  const name = [body.firstName, body.lastName].filter(Boolean).join(" ") || "Anonymous";

  return `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:Arial,sans-serif;">
<div style="max-width:620px;margin:0 auto;background:#111;color:#ddd;border-radius:10px;overflow:hidden;">
  <div style="background:#007BFF;padding:20px 28px;">
    <h1 style="margin:0;color:#fff;font-size:20px;font-weight:800;">Footprint Navigator</h1>
    <p  style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:14px;">Feedback Submission</p>
  </div>
  <div style="padding:24px 28px;">
    <p style="color:#666;font-size:12px;margin-top:0;">${now} UTC</p>

    <h3 style="color:#fff;font-size:14px;border-bottom:1px solid #2a2a2a;padding-bottom:8px;margin-bottom:12px;">User Info</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr><td style="padding:5px 14px;color:#666;width:100px;">Name</td>    <td style="padding:5px 14px;">${name}</td></tr>
      <tr><td style="padding:5px 14px;color:#666;">Email</td>   <td style="padding:5px 14px;">${body.email || "—"}</td></tr>
      <tr><td style="padding:5px 14px;color:#666;">Company</td> <td style="padding:5px 14px;">${body.company || "—"}</td></tr>
    </table>

    <h3 style="color:#fff;font-size:14px;border-bottom:1px solid #2a2a2a;padding-bottom:8px;margin:24px 0 12px;">Feature Ratings</h3>
    <table style="width:100%;border-collapse:collapse;">
      ${ratingsRows || "<tr><td colspan='2' style='color:#555;padding:10px 14px;font-size:13px;'>No ratings submitted</td></tr>"}
    </table>

    <h3 style="color:#fff;font-size:14px;border-bottom:1px solid #2a2a2a;padding-bottom:8px;margin:24px 0 12px;">Open Feedback</h3>
    <div style="background:#1a1a1a;border-radius:6px;padding:14px;color:#ccc;font-size:13px;line-height:1.6;white-space:pre-wrap;">${body.openFeedback || "—"}</div>
  </div>
</div>
</body>
</html>`;
}

// ── POST /pdf-api/feedback ───────────────────────────────────────────────────
router.post("/feedback", async (req: Request, res: Response) => {
  const {
    firstName, lastName, email, company, ratings, openFeedback,
  } = req.body as {
    firstName?: string;
    lastName?: string;
    email?: string;
    company?: string;
    ratings?: Record<string, number>;
    openFeedback?: string;
  };

  // 1. Save to database (required — fail if this fails)
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO feedback_submissions
           (first_name, last_name, email, company, ratings, open_feedback)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          firstName  || null,
          lastName   || null,
          email      || null,
          company    || null,
          JSON.stringify(ratings ?? {}),
          openFeedback || null,
        ],
      );
    } catch (err) {
      console.error("[feedback] DB insert error:", err);
      res.status(500).json({ error: "Failed to save feedback" });
      return;
    }
  } else {
    console.warn("[feedback] No DB pool — submission not stored");
  }

  // 2. Append to Google Sheet (best-effort — never fail the request)
  try {
    await appendToSheet({ firstName, lastName, email, company, ratings, openFeedback });
  } catch (err) {
    console.error("[feedback] Google Sheets error:", err);
  }

  // 3. Send email via Resend (best-effort)
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    try {
      const resend = new Resend(apiKey);
      const name   = [firstName, lastName].filter(Boolean).join(" ") || "Anonymous";
      await resend.emails.send({
        from:    "Footprint Navigator <onboarding@resend.dev>",
        to:      [TO_EMAIL],
        subject: `[Feedback] ${name} — ${new Date().toLocaleDateString("en-US")}`,
        html:    buildEmailHtml({ firstName, lastName, email, company, ratings, openFeedback }),
      });
    } catch (err) {
      console.error("[feedback] Resend send error:", err);
    }
  } else {
    console.log("[feedback] RESEND_API_KEY not set — email skipped");
  }

  res.json({ ok: true });
});

// ── GET /pdf-api/admin/feedback ──────────────────────────────────────────────
router.get("/admin/feedback", async (req: Request, res: Response) => {
  const key = req.headers["x-admin-key"] as string | undefined;
  if (key !== ADMIN_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!pool) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }

  try {
    const result = await pool.query(
      "SELECT * FROM feedback_submissions ORDER BY submitted_at DESC",
    );
    res.json({ count: result.rowCount, submissions: result.rows });
  } catch (err) {
    console.error("[feedback] admin query error:", err);
    res.status(500).json({ error: "Failed to fetch submissions" });
  }
});

export default router;
