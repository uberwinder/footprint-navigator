import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
// @ts-expect-error pdf-parse has no types and the index file probes a sample PDF at import time
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"));
    }
  },
});

interface PdfParseResult {
  text: string;
  numpages: number;
  numrender: number;
  info: Record<string, unknown> | null;
  metadata: unknown;
  version: string;
}

interface TextItem {
  str: string;
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
}

// Drawing title keywords found in construction sets
const TITLE_PATTERNS: RegExp[] = [
  /REFLECTED CEILING PLAN/i,
  /FOUNDATION PLAN/i,
  /FRAMING PLAN/i,
  /ELECTRICAL PLAN/i,
  /PLUMBING PLAN/i,
  /MECHANICAL PLAN/i,
  /LANDSCAPE PLAN/i,
  /FLOOR PLAN/i,
  /ROOF PLAN/i,
  /SITE PLAN/i,
  /ELEVATION/i,
  /SECTION/i,
  /SCHEDULE/i,
  /DETAIL/i,
  /\bRCP\b/,
];

const SHEET_PATTERNS: RegExp[] = [
  /^[A-Z]{1,3}[-.]?\d{1,2}[-.]\d{2,3}$/,
  /^[ASMEPLCFI]\d{3}$/,
  /^[A-Z]{1,3}-\d{3}$/,
];

function extractPageMeta(
  items: TextItem[],
  pageW: number,
  pageH: number,
): { title: string; sheet: string } {
  const valid = items.filter(
    (i) => typeof i.str === "string" && i.str.trim().length > 0,
  );

  // ── Sheet number: short text in the bottom-right title block ──────────────
  let sheet = "";
  const isSheetNum = (s: string) =>
    SHEET_PATTERNS.some((re) => re.test(s.trim()));

  // Sort candidates by proximity to bottom-right corner (low y = bottom in PDF)
  const bottomRight = valid
    .filter((item) => {
      const [, , , , x, y] = item.transform;
      return x >= pageW * 0.65 && y <= pageH * 0.25;
    })
    .sort((a, b) => {
      const distA = Math.hypot(pageW - a.transform[4], a.transform[5]);
      const distB = Math.hypot(pageW - b.transform[4], b.transform[5]);
      return distA - distB;
    });

  for (const item of bottomRight) {
    if (isSheetNum(item.str.trim())) {
      sheet = item.str.trim();
      break;
    }
  }

  // ── Page title: title pattern in the right 30% of the page ───────────────
  let title = "";

  // Attempt 1: look for a title pattern on the right side (title block area)
  const rightItems = valid.filter(
    (item) => item.transform[4] >= pageW * 0.7,
  );
  const rightText = rightItems.map((i) => i.str).join(" ");
  for (const re of TITLE_PATTERNS) {
    const m = rightText.match(re);
    if (m) {
      title = m[0].toUpperCase();
      break;
    }
  }

  // Attempt 2: search the full page text for a title pattern
  if (!title) {
    const fullText = valid.map((i) => i.str).join(" ");
    for (const re of TITLE_PATTERNS) {
      const m = fullText.match(re);
      if (m) {
        title = m[0].toUpperCase();
        break;
      }
    }
  }

  return { title, sheet };
}

router.post(
  "/upload",
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const pageTexts: string[] = [];
      const pageTitles: string[] = [];
      const pageSheets: string[] = [];

      const result: PdfParseResult = await pdfParse(req.file.buffer, {
        pagerender: async (pageData: {
          pageNumber: number;
          getViewport: (opts: { scale: number }) => { width: number; height: number };
          getTextContent: (opts: {
            normalizeWhitespace: boolean;
            disableCombineTextItems: boolean;
          }) => Promise<{ items: TextItem[] }>;
        }) => {
          // Get page dimensions for position-based extraction
          const viewport = pageData.getViewport({ scale: 1 });
          const pageW = viewport.width;
          const pageH = viewport.height;

          // Use disableCombineTextItems:true to preserve per-item transforms
          const textContent = await pageData.getTextContent({
            normalizeWhitespace: true,
            disableCombineTextItems: true,
          });

          const items = textContent.items as TextItem[];
          const text = items
            .map((item) => item.str)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();

          const { title, sheet } = extractPageMeta(items, pageW, pageH);

          const idx = pageData.pageNumber - 1;
          pageTexts[idx] = text;
          pageTitles[idx] = title;
          pageSheets[idx] = sheet;

          return text;
        },
      });

      // Fill any holes
      for (let i = 0; i < result.numpages; i += 1) {
        if (typeof pageTexts[i] !== "string") pageTexts[i] = "";
        if (typeof pageTitles[i] !== "string") pageTitles[i] = "";
        if (typeof pageSheets[i] !== "string") pageSheets[i] = "";
      }

      return res.json({
        filename: req.file.originalname,
        size: req.file.size,
        pages: result.numpages,
        text: result.text,
        pageTexts,
        pageTitles,
        pageSheets,
        info: result.info ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  },
);

export default router;
