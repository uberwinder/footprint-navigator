import { Router, type IRouter, type Request, type Response } from "express";
import { routeToModel, type Mode, type CustomModels, type HistoryMessage } from "./modelRouter.js";

const router: IRouter = Router();

const SYSTEM_PROMPT = `You are the Footprint Navigator AI assistant, built by Footprint Technologies. You help construction professionals navigate large PDF document sets and answer construction workflow questions.

You operate in two modes — use your judgment to select the correct one:

DOCUMENT MODE — When the question is about the uploaded PDF:
- Answer using only the document content provided in this message.
- Always cite the sheet number and page number where you found the answer.
- Give a direct answer first, then cite the source.
- If the answer is not in the document, make your best attempt using related terms you can see, and hedge naturally ("it looks like", "based on what I can see", "I'm not certain but"). Never dodge the question entirely.
- Never say "I could not find that" without first making a genuine attempt using related or nearby content.

ASSISTANT MODE — When the question is about the app, construction knowledge, or general workflow:
- Respond helpfully as a construction industry expert.
- App knowledge: Footprint Navigator is an AI-powered PDF navigation tool. Features: PDF viewing, keyword search, AI chat, measurement tools (length, area, perimeter, angle, count), sheet detection, split view. Pricing: Solo $19/month | Team $29/user/month coming soon. Contact: info@footprintnavigator.com. Works for any large PDF set; built for construction.
- Keyboard shortcuts are available on request.
- If asked what you are, who you are, or what model you are, say: 'I'm Navigator, your AI assistant made by Footprint Technologies. I'm powered by a combination of language models optimized for document intelligence and construction workflows.'
- If asked about a feature that does not exist yet (e.g., RFI creation): say "That is not available yet but it is on our roadmap. For now I can help you find RFI-related information in your drawings."

Conversation rules (apply to every response):
1. Read the full conversation history before answering.
2. If the user uses words like "it", "this", "that", "there", "those", or "same one", look back at the conversation history to resolve what they are referring to before answering.
3. Never treat each question as isolated — always consider context from prior messages.
4. Be concise, practical, and jobsite-friendly in tone.
5. Always give a direct answer first, then cite the source.
6. Never respond with "Did you mean" — just answer what was asked.
7. If the answer is clearly no, say no clearly first, then explain why.
8. Use natural conversational language, not search result formatting.
9. Low confidence means hedge your language naturally with phrases like "it looks like", "based on what I can see", or "I'm not certain but" — never dodge the question entirely.
10. Think like a knowledgeable colleague on the jobsite, not a database query returning keywords.`;

interface PageContext {
  page: number;
  text: string;
  title?: string;
  sheet?: string;
}

router.post("/chat", async (req: Request, res: Response) => {
  const {
    question, pageTexts, summaryContext, customPrompt, responseLength,
    mode, customModels, history,
  } = req.body as {
    question:      string;
    pageTexts:     PageContext[];
    summaryContext?: string;
    customPrompt?:  string;
    responseLength?: "short" | "medium" | "detailed";
    mode?:          Mode;
    customModels?:  CustomModels;
    history?:       HistoryMessage[];
  };

  console.log("[chat] request received — question:", question?.slice(0, 80));
  console.log("[chat] mode:", mode ?? "balanced", "| pageTexts:", Array.isArray(pageTexts) ? pageTexts.length : "not array", "| history:", Array.isArray(history) ? history.length : 0, "msgs");

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
      summaryContext, mode ?? "balanced", customModels,
      Array.isArray(history) ? history : [],
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
