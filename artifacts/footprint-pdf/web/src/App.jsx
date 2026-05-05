import { useCallback, useEffect, useRef, useState } from "react";
import PreviewMode from "./PreviewMode.jsx";
import Workspace   from "./Workspace.jsx";
import OnboardingBubble from "./OnboardingBubble.jsx";
import FeedbackModal from "./FeedbackModal.jsx";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const OCR_CHAR_THRESHOLD = 50;

// appState: 'idle' | 'loading' | 'preview' | 'workspace'

export default function App() {
  const [appState,      setAppState]      = useState("idle");
  const [file,          setFile]          = useState(null);
  const [meta,          setMeta]          = useState(null);
  const [extractedText, setExtractedText] = useState("");
  const [pageTexts,     setPageTexts]     = useState([]);
  const [pageTitles,    setPageTitles]    = useState([]);
  const [pageSheets,    setPageSheets]    = useState([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadEta,      setUploadEta]     = useState(null);
  const [uploadDone,     setUploadDone]    = useState(false);
  const [error,          setError]         = useState("");
  const [isOcring,       setIsOcring]      = useState(false);
  const [ocrProgress,    setOcrProgress]   = useState({ page: 0, total: 0 });

  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackDone, setFeedbackDone] = useState(false);

  const inputRef        = useRef(null);
  const ocrAbortRef     = useRef(null);
  const feedbackDoneRef = useRef(false);
  const leaveTimerRef   = useRef(null);

  // Keep ref in sync so the event listener always sees fresh value
  useEffect(() => { feedbackDoneRef.current = feedbackDone; }, [feedbackDone]);

  // beforeunload approach: browser shows native "Leave site?" dialog;
  // if user clicks Stay the page remains active and our setTimeout fires
  // to show the custom modal. If they click Leave, pagehide fires first
  // and we clear the timer so the modal never appears.
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (feedbackDoneRef.current) return;
      e.preventDefault();
      e.returnValue = ""; // required for Chrome to show the native dialog
      leaveTimerRef.current = setTimeout(() => {
        setShowFeedback(true);
      }, 200);
    };
    const handlePageHide = () => {
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide",     handlePageHide);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide",     handlePageHide);
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    };
  }, []);

  const reset = () => {
    if (ocrAbortRef.current) ocrAbortRef.current.abort();
    setAppState("idle");
    setFile(null); setMeta(null); setExtractedText(""); setPageTexts([]);
    setPageTitles([]); setPageSheets([]);
    setError(""); setUploadProgress(0); setUploadEta(null); setUploadDone(false);
    setIsOcring(false); setOcrProgress({ page: 0, total: 0 });
    if (inputRef.current) inputRef.current.value = "";
  };

  const uploadFile = useCallback((selected) => {
    setAppState("loading");
    setError("");
    setMeta(null); setExtractedText(""); setPageTexts([]);
    setPageTitles([]); setPageSheets([]);
    setIsOcring(false); setOcrProgress({ page: 0, total: 0 });
    setFile(selected);
    setUploadProgress(0); setUploadEta(null); setUploadDone(false);

    const formData = new FormData();
    formData.append("file", selected);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/pdf-api/upload");
    xhr.timeout = 300_000; // 5-minute hard cap
    const startTime = Date.now();

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const pct = (event.loaded / event.total) * 100;
      setUploadProgress(pct);
      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > 0.2 && event.loaded > 0) {
        setUploadEta((event.total - event.loaded) / (event.loaded / elapsed));
      }
    });

    xhr.upload.addEventListener("loadend", () => {
      setUploadProgress(100); setUploadEta(0); setUploadDone(true);
    });

    xhr.addEventListener("load", async () => {
      try {
        if (xhr.status < 200 || xhr.status >= 300) {
          let msg = `Upload failed (${xhr.status})`;
          try { const d = JSON.parse(xhr.responseText); if (d.error) msg = d.error; } catch {}
          throw new Error(msg);
        }
        const data = JSON.parse(xhr.responseText);

        // ── Phase 1: open workspace immediately with basic metadata ──────────
        setMeta({ filename: data.filename, size: data.size, pages: data.pages, info: data.info });
        setPageTexts(Array(data.pages).fill(""));
        setPageTitles(Array(data.pages).fill(""));
        setPageSheets(Array(data.pages).fill(""));
        setExtractedText("");
        setAppState("workspace");

        // ── Phase 2: extract text client-side using pdfjs (already loaded) ──
        const extractCtrl = new AbortController();
        ocrAbortRef.current = extractCtrl;
        let pageTexts = [];
        try {
          const extracted = await runTextExtraction(selected, data.pages, extractCtrl.signal);
          if (extractCtrl.signal.aborted) return;
          pageTexts = extracted.pageTexts;
          setPageTexts(pageTexts);
          setPageTitles(extracted.pageTitles);
          setPageSheets(extracted.pageSheets);
          setExtractedText(pageTexts.join("\n\n"));
        } catch (e) {
          if (!extractCtrl.signal.aborted) setError(`Text extraction failed: ${e.message}`);
          return;
        }

        // ── Phase 3: OCR fallback for scanned PDFs ───────────────────────────
        const avgChars = pageTexts.length > 0
          ? pageTexts.reduce((s, t) => s + (t || "").length, 0) / pageTexts.length
          : 0;
        if (avgChars < OCR_CHAR_THRESHOLD && data.pages > 0) {
          setIsOcring(true);
          const ocrCtrl = new AbortController();
          ocrAbortRef.current = ocrCtrl;
          try {
            const ocrTexts = await runOcr(selected, data.pages,
              (pg, total) => setOcrProgress({ page: pg, total }),
              ocrCtrl.signal,
            );
            if (!ocrCtrl.signal.aborted) {
              setPageTexts(ocrTexts);
              setExtractedText(ocrTexts.join("\n\n"));
            }
          } catch (e) {
            if (!ocrCtrl.signal.aborted) setError(`OCR failed: ${e.message}`);
          } finally {
            setIsOcring(false); setOcrProgress({ page: 0, total: 0 });
          }
        }
      } catch (err) {
        setError(err.message || "Upload failed");
        setFile(null); setAppState("idle");
      }
    });

    xhr.addEventListener("error", () => {
      setError("Network error during upload");
      setFile(null); setAppState("idle");
    });
    xhr.addEventListener("timeout", () => {
      setError("Upload timed out — the document may be too large or complex. Try a smaller PDF.");
      setFile(null); setAppState("idle");
    });
    xhr.addEventListener("abort", () => setAppState("idle"));
    xhr.send(formData);
  }, []);

  const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
  const SIZE_ERROR = "This file exceeds the 500MB testing limit. Please contact us at info@footprintnavigator.com for large file support.";

  const onFileChange = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_FILE_SIZE) { setError(SIZE_ERROR); return; }
    uploadFile(f);
  };
  const onDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    if (f.size > MAX_FILE_SIZE) { setError(SIZE_ERROR); return; }
    if (f.type === "application/pdf") uploadFile(f);
    else setError("Please drop a PDF document");
  };

  const handleFeedbackClose = () => {
    setShowFeedback(false);
    setFeedbackDone(true);
  };

  return (
    <div className="app">
      {/* ── Feedback modal (triggered by tab close / beforeunload) ── */}
      {showFeedback && <FeedbackModal onClose={handleFeedbackClose} />}

      {/* ── Onboarding bubble (landing + loading screens) ── */}
      {(appState === "idle" || appState === "loading") && <OnboardingBubble />}

      {/* ── Drop zone ── */}
      {appState === "idle" && (
        <>
          <header className="header">
            <div className="brand">
              <img src="./footprint-logo.png" alt="Footprint Navigator logo" className="logo-img" />
              <div>
                <h1>Footprint Navigator</h1>
                <p className="tagline">Tread boldly.</p>
              </div>
            </div>
          </header>
          <main className="main">
            <section
              className="dropzone"
              onDrop={onDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => inputRef.current?.click()}
            >
              <input ref={inputRef} type="file" accept=".pdf,application/pdf" onChange={onFileChange} hidden />
              <div className="dropzone-inner">
                <div className="dropzone-icon">
                  <svg viewBox="0 0 24 24" width="48" height="48" fill="none">
                    <path d="M12 16V4m0 0-4 4m4-4 4 4" stroke="#007BFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="#007BFF" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </div>
                <h2>Drop a document to begin</h2>
                <p>or click to browse</p>
                <p className="upload-hint">Accepts PDF files only · 500MB limit during testing</p>
                <button type="button" className="btn primary">Choose Document</button>
              </div>
              {error && <p className="error">{error}</p>}
            </section>
          </main>
        </>
      )}

      {/* ── Loading ── */}
      {appState === "loading" && (
        <>
          <header className="header">
            <div className="brand">
              <img src="./footprint-logo.png" alt="Footprint Navigator logo" className="logo-img" />
              <div>
                <h1>Footprint Navigator</h1>
                <p className="tagline">Tread boldly.</p>
              </div>
            </div>
          </header>
          <main className="main">
            <section className="loading">
              <div className="upload-card">
                <p className="upload-status">{uploadDone ? "Reading your document…" : "Uploading…"}</p>
                <div className="progress-bar" role="progressbar" aria-valuenow={Math.round(uploadProgress)} aria-valuemin="0" aria-valuemax="100">
                  <div
                    className={`progress-fill ${uploadDone ? "indeterminate" : ""}`}
                    style={uploadDone ? undefined : { width: `${uploadProgress}%` }}
                  />
                </div>
                <div className="progress-meta">
                  <span className="percent">{Math.round(uploadProgress)}%</span>
                  <span className="eta">
                    {uploadDone ? "Extracting text…"
                      : uploadEta != null ? `${formatEta(uploadEta)} remaining`
                      : "Calculating…"}
                  </span>
                </div>
              </div>
            </section>
          </main>
        </>
      )}

      {/* ── Preview ── */}
      {appState === "preview" && file && meta && (
        <PreviewMode
          file={file}
          meta={meta}
          pageTexts={pageTexts}
          extractedText={extractedText}
          onUseDocument={() => setAppState("workspace")}
        />
      )}

      {/* ── Full Workspace ── */}
      {appState === "workspace" && file && meta && (
        <Workspace
          file={file}
          meta={meta}
          pageTexts={pageTexts}
          pageTitles={pageTitles}
          pageSheets={pageSheets}
          isOcring={isOcring}
          ocrProgress={ocrProgress}
          onNewFile={reset}
        />
      )}
    </div>
  );
}

