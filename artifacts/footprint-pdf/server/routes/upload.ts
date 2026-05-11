import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
// @ts-expect-error pdf-parse has no types and the index file probes a sample PDF at import time
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const router: IRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
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

      // Fast metadata-only parse — no text extraction (client handles that).
      // Using a no-op pagerender avoids calling getTextContent() on every page,
      // which is the expensive step. numpages and info are still populated.
      let pages = 0;
      let info: Record<string, unknown> | null = null;
      try {
        const result: PdfParseResult = await pdfParse(req.file.buffer, {
          pagerender: async () => "",
        });
        pages = result.numpages;
        info  = result.info ?? null;
        console.log(`[upload] pdf-parse OK — pages: ${pages}, file: ${req.file.originalname}, size: ${(req.file.size / 1024 / 1024).toFixed(1)} MB`);
      } catch (parseErr) {
        // pdf-parse fails on some large or complex PDFs. Fall back gracefully —
        // the client uses pdfjs-dist to load the PDF natively and will determine
        // the real page count itself during text extraction.
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        console.warn(`[upload] pdf-parse failed for "${req.file.originalname}" (${(req.file.size / 1024 / 1024).toFixed(1)} MB): ${msg} — falling back to pages:0`);
        pages = 0;
        info  = null;
      }

      return res.json({
        filename: req.file.originalname,
        size: req.file.size,
        pages,
        info,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[upload] unexpected error: ${message}`);
      return res.status(500).json({ error: message });
    }
  },
);

// Multer error handler — must be registered after the route so Express sees it
// as a 4-argument error middleware. Without this, multer errors (file too large,
// wrong mime type) drop the connection instead of returning JSON, causing the
// client to see "Network error" instead of a proper error message.
router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "File too large — maximum upload size is 500 MB"
        : `Upload error: ${err.message}`;
    res.status(413).json({ error: message });
    return;
  }
  if (err instanceof Error) {
    res.status(400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: "Unknown upload error" });
});

export default router;
