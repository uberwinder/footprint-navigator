import { Router, type IRouter, type Request, type Response } from "express";
import { routeToModel, type Mode, type CustomModels } from "./modelRouter.js";

const router: IRouter = Router();

const SYSTEM_PROMPT =
  "You are a construction document assistant. Answer questions using ONLY the document text provided. " +
  "Always cite the page number where you found the answer. " +
  "If the answer is not clearly present, do NOT simply say you could not find it. " +
  "Instead, ask a clarifying follow-up question — for example: if asked about 'front elevations' and you see 'exterior elevations', ask 'Did you mean exterior elevations? I found references on page X.' " +
  "Never give up without first suggesting an alternative or asking a one-sentence follow-up question. " +
  "Only say 'I could not find that in this document.' if you have genuinely exhausted all related terms. " +
  "Answer in ONE sentence maximum. Never ask follow-up questions in the same response as an answer. If you have the answer, give it. If you need to clarify, ask only one short question with no answer attempt.";

interface PageContext {
  page: number;
  text: string;
  title?: string;
  sheet?: string;
}

router.post("/chat", async (req: Request, res: Response) => {
  const {
    question, pageTexts, summaryContext, customPrompt, responseLength,
    mode, customModels,
  } = req.body as {
    question:      string;
    pageTexts:     PageContext[];
    summaryContext?: string;
    customPrompt?:  string;
    responseLength?: "short" | "medium" | "detailed";
    mode?:          Mode;
    customModels?:  CustomModels;
  };

  console.log("[chat] request received — question:", question?.slice(0, 80));
  console.log("[chat] mode:", mode ?? "balanced", "| pageTexts:", Array.isArray(pageTexts) ? pageTexts.length : "not array");

  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "question is required" });
  }
  if (!Array.isArray(pageTexts)) {
    return res.status(400).json({ error: "pageTexts must be an array" });
  }

  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    console.error("[chat] ERROR: GEMINI_API_KEY is not configured — add it to Secrets");
    return res.status(500).json({ error: "GEMINI_API_KEY is not configured. Add it in the Replit Secrets panel." });
  }

  const baseInstruction = (customPrompt && customPrompt.trim()) ? customPrompt.trim() : SYSTEM_PROMPT;
  const lengthSuffix    =
    responseLength === "short"    ? " Answer in 2–3 sentences only."             :
    responseLength === "detailed" ? " Be as thorough as needed; provide complete detail." :
                                    " Answer in up to 5 sentences.";

  try {
    const result = await routeToModel(
      question, pageTexts, baseInstruction, lengthSuffix,
      summaryContext, mode ?? "balanced", customModels
    );
    return res.json({
      answer:           result.answer,
      model:            result.model,
      modelName:        result.modelName,
      complexity:       result.complexity,
      latencyMs:        result.latencyMs,
      estimatedCostUSD: result.estimatedCostUSD,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Router failed";
    console.error("[chat] routeToModel failed:", msg);
    return res.status(500).json({ error: msg });
  }
});

export default router;