// ── Title / sheet patterns (mirrors server-side extractPageMeta) ──────────────

const TITLE_PATTERNS = [
  /REFLECTED CEILING PLAN/i, /FOUNDATION PLAN/i, /FRAMING PLAN/i,
  /ELECTRICAL PLAN/i, /PLUMBING PLAN/i, /MECHANICAL PLAN/i,
  /LANDSCAPE PLAN/i, /FLOOR PLAN/i, /ROOF PLAN/i, /SITE PLAN/i,
  /ELEVATION/i, /SECTION/i, /SCHEDULE/i, /DETAIL/i, /\bRCP\b/,
];
const SHEET_PATTERNS = [
  /^[A-Z]{1,3}[-.]?\d{1,2}[-.]\d{2,3}$/, /^[ASMEPLCFI]\d{3}$/, /^[A-Z]{1,3}-\d{3}$/,
];

function extractPageMetaClient(items, pageW, pageH) {
  const valid = items.filter((i) => typeof i.str === "string" && i.str.trim().length > 0);
  const isSheetNum = (s) => SHEET_PATTERNS.some((re) => re.test(s.trim()));

  let sheet = "";
  const bottomRight = valid
    .filter((item) => { const [,,,, x, y] = item.transform; return x >= pageW * 0.65 && y <= pageH * 0.25; })
    .sort((a, b) => Math.hypot(pageW - a.transform[4], a.transform[5]) - Math.hypot(pageW - b.transform[4], b.transform[5]));
  for (const item of bottomRight) {
    if (isSheetNum(item.str.trim())) { sheet = item.str.trim(); break; }
  }

  let title = "";
  const rightText = valid.filter((i) => i.transform[4] >= pageW * 0.7).map((i) => i.str).join(" ");
  for (const re of TITLE_PATTERNS) { const m = rightText.match(re); if (m) { title = m[0].toUpperCase(); break; } }
  if (!title) {
    const fullText = valid.map((i) => i.str).join(" ");
    for (const re of TITLE_PATTERNS) { const m = fullText.match(re); if (m) { title = m[0].toUpperCase(); break; } }
  }
  return { title, sheet };
}

