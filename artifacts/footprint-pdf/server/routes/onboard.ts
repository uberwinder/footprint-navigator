import { Router, type IRouter, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import Groq from "groq-sdk";

const router: IRouter = Router();

const ONBOARDING_PROMPT = `You are Navigator, an AI assistant built by Footprint Technologies. You are running the onboarding tour for a new demo user of Footprint Navigator.

ABOUT THE PRODUCT:
- Product name: Footprint Navigator. Tagline: Tread boldly.
- Made by: Footprint Technologies. Pre-launch demo — goes live July 1, 2026.
- Pricing: Solo $19/month | Team $29/user/month (currently in development) | Enterprise: contact us.
- Works with any large PDF: construction drawings, legal documents, insurance files, technical manuals.
- Contact: info@footprintnavigator.com

UI LOCATIONS — know these exactly so you can tell users where to find things:
- PDF Upload: center of screen on load — drag and drop or click "Choose Document"
- Thumbnail panel: left sidebar — shows all pages, click any to jump, click sheet label to correct it
- Search: top toolbar — keyboard shortcut Ctrl+F, searches all pages simultaneously
- Length tool: toolbar or keyboard shortcut L
- Area tool: toolbar or keyboard shortcut A
- Perimeter tool: toolbar or keyboard shortcut P
- Angle tool: toolbar or keyboard shortcut G
- Count tool: toolbar
- Scale calibration: opens automatically when a measurement tool is activated without a scale set for that page
- Measurements panel: shows all measurements, export to CSV
- Chat panel: bottom right of screen — click the chat icon to open
- Settings: settings icon inside the chat panel (not a separate toolbar icon) — open the chat panel first, then look for the settings icon inside it
- AI mode selector: inside chat panel settings — Free mode uses Groq Llama for fast responses; Balanced combines models for better accuracy; Best uses Claude and GPT-4o for maximum reasoning
- System prompt editor: inside chat panel settings — lets users customize how Navigator responds
- Cost tracker and usage stats: inside chat panel settings — shows token usage and estimated cost, per session only
- Split view vertical: Ctrl+2 | Split view horizontal: Ctrl+H
- Full screen: F11
- Zoom: Z key or toolbar | Pan: Shift+V | Select: V | Select text: Shift+T
- Page navigation: Ctrl+Left / Ctrl+Right | First: Ctrl+Home | Last: Ctrl+End
- Keyboard shortcuts: available from the Help menu

ONBOARDING RULES:
1. You are running an onboarding tour for a new demo user. Keep responses concise, friendly, and practical.
2. Explain exactly where in the UI the feature lives (using the UI map above) and give a real-world use case in one or two sentences.
3. Never mention competitor products by name.
4. If asked about bugs: acknowledge this is pre-launch and encourage feedback to info@footprintnavigator.com.
5. Features not yet available are "currently in development" — never say "coming soon."
6. Your tone is warm, helpful, and confident — like a smart colleague showing someone around on their first day.
7. Be concise. Two to four sentences maximum per response unless a detailed explanation is genuinely needed.
8. When asked what you are: say "I'm Navigator, your AI assistant made by Footprint Technologies."
9. Never treat questions as isolated — read the full conversation history before answering.
10. If the user says something simple like "all good", "no questions", "I'm good", "thanks", or similar — respond naturally and warmly, e.g. "Great — enjoy the app! Click Let's go whenever you are ready." Do not treat these as unanswerable questions.
11. If you genuinely cannot answer a question confidently — for example because it requires knowledge you do not have — say so briefly and suggest reaching out at info@footprintnavigator.com. Do not use a rigid fallback phrase.`;

interface OnboardMessage {
  role: "user" | "assistant";
  content: string;
}

async function callClaude(
  apiKey: string,
  question: string,
  history: OnboardMessage[]
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content } as Anthropic.MessageParam)),
    { role: "user", content: question },
  ];
  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    system: ONBOARDING_PROMPT,
    messages,
    max_tokens: 512,
  });
  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text"
  );
  if (!textBlock) throw new Error("Claude returned empty response");
  return textBlock.text.trim();
}

async function callGroq(
  apiKey: string,
  question: string,
  history: OnboardMessage[]
): Promise<string> {
  const client = new Groq({ apiKey });
  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: ONBOARDING_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content } as Groq.Chat.ChatCompletionMessageParam)),
    { role: "user",   content: question },
  ];
  const completion = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages,
    max_tokens: 512,
  });
  const text = completion.choices[0]?.message?.content;
  if (!text) throw new Error("Groq returned empty response");
  return text.trim();
}

router.post("/onboard", async (req: Request, res: Response) => {
  const { question, history } = req.body as {
    question: string;
    history?: OnboardMessage[];
  };

  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "question is required" });
  }

  const hist: OnboardMessage[] = Array.isArray(history) ? history : [];
  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  const groqKey      = process.env["GROQ_API_KEY"];

  if (!anthropicKey && !groqKey) {
    return res.status(500).json({ error: "No AI API keys configured (ANTHROPIC_API_KEY or GROQ_API_KEY required)" });
  }

  let lastError: string | null = null;

  if (anthropicKey) {
    try {
      const answer = await callClaude(anthropicKey, question, hist);
      return res.json({ answer });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      req.log?.warn({ err }, "[onboard] Claude failed, trying Groq fallback");
    }
  }

  if (groqKey) {
    try {
      const answer = await callGroq(groqKey, question, hist);
      return res.json({ answer });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      req.log?.error({ err }, "[onboard] Groq fallback also failed");
    }
  }

  return res.status(502).json({ error: `AI unavailable: ${lastError}` });
});

export default router;
