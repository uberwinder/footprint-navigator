import Groq from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

console.log("[modelRouter] GROQ_API_KEY set:",      !!process.env["GROQ_API_KEY"]);
console.log("[modelRouter] GEMINI_API_KEY set:",    !!process.env["GEMINI_API_KEY"]);
console.log("[modelRouter] OPENAI_API_KEY set:",    !!process.env["OPENAI_API_KEY"]);
console.log("[modelRouter] ANTHROPIC_API_KEY set:", !!process.env["ANTHROPIC_API_KEY"]);

export type Complexity = "simple" | "moderate" | "complex";
export type Mode       = "free" | "balanced" | "best";

export interface HistoryMessage {
  role:    "user" | "assistant";
  content: string;
}

// Cost per million tokens (input / output)
export const MODEL_COSTS: Record<string, { input: number; output: number; name: string }> = {
  "groq-70b":      { input: 0.59,  output: 0.79,  name: "Groq Llama 3.3 70B" },
  "gemini-flash":  { input: 0.15,  output: 0.60,  name: "Gemini 2.5 Flash"   },
  "gpt-4o-mini":   { input: 0.15,  output: 0.60,  name: "GPT-4o Mini"        },
  "gpt-4o":        { input: 2.50,  output: 10.00, name: "GPT-4o"             },
  "claude-haiku":  { input: 0.80,  output: 4.00,  name: "Claude Haiku"       },
  "claude-sonnet": { input: 3.00,  output: 15.00, name: "Claude Sonnet"      },
};

