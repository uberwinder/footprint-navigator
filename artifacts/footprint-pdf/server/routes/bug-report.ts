import { Router, type Request, type Response } from "express";
import pkg from "pg";
import { Resend } from "resend";

const { Pool } = pkg;
const router = Router();

const ADMIN_KEY = "FootprintAdmin2026";
const TO_EMAIL  = "info@footprintnavigator.com";

// ── Database pool ─────────────────────────────────────────────────────────────
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

// Create table on startup
(async () => {
  if (!pool) { console.log("[bug-report] No DATABASE_URL — DB disabled"); return; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bug_reports (
        id                   SERIAL PRIMARY KEY,
        submitted_at         TIMESTAMPTZ DEFAULT NOW(),
        summary              TEXT,
        conversation_context TEXT,
        resolved             BOOLEAN DEFAULT FALSE
      )
    `);
    console.log("[bug-report] table ready");
  } catch (err) {
    console.error("[bug-report] table init error:", err);
  }
})();

// ── Email builder ─────────────────────────────────────────────────────────────
function buildEmailHtml(summary: string, conversationContext: string): string {
  const now = new Date().toLocaleString("en-US", {
    timeZone: "UTC", dateStyle: "full", timeStyle: "short",
  });

  const escapedSummary = summary
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escapedContext = conversationContext
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:Arial,sans-serif;">
<div style="max-width:620px;margin:0 auto;background:#111;color:#ddd;border-radius:10px;overflow:hidden;">
  <div style="background:#ef4444;padding:20px 28px;">
    <h1 style="margin:0;color:#fff;font-size:20px;font-weight:800;">Footprint Navigator</h1>
    <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">Bug Report</p>
  </div>
  <div style="padding:24px 28px;">
    <p style="color:#666;font-size:12px;margin-top:0;">${now} UTC</p>

    <h3 style="color:#fff;font-size:14px;border-bottom:1px solid #2a2a2a;padding-bottom:8px;margin-bottom:12px;">Issue Summary</h3>
    <div style="background:#1a1a1a;border-radius:6px;padding:14px;color:#f87171;font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapedSummary}</div>

    <h3 style="color:#fff;font-size:14px;border-bottom:1px solid #2a2a2a;padding-bottom:8px;margin:24px 0 12px;">Full Conversation Context</h3>
    <div style="background:#1a1a1a;border-radius:6px;padding:14px;color:#ccc;font-size:13px;line-height:1.6;white-space:pre-wrap;">${escapedContext}</div>
  </div>
</div>
</body>
</html>`;
}

// ── POST /pdf-api/bug-report ──────────────────────────────────────────────────
router.post("/bug-report", async (req: Request, res: Response) => {
  const { summary, conversationContext } = req.body as {
    summary?: string;
    conversationContext?: string;
  };

  if (!summary || typeof summary !== "string") {
    res.status(400).json({ error: "summary is required" });
    return;
  }

  const ctx = conversationContext || "";

  // 1. Save to database
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO bug_reports (summary, conversation_context)
         VALUES ($1, $2)`,
        [summary, ctx],
      );
    } catch (err) {
      console.error("[bug-report] DB insert error:", err);
      res.status(500).json({ error: "Failed to save bug report" });
      return;
    }
  } else {
    console.warn("[bug-report] No DB pool — report not stored");
  }

  // 2. Send email via Resend (best-effort — never block the response)
  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    try {
      const resend = new Resend(apiKey);
      await resend.emails.send({
        from:    "Footprint Navigator <onboarding@resend.dev>",
        to:      [TO_EMAIL],
        subject: `[Bug Report] ${summary.slice(0, 80)} — ${new Date().toLocaleDateString("en-US")}`,
        html:    buildEmailHtml(summary, ctx),
      });
    } catch (err) {
      console.error("[bug-report] Resend send error:", err);
    }
  } else {
    console.log("[bug-report] RESEND_API_KEY not set — email skipped");
  }

  res.json({ ok: true });
});

// ── GET /pdf-api/admin/bug-reports ────────────────────────────────────────────
router.get("/admin/bug-reports", async (req: Request, res: Response) => {
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
      "SELECT * FROM bug_reports ORDER BY submitted_at DESC",
    );
    res.json({ count: result.rowCount, reports: result.rows });
  } catch (err) {
    console.error("[bug-report] admin query error:", err);
    res.status(500).json({ error: "Failed to fetch bug reports" });
  }
});

export default router;
