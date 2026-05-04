import { Router, type IRouter, type Request, type Response } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";

const router: IRouter = Router();

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err: Error): boolean {
  return /503|502|500|overloaded|unavailable|internal/i.test(err.message);
}

const SUMMARY_PROMPT = `Analyze this construction document and return ONLY a valid JSON object — no markdown, no code fences, no explanation. Raw JSON only:
{
  "project_name": "string",
  "address": "string",
  "architect": "string",
  "building_type": "string",
  "total_pages": 0,
  "disciplines": ["string"],
  "sheet_list": [{"sheet_number": "string", "title": "string", "page": 0}],
  "key_facts": ["string"]
}
Use "" for unknown strings, 0 for unknown numbers, [] for unknown arrays. key_facts: up to 10 important project notes.`;

interface PageContext {
  page: number;
  text: string;
  title?: string;
  sheet?: string;
}

router.post("/summarize", async (req: Request, res: Response) => {
  const { pageTexts } = req.body as { pageTexts: PageContext[] };

  if (!Array.isArray(pageTexts) || pageTexts.length === 0) {
    return res.status(400).json({ error: "pageTexts must be a non-empty array" });
  }

  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not configured" });
  }

  const contextText = pageTexts
    .map((p) => {
      const parts: string[] = [];
      if (p.sheet) parts.push(`Sheet: ${p.sheet}`);
      if (p.title) parts.push(`Title: ${p.title}`);
      const meta = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      return `[Page ${p.page}${meta}]: ${p.text}`;
    })
    .join("\n\n");

  const prompt = `${SUMMARY_PROMPT}\n\nDocument pages:\n${contextText}`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[summarize] attempt ${attempt}/${MAX_ATTEMPTS} — ${pageTexts.length} pages`);
      const result = await model.generateContent(prompt);
      const raw = result.response.text().trim();

      // Strip any markdown code fences Gemini may have added
      const clean = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      let summary: unknown;
      try {
        summary = JSON.parse(clean);
      } catch {
        console.error("[summarize] JSON parse failed, first 200 chars:", clean.slice(0, 200));
        return res.status(500).json({ error: "Summary response was not valid JSON" });
      }

      const s = summary as Record<string, unknown>;
      console.log("[summarize] success — project:", s["project_name"]);
      return res.json({ summary });
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error("Gemini request failed");
      console.error(`[summarize] attempt ${attempt} failed:`, lastErr.message);
      if (attempt < MAX_ATTEMPTS && isRetryable(lastErr)) {
        console.log(`[summarize] retrying in ${RETRY_DELAY_MS}ms…`);
        await sleep(RETRY_DELAY_MS);
      } else {
        break;
      }
    }
  }

  return res.status(500).json({ error: lastErr?.message ?? "Summary generation failed" });
});

export default router;