export function estimateCost(
  inputChars: number,
  outputChars: number,
  modelId: string
): { inputTokens: number; outputTokens: number; estimatedCostUSD: number } {
  const inputTokens  = Math.ceil(inputChars  / 4);
  const outputTokens = Math.ceil(outputChars / 4);
  const costs = MODEL_COSTS[modelId];
  if (!costs) return { inputTokens, outputTokens, estimatedCostUSD: 0 };
  const estimatedCostUSD =
    (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
  return { inputTokens, outputTokens, estimatedCostUSD };
}

// ── Preset mode routing chains ──────────────────────────────────────────────
const MODE_CHAINS: Record<Mode, Record<Complexity, string[]>> = {
  free: {
    simple:   ["groq-70b", "gemini-flash"],
    moderate: ["groq-70b", "gemini-flash"],
    complex:  ["groq-70b", "gemini-flash"],
  },
  balanced: {
    simple:   ["groq-70b",     "claude-haiku",  "gemini-flash"],
    moderate: ["claude-haiku", "claude-sonnet", "gemini-flash"],
    complex:  ["claude-sonnet","gemini-flash"],
  },
  best: {
    simple:   ["claude-haiku",  "claude-sonnet"],
    moderate: ["claude-sonnet", "gpt-4o"],
    complex:  ["gpt-4o",        "claude-sonnet"],
  },
};

export function classifyQuestion(question: string): Complexity {
  const lower     = question.trim().toLowerCase();
  const wordCount = lower.split(/\s+/).length;

  if (
    wordCount > 15 ||
    /conflict|compare|difference between|vs\.?\s|changed|cross.?reference/.test(lower) ||
    (/\band\b/.test(lower) && /sheet|discipline|floor|level|section|elevation|drawing/.test(lower))
  ) return "complex";

  if (
    wordCount >= 8 ||
    /tell me about|list all|summarize|describe|what are|explain/.test(lower)
  ) return "moderate";

  return "simple";
}

interface PageContext {
  page: number;
  text: string;
  title?: string;
  sheet?: string;
}

function buildContext(pageTexts: PageContext[], complexity: Complexity, summaryCtx?: string): string {
  const maxPages = complexity === "simple" ? 3 : complexity === "moderate" ? 6 : 10;
  const pages    = pageTexts.slice(0, maxPages);
  const pageStr  = pages.map((p) => {
    const parts: string[] = [];
    if (p.sheet) parts.push(`Sheet: ${p.sheet}`);
    if (p.title) parts.push(`Title: ${p.title}`);
    const meta = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    return `[Page ${p.page}${meta}]: ${p.text}`;
  }).join("\n\n");

  if (summaryCtx && pages.length > 0)
    return `Document Summary:\n${summaryCtx}\n\nRelevant page excerpts:\n${pageStr}`;
  if (summaryCtx)
    return `Document Summary:\n${summaryCtx}`;
  return `Document text:\n${pageStr}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ── Serialize history for flat-prompt APIs (Gemini) ─────────────────────────
function serializeHistory(history: HistoryMessage[]): string {
  if (!history.length) return "";
  return history
    .map((m) => (m.role === "user" ? `User: ${m.content}` : `Assistant: ${m.content}`))
    .join("\n") + "\n";
}

// ── Provider call functions ─────────────────────────────────────────────────

async function callGroq(
  apiKey: string, systemPrompt: string, userContent: string,
  groqModel: string, timeoutMs: number, history: HistoryMessage[]
): Promise<string> {
  const client = new Groq({ apiKey });
  const messages: Groq.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content } as Groq.Chat.ChatCompletionMessageParam)),
    { role: "user",   content: userContent },
  ];
  const completion = await withTimeout(
    client.chat.completions.create({ model: groqModel, messages, max_tokens: 512 }),
    timeoutMs
  );
  const text = completion.choices[0]?.message?.content;
  if (!text) throw new Error("Groq returned empty response");
  return text;
}

async function callGemini(apiKey: string, systemPrompt: string, context: string, question: string, history: HistoryMessage[]): Promise<string> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const historyBlock = serializeHistory(history);
  const prompt = `${systemPrompt}\n\n${context}\n\n${historyBlock}User: ${question}`;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const retryable = /503|502|500|overloaded|unavailable|internal/i.test(lastErr.message);
      if (attempt < 3 && retryable) {
        await new Promise<void>((r) => setTimeout(r, 2000));
      } else break;
    }
  }
  throw lastErr ?? new Error("Gemini failed");
}

async function callOpenAI(
  apiKey: string, systemPrompt: string, userContent: string,
  model: string, timeoutMs: number, history: HistoryMessage[]
): Promise<string> {
  const client = new OpenAI({ apiKey });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam)),
    { role: "user",   content: userContent },
  ];
  const completion = await withTimeout(
    client.chat.completions.create({ model, messages, max_tokens: 512 }),
    timeoutMs
  );
  const text = completion.choices[0]?.message?.content;
  if (!text) throw new Error("OpenAI returned empty response");
  return text;
}

async function callAnthropic(
  apiKey: string, systemPrompt: string, userContent: string,
  model: string, timeoutMs: number, history: HistoryMessage[]
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content } as Anthropic.MessageParam)),
    { role: "user", content: userContent },
  ];
  const response = await withTimeout(
    client.messages.create({ model, system: systemPrompt, messages, max_tokens: 512 }),
    timeoutMs
  );
  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text"
  );
  if (!textBlock) throw new Error("Anthropic returned empty response");
  return textBlock.text;
}

// ── Model function factory ──────────────────────────────────────────────────

function buildModelFn(
  modelId: string,
  systemPrompt: string,
  userContent: string,
  context: string,
  question: string,
  history: HistoryMessage[]
): () => Promise<string> {
  const groqKey      = process.env["GROQ_API_KEY"];
  const geminiKey    = process.env["GEMINI_API_KEY"];
  const openaiKey    = process.env["OPENAI_API_KEY"];
  const anthropicKey = process.env["ANTHROPIC_API_KEY"];

  switch (modelId) {
    case "groq-70b":
      if (!groqKey) throw new Error("GROQ_API_KEY not set");
      return () => callGroq(groqKey, systemPrompt, userContent, "llama-3.3-70b-versatile", 8000, history);
    case "gemini-flash":
      if (!geminiKey) throw new Error("GEMINI_API_KEY not set");
      return () => callGemini(geminiKey, systemPrompt, context, question, history);
    case "gpt-4o-mini":
      if (!openaiKey) throw new Error("OPENAI_API_KEY not set");
      return () => callOpenAI(openaiKey, systemPrompt, userContent, "gpt-4o-mini", 15000, history);
    case "gpt-4o":
      if (!openaiKey) throw new Error("OPENAI_API_KEY not set");
      return () => callOpenAI(openaiKey, systemPrompt, userContent, "gpt-4o", 30000, history);
    case "claude-haiku":
      if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set");
      return () => callAnthropic(anthropicKey, systemPrompt, userContent, "claude-haiku-4-5", 10000, history);
    case "claude-sonnet":
      if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY not set");
      return () => callAnthropic(anthropicKey, systemPrompt, userContent, "claude-sonnet-4-5", 20000, history);
    default:
      throw new Error(`Unknown model: ${modelId}`);
  }
}

// ── Public interface ────────────────────────────────────────────────────────

export interface CustomModels {
  simple?:   string;
  moderate?: string;
  complex?:  string;
}

export interface RouterResult {
  answer:           string;
  model:            string;
  modelName:        string;
  complexity:       Complexity;
  latencyMs:        number;
  estimatedCostUSD: number;
}

export async function routeToModel(
  question:      string,
  pageTexts:     PageContext[],
  systemPrompt:  string,
  lengthSuffix:  string,
  summaryCtx?:   string,
  mode:          Mode = "balanced",
  customModels?: CustomModels,
  history:       HistoryMessage[] = [],
): Promise<RouterResult> {
  const start           = Date.now();
  const complexity      = classifyQuestion(question);
  const effectivePrompt = systemPrompt + lengthSuffix;
  const context         = buildContext(pageTexts, complexity, summaryCtx);
  const userContent     = `${context}\n\nQuestion: ${question}`;

  const geminiKey = process.env["GEMINI_API_KEY"];
  if (!geminiKey) throw new Error("GEMINI_API_KEY is not configured.");

  // Determine model chain
  let modelChain: string[];
  if (customModels && customModels[complexity]) {
    modelChain = [customModels[complexity]!, "gemini-flash"];
  } else {
    modelChain = MODE_CHAINS[mode]?.[complexity] ?? MODE_CHAINS["balanced"][complexity];
  }

  // Build executable specs, skipping models with missing API keys
  type ModelSpec = { id: string; fn: () => Promise<string> };
  const models: ModelSpec[] = [];
  for (const modelId of modelChain) {
    try {
      const fn = buildModelFn(modelId, effectivePrompt, userContent, context, question, history);
      models.push({ id: modelId, fn });
    } catch (err) {
      console.warn(`[modelRouter] skipping ${modelId}: ${(err as Error).message}`);
    }
  }

  // Always ensure gemini-flash is available as final safety net
  if (models.length === 0 || !models.some((m) => m.id === "gemini-flash")) {
    try {
      models.push({
        id: "gemini-flash",
        fn: buildModelFn("gemini-flash", effectivePrompt, userContent, context, question, history),
      });
    } catch {}
  }

  if (models.length === 0) throw new Error("No models available — check API keys.");

  const primaryId = models[0].id;
  let lastErr: Error | null = null;

  for (const { id, fn } of models) {
    try {
      const answer    = await fn();
      const latencyMs = Date.now() - start;
      const { estimatedCostUSD } = estimateCost(userContent.length, answer.length, id);
      const modelName = MODEL_COSTS[id]?.name ?? id;

      if (id === primaryId) {
        console.log(`[modelRouter] complexity: ${complexity} | mode: ${mode} | model: ${id} | history: ${history.length} msgs | ${latencyMs}ms | $${estimatedCostUSD.toFixed(6)}`);
      } else {
        console.log(`[modelRouter] complexity: ${complexity} | mode: ${mode} | primary: ${primaryId} → fallback: ${id} | ${latencyMs}ms`);
      }
      return { answer, model: id, modelName, complexity, latencyMs, estimatedCostUSD };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      console.warn(`[modelRouter] model: ${id} | failed: ${lastErr.message.slice(0, 100)}`);
    }
  }

  throw lastErr ?? new Error("All models failed");
}
