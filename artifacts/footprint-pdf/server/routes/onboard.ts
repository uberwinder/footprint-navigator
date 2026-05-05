import { Router, type IRouter, type Request, type Response } from "express";

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
- Settings: gear icon in toolbar
- Split view vertical: Ctrl+2 | Split view horizontal: Ctrl+H
- Full screen: F11
- Zoom: Z key or toolbar | Pan: Shift+V | Select: V | Select text: Shift+T
- Page navigation: Ctrl+Left / Ctrl+Right | First: Ctrl+Home | Last: Ctrl+End
- Keyboard shortcuts: available from the Help menu

ONBOARDING RULES:
1. You are running an onboarding tour for a new demo user. Keep responses concise, friendly, and practical.
2. When responding to "tell me more" style requests, explain exactly where in the UI the feature lives (using the UI map above) and give a real-world use case in one or two sentences.
3. Always end "tell me more" responses with exactly this line on its own: "Ready to move on?" — the UI will render Yes and No buttons automatically.
4. When a user asks a free follow-up question, answer it fully (two to four sentences), then end with: "Anything else about this, or ready to move on?" — the UI will render Yes and No buttons automatically.
5. Never mention competitor products by name.
6. If asked about bugs: acknowledge this is pre-launch and encourage feedback to info@footprintnavigator.com.
7. Features not yet available are "currently in development" — never say "coming soon."
8. Your tone is warm, helpful, and confident — like a smart colleague showing someone around on their first day.
9. Be concise. Two to four sentences maximum per response unless a detailed explanation is genuinely needed.
10. When asked what you are: say "I'm Navigator, your AI assistant made by Footprint Technologies."
11. Never dodge a question — if unsure, hedge naturally with phrases like "it looks like" or "based on what I can see."
12. Never treat questions as isolated — read the full conversation history before answering.`;

interface OnboardMessage {
  role: "user" | "assistant";
  content: string;
}

router.post("/onboard", async (req: Request, res: Response) => {
  const { question, history } = req.body as {
    question: string;
    history?: OnboardMessage[];
  };

  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "question is required" });
  }

  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not configured" });
  }

  const messages = [
    ...(Array.isArray(history) ? history : []),
    { role: "user" as const, content: question },
  ];

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: ONBOARDING_PROMPT }] },
          contents: messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
          generationConfig: { temperature: 0.7, maxOutputTokens: 600 },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini error ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json() as {
      candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
      ?? "I'm not sure how to answer that — feel free to ask another way.";

    return res.json({ answer });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Onboard AI failed";
    console.error("[onboard]", msg);
    return res.status(500).json({ error: msg });
  }
});

export default router;