// ── Client-side text extraction (pdfjs already loaded for viewing) ────────────

async function runTextExtraction(file, numPages, signal) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pageTexts = [], pageTitles = [], pageSheets = [];
  try {
    for (let i = 1; i <= numPages; i++) {
      if (signal?.aborted) break;
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: true });
      const items = tc.items.filter((it) => "str" in it);
      const text = items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
      const { title, sheet } = extractPageMetaClient(items, viewport.width, viewport.height);
      pageTexts.push(text);
      pageTitles.push(title);
      pageSheets.push(sheet);
    }
  } finally {
    await pdf.destroy();
  }
  return { pageTexts, pageTitles, pageSheets };
}

// ── OCR Helper ────────────────────────────────────────────────────────────────

async function runOcr(file, numPages, onProgress, signal) {
  const { createWorker } = await import("tesseract.js");
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const tessWorker = await createWorker("eng");
  const texts = [];
  try {
    for (let i = 1; i <= numPages; i++) {
      if (signal?.aborted) break;
      onProgress(i, numPages);
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement("canvas");
      canvas.width  = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      const { data: { text } } = await tessWorker.recognize(canvas);
      texts.push(text.trim());
    }
  } finally {
    await tessWorker.terminate();
    await pdf.destroy();
  }
  return texts;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 1) return "less than 1s";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
}
