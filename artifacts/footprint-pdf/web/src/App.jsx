import { useCallback, useEffect, useRef, useState, Component } from "react";
import PreviewMode from "./PreviewMode.jsx";
import Workspace   from "./Workspace.jsx";
import FeedbackModal from "./FeedbackModal.jsx";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// ── Error boundary ────────────────────────────────────────────────────────────
class WorkspaceErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(err) {
    return { error: err };
  }
  componentDidCatch(err, info) {
    console.error("[WorkspaceErrorBoundary] React crash in Workspace tree:", err, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: "40px", color: "#fff", background: "#1a1a1a", height: "100vh", boxSizing: "border-box" }}>
          <h2 style={{ color: "#ff5a5f", marginBottom: "12px" }}>Something went wrong loading the workspace</h2>
          <pre style={{ background: "#111", padding: "16px", borderRadius: "6px", fontSize: "12px", whiteSpace: "pre-wrap", color: "#f88" }}>
            {this.state.error?.message || String(this.state.error)}
          </pre>
          <button
            style={{ marginTop: "20px", padding: "10px 20px", background: "#007bff", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer" }}
            onClick={() => { this.setState({ error: null }); this.props.onReset?.(); }}
          >
            Return to upload screen
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Discipline detection & sort ───────────────────────────────────────────────
const DISCIPLINE_ORDER = ["G", "D", "C", "L", "S", "A", "ID", "M", "P", "E", "FP", "FA"];
const DISCIPLINE_NAMES = {
  G: "General", D: "Demolition", C: "Civil", L: "Landscape",
  S: "Structural", A: "Architectural", ID: "Interior Design",
  M: "Mechanical", P: "Plumbing", E: "Electrical",
  FP: "Fire Protection", FA: "Fire Alarm",
};

function detectDiscipline(filename) {
  const base = filename.replace(/\.pdf$/i, "").trim();
  if (/^(00|Cover)/i.test(base)) return { prefix: "G", order: 0 };
  // FA and FP before F; ID before I — order matters in the alternation
  const m = base.match(/^(FA|FP|ID|G|D|C|L|S|A|M|P|E)(\d|\.|-|\s|$)/i);
  if (m) {
    const prefix = m[1].toUpperCase();
    const order = DISCIPLINE_ORDER.indexOf(prefix);
    return { prefix, order: order >= 0 ? order : DISCIPLINE_ORDER.length };
  }
  return { prefix: "", order: DISCIPLINE_ORDER.length };
}

function getSheetNum(filename) {
  const base = filename.replace(/\.pdf$/i, "").trim();
  const m = base.match(/^[A-Z]{1,2}(\d+(?:[.\-]\d+)?)/i);
  return m ? parseFloat(m[1].replace("-", ".")) : 9999;
}

function sortFilesByDiscipline(files) {
  return [...files].sort((a, b) => {
    const da = detectDiscipline(a.name);
    const db = detectDiscipline(b.name);
    if (da.order !== db.order) return da.order - db.order;
    return getSheetNum(a.name) - getSheetNum(b.name);
  });
}

// ── Constants ─────────────────────────────────────────────────────────────────
const OCR_CHAR_THRESHOLD = 50;
const MAX_FILE_SIZE  = 500 * 1024 * 1024;        // 500 MB per file
const MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024;   // 2 GB combined
const MAX_FILES      = 500;

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
  const [onboardDone,  setOnboardDone]  = useState(false);

  // ── Multi-file state ────────────────────────────────────────────────────────
  // multiModal: 'closed' | 'choosing' | 'sorting' | 'combining'
  const [multiModal,    setMultiModal]    = useState("closed");
  const [pendingFiles,  setPendingFiles]  = useState([]);   // raw File[] from drop
  const [combineFiles,  setCombineFiles]  = useState([]);   // ordered File[] for combine modal
  const [combineName,   setCombineName]   = useState("Combined Documents.pdf");
  const [combineProgress, setCombineProgress] = useState({ current: 0, total: 0, filename: "" });
  const [combineErrors, setCombineErrors] = useState([]);   // filenames that failed
  const [sameProject,   setSameProject]   = useState(false);
  // Passed into Workspace so extra tabs are auto-loaded after primary mounts
  const [pendingTabFiles,          setPendingTabFiles]          = useState([]);
  const [extraFilesAsSameProject,  setExtraFilesAsSameProject]  = useState(false);
  const [pendingProjectName,       setPendingProjectName]       = useState(null);

  // ── Sample documents modal ───────────────────────────────────────────────────
  const [showSampleModal, setShowSampleModal] = useState(false);
  const [sampleLoading,   setSampleLoading]   = useState(null);
  const [isSampleProject, setIsSampleProject] = useState(false);
  const [sampleProgress,  setSampleProgress]  = useState({ drawings: 0, specs: 0 });

  const inputRef        = useRef(null);
  const ocrAbortRef     = useRef(null);
  const feedbackDoneRef = useRef(false);
  const leaveTimerRef   = useRef(null);
  const dragIndexRef    = useRef(null);

  useEffect(() => { feedbackDoneRef.current = feedbackDone; }, [feedbackDone]);

  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (feedbackDoneRef.current) return;
      e.preventDefault();
      e.returnValue = "";
      leaveTimerRef.current = setTimeout(() => { setShowFeedback(true); }, 200);
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
    setPendingTabFiles([]); setExtraFilesAsSameProject(false); setPendingProjectName(null);
    setSampleLoading(null); setSampleProgress({ drawings: 0, specs: 0 }); setIsSampleProject(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const uploadFile = useCallback((selected, { keepProjectState = false } = {}) => {
    setAppState("loading");
    setError("");
    setMeta(null); setExtractedText(""); setPageTexts([]);
    setPageTitles([]); setPageSheets([]);
    setIsOcring(false); setOcrProgress({ page: 0, total: 0 });
    setFile(selected);
    setUploadProgress(0); setUploadEta(null); setUploadDone(false);
    // Clear all project-association state unless this upload is intentionally
    // part of a multi-doc session (e.g. the sample project loader).
    if (!keepProjectState) {
      setPendingTabFiles([]); setExtraFilesAsSameProject(false); setPendingProjectName(null);
    }

    const formData = new FormData();
    formData.append("file", selected);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/pdf-api/upload");
    xhr.timeout = 600_000;
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
      console.log(`[upload] XHR response — status: ${xhr.status}, body: ${xhr.responseText.slice(0, 300)}`);
      try {
        if (xhr.status < 200 || xhr.status >= 300) {
          let msg = `Upload failed (${xhr.status})`;
          try { const d = JSON.parse(xhr.responseText); if (d.error) msg = d.error; } catch {}
          throw new Error(msg);
        }
        const data = JSON.parse(xhr.responseText);

        setMeta({ filename: data.filename, size: data.size, pages: data.pages, info: data.info });
        setPageTexts(Array(data.pages).fill(""));
        setPageTitles(Array(data.pages).fill(""));
        setPageSheets(Array(data.pages).fill(""));
        setExtractedText("");
        setAppState("workspace");

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

  // ── Multi-file validation & routing ──────────────────────────────────────────
  const handleFilesSelected = useCallback((rawFiles) => {
    setError("");
    const arr = Array.from(rawFiles).filter(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
    );
    if (arr.length === 0) { setError("Please select PDF files"); return; }
    if (arr.length > MAX_FILES) { setError(`Maximum ${MAX_FILES} files at once`); return; }

    const tooLarge = arr.find((f) => f.size > MAX_FILE_SIZE);
    if (tooLarge) {
      setError(`"${tooLarge.name}" exceeds the 500MB limit.`);
      return;
    }
    const totalSize = arr.reduce((s, f) => s + f.size, 0);
    if (totalSize > MAX_TOTAL_SIZE) {
      setError("Total file size exceeds 2GB limit. Please reduce the number of files and try again.");
      return;
    }

    if (arr.length === 1) {
      uploadFile(arr[0]);
      return;
    }

    setPendingFiles(arr);
    setSameProject(false);
    setMultiModal("choosing");
  }, [uploadFile]);

  // ── Combine flow handlers ─────────────────────────────────────────────────────
  const handleCombineStart = useCallback(() => {
    const sorted = sortFilesByDiscipline(pendingFiles);
    setCombineFiles(sorted);
    setCombineName("Combined Documents.pdf");
    setCombineErrors([]);
    setCombineProgress({ current: 0, total: sorted.length, filename: "" });
    setMultiModal("sorting");
  }, [pendingFiles]);

  const handleOpenAsTabs = useCallback(() => {
    setMultiModal("closed");
    const [first, ...rest] = pendingFiles;
    setPendingTabFiles(rest);
    setExtraFilesAsSameProject(sameProject);
    uploadFile(first);
  }, [pendingFiles, sameProject, uploadFile]);

  const handleCombineConfirm = useCallback(async () => {
    if (combineFiles.length === 0) return;
    setMultiModal("combining");
    setCombineErrors([]);
    setCombineProgress({ current: 0, total: combineFiles.length, filename: "" });

    const { PDFDocument } = await import("pdf-lib");
    const combined = await PDFDocument.create();
    const errors = [];

    for (let i = 0; i < combineFiles.length; i++) {
      const f = combineFiles[i];
      setCombineProgress({ current: i + 1, total: combineFiles.length, filename: f.name });
      try {
        const bytes = await f.arrayBuffer();
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const indices = src.getPageIndices();
        const copied = await combined.copyPages(src, indices);
        copied.forEach((p) => combined.addPage(p));
      } catch (err) {
        console.error(`[combine] failed for "${f.name}":`, err);
        errors.push(f.name);
      }
    }

    if (errors.length > 0) setCombineErrors(errors);

    const combinedBytes = await combined.save();
    const blob = new Blob([combinedBytes], { type: "application/pdf" });

    // Trigger download BEFORE opening viewer so user definitely gets the file
    const dlUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = dlUrl;
    a.download = combineName || "Combined Documents.pdf";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(dlUrl), 15_000);

    // Open in viewer
    const combinedFile = new File([combinedBytes], combineName || "Combined Documents.pdf", {
      type: "application/pdf",
    });
    setMultiModal("closed");
    uploadFile(combinedFile);
  }, [combineFiles, combineName, uploadFile]);

  // ── Sample project loader ─────────────────────────────────────────────────────
  // Downloads via Express proxy (/pdf-api/sample/*) to avoid R2 CORS issues.
  // Files are loaded directly into the browser as ArrayBuffers — the server
  // upload endpoint (/pdf-api/upload) is never called, so Render never buffers
  // 151 MB in RAM and the free-tier 502 is eliminated entirely.
  const [sampleError, setSampleError] = useState(null);

  const loadSampleProject = useCallback(() => {
    console.log("[sample] v2 - bypass active - no upload");
    setSampleLoading(true);
    setIsSampleProject(true);
    setSampleError(null);
    setSampleProgress({ drawings: 0, specs: 0 });

    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

    // responseType "arraybuffer" — progress events work identically to "blob"
    const downloadXHR = (url, key) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "arraybuffer";
      xhr.onprogress = (e) => {
        if (e.lengthComputable) {
          setSampleProgress((prev) => ({ ...prev, [key]: Math.round((e.loaded / e.total) * 100) }));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setSampleProgress((prev) => ({ ...prev, [key]: 100 }));
          resolve(xhr.response); // ArrayBuffer
        } else {
          reject(new Error(`HTTP ${xhr.status} on ${key}`));
        }
      };
      xhr.onerror  = () => reject(new Error(`Network error fetching ${key}`));
      xhr.ontimeout = () => reject(new Error(`Timeout fetching ${key}`));
      console.log(`[sample] starting download: ${url}`);
      xhr.send();
    });

    Promise.all([
      downloadXHR(`${base}/pdf-api/sample/drawings`, "drawings"),
      downloadXHR(`${base}/pdf-api/sample/specs`,    "specs"),
    ]).then(async ([drawingsBuffer, specsBuffer]) => {
      console.log(`[sample] downloads complete — drawings: ${(drawingsBuffer.byteLength / 1024 / 1024).toFixed(1)} MB, specs: ${(specsBuffer.byteLength / 1024 / 1024).toFixed(1)} MB`);

      // ── Count pages client-side via pdfjs (zero server RAM) ───────────────
      // Use .slice(0) so the original buffer isn't transferred/detached before
      // we wrap it in a File for text extraction.
      let pages = 0;
      try {
        const pdfDoc = await pdfjsLib.getDocument({ data: drawingsBuffer.slice(0) }).promise;
        pages = pdfDoc.numPages;
        await pdfDoc.destroy();
        console.log(`[sample] pdfjs page count: ${pages}`);
      } catch (e) {
        console.warn("[sample] pdfjs page count failed, defaulting to 0:", e.message);
      }

      // ── Wrap in File objects (runTextExtraction and loadExtraDoc expect File) ─
      const drawingsFile = new File([drawingsBuffer], "Wimbish_Gym_Addition_Drawings.pdf",      { type: "application/pdf" });
      const specsFile    = new File([specsBuffer],    "Wimbish_Gym_Addition_Specifications.pdf", { type: "application/pdf" });

      // ── Set state directly — mirrors uploadFile's XHR onload handler ────────
      // Server upload endpoint never called → 0 bytes of RAM on Render.
      setShowSampleModal(false);
      setSampleLoading(null);
      setError("");
      setFile(drawingsFile);
      setMeta({ filename: drawingsFile.name, size: drawingsBuffer.byteLength, pages, info: null });
      setPageTexts(Array(pages).fill(""));
      setPageTitles(Array(pages).fill(""));
      setPageSheets(Array(pages).fill(""));
      setExtractedText("");
      setUploadProgress(100);
      setUploadDone(true);
      // Specs go into pendingTabFiles → Workspace's loadExtraDoc handles them
      // client-side (also never touches the upload endpoint).
      setPendingTabFiles([specsFile]);
      setExtraFilesAsSameProject(true);
      setPendingProjectName("Sample");
      setAppState("workspace");

      // ── Background text extraction ──────────────────────────────────────────
      const extractCtrl = new AbortController();
      ocrAbortRef.current = extractCtrl;
      let extractedPageTexts = [];
      try {
        const extracted = await runTextExtraction(drawingsFile, pages, extractCtrl.signal);
        if (extractCtrl.signal.aborted) return;
        extractedPageTexts = extracted.pageTexts;
        setPageTexts(extractedPageTexts);
        setPageTitles(extracted.pageTitles);
        setPageSheets(extracted.pageSheets);
        setExtractedText(extractedPageTexts.join("\n\n"));
      } catch (e) {
        if (!extractCtrl.signal.aborted) setError(`Text extraction failed: ${e.message}`);
        return;
      }

      // ── OCR fallback if text-sparse ─────────────────────────────────────────
      const avgChars = extractedPageTexts.length > 0
        ? extractedPageTexts.reduce((s, t) => s + (t || "").length, 0) / extractedPageTexts.length
        : 0;
      if (avgChars < OCR_CHAR_THRESHOLD && pages > 0) {
        setIsOcring(true);
        const ocrCtrl = new AbortController();
        ocrAbortRef.current = ocrCtrl;
        try {
          const ocrTexts = await runOcr(drawingsFile, pages,
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
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : "Network error";
      console.error("[sample] load failed:", msg);
      setSampleLoading(null);
      setSampleError(msg);
    });
  }, []); // all deps are stable refs, setters, or module-level constants

  // ── Drag-to-reorder for combine file list ─────────────────────────────────────
  const handleDragStart = useCallback((index) => { dragIndexRef.current = index; }, []);
  const handleDragOver  = useCallback((e, index) => {
    e.preventDefault();
    if (dragIndexRef.current === null || dragIndexRef.current === index) return;
    setCombineFiles((prev) => {
      const next = [...prev];
      const [dragged] = next.splice(dragIndexRef.current, 1);
      next.splice(index, 0, dragged);
      dragIndexRef.current = index;
      return next;
    });
  }, []);
  const handleDragEnd   = useCallback(() => { dragIndexRef.current = null; }, []);

  // ── Original single-file handlers (unchanged path) ────────────────────────────
  const onFileChange = (e) => {
    const files = e.target.files;
    if (!files?.length) return;
    if (inputRef.current) inputRef.current.value = "";
    handleFilesSelected(files);
  };

  const onDrop = (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (!files?.length) return;
    // Check all are PDFs
    const nonPdf = Array.from(files).find(
      (f) => f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf"),
    );
    if (nonPdf) { setError("Please drop PDF files only"); return; }
    handleFilesSelected(files);
  };

  const handleFeedbackClose = () => {
    setShowFeedback(false);
    setFeedbackDone(true);
  };

  const isCombining = multiModal === "combining";

  return (
    <div className="app">
      {showFeedback && <FeedbackModal onClose={handleFeedbackClose} />}

      {/* ── Multi-file choice modal ── */}
      {multiModal === "choosing" && (
        <div className="mf-overlay" onClick={(e) => { if (e.target === e.currentTarget) setMultiModal("closed"); }}>
          <div className="mf-modal">
            <div className="mf-modal-header">
              <span className="mf-modal-title">{pendingFiles.length} PDF files selected</span>
              <button className="mf-modal-close" onClick={() => setMultiModal("closed")}>×</button>
            </div>
            <div className="mf-modal-body">
              <p className="mf-modal-desc">How would you like to open these files?</p>
              <div className="mf-choice-row">
                <button className="mf-choice-btn" onClick={handleCombineStart}>
                  <span className="mf-choice-icon">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="none">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="#007BFF" strokeWidth="1.8" strokeLinecap="round"/>
                      <path d="M14 2v6h6M8 13h8M8 17h5" stroke="#007BFF" strokeWidth="1.8" strokeLinecap="round"/>
                    </svg>
                  </span>
                  <span className="mf-choice-label">Combine into one PDF</span>
                  <span className="mf-choice-sub">Merge all files into a single PDF, auto-sorted by construction discipline. Download a copy automatically.</span>
                </button>
                <button className="mf-choice-btn" onClick={handleOpenAsTabs}>
                  <span className="mf-choice-icon">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="none">
                      <rect x="2" y="7" width="20" height="15" rx="2" stroke="#007BFF" strokeWidth="1.8"/>
                      <path d="M2 11h20M7 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" stroke="#007BFF" strokeWidth="1.8" strokeLinecap="round"/>
                    </svg>
                  </span>
                  <span className="mf-choice-label">Open as separate tabs</span>
                  <span className="mf-choice-sub">Each file opens in its own tab. Switch between them instantly. Navigator can search all tabs together.</span>
                </button>
              </div>
              <label className="mf-same-project">
                <input
                  type="checkbox"
                  checked={sameProject}
                  onChange={(e) => setSameProject(e.target.checked)}
                />
                <span>Associate all files into the same project (Navigator searches all tabs together)</span>
              </label>
              <p className="mf-modal-size-info">
                {pendingFiles.length} files · {formatBytes(pendingFiles.reduce((s, f) => s + f.size, 0))} total
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Combine / sorting modal ── */}
      {(multiModal === "sorting" || isCombining) && (
        <div className="mf-overlay">
          <div className="mf-modal mf-modal--wide">
            <div className="mf-modal-header">
              <span className="mf-modal-title">
                {isCombining
                  ? `Combining ${combineProgress.current} of ${combineProgress.total} files…`
                  : `Combine ${combineFiles.length} file${combineFiles.length !== 1 ? "s" : ""} into one PDF`}
              </span>
              {!isCombining && (
                <button className="mf-modal-close" onClick={() => setMultiModal("choosing")}>×</button>
              )}
            </div>

            <div className="mf-modal-body">
              {isCombining ? (
                <div className="mf-progress-wrap">
                  <p className="mf-progress-label">
                    Combining {combineProgress.current} of {combineProgress.total} files…
                    {combineProgress.filename && (
                      <span className="mf-progress-file"> {combineProgress.filename}</span>
                    )}
                  </p>
                  <div className="mf-progress-bar">
                    <div
                      className="mf-progress-fill"
                      style={{
                        width: combineProgress.total > 0
                          ? `${(combineProgress.current / combineProgress.total) * 100}%`
                          : "0%",
                      }}
                    />
                  </div>
                </div>
              ) : (
                <>
                  <p className="mf-modal-desc">
                    Files sorted by construction discipline. Drag ⠿ to reorder, × to remove.
                  </p>
                  <div className="mf-file-list">
                    {combineFiles.map((f, i) => {
                      const { prefix } = detectDiscipline(f.name);
                      const disciplineName = DISCIPLINE_NAMES[prefix] || "";
                      return (
                        <div
                          key={f.name + i}
                          className="mf-file-row"
                          draggable
                          onDragStart={() => handleDragStart(i)}
                          onDragOver={(e) => handleDragOver(e, i)}
                          onDragEnd={handleDragEnd}
                        >
                          <span className="mf-drag-handle" title="Drag to reorder">⠿</span>
                          <span
                            className="mf-discipline-badge"
                            title={disciplineName || "Unknown discipline"}
                          >
                            {prefix || "?"}
                          </span>
                          <span className="mf-file-name" title={f.name}>{f.name}</span>
                          <span className="mf-file-size">{formatBytes(f.size)}</span>
                          <button
                            className="mf-file-remove"
                            onClick={() => setCombineFiles((prev) => prev.filter((_, j) => j !== i))}
                            title="Remove from combine"
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                    {combineFiles.length === 0 && (
                      <p style={{ color: "#555", textAlign: "center", padding: "16px", fontSize: 13 }}>
                        All files removed. Add more or go back.
                      </p>
                    )}
                  </div>
                  <div className="mf-combine-footer">
                    <div className="mf-combine-meta">
                      {combineFiles.length} file{combineFiles.length !== 1 ? "s" : ""} ·{" "}
                      {formatBytes(combineFiles.reduce((s, f) => s + f.size, 0))} combined
                    </div>
                    <div className="mf-combine-name-row">
                      <label className="mf-combine-name-label">Combined PDF name</label>
                      <input
                        className="mf-name-input"
                        value={combineName}
                        onChange={(e) => setCombineName(e.target.value)}
                        placeholder="Combined Documents.pdf"
                      />
                    </div>
                  </div>
                </>
              )}

              {combineErrors.length > 0 && (
                <div className="mf-errors">
                  ⚠ Failed to load: {combineErrors.join(", ")} — skipped.
                </div>
              )}
            </div>

            {!isCombining && (
              <div className="mf-modal-footer">
                <button className="mf-btn-ghost" onClick={() => setMultiModal("choosing")}>← Back</button>
                <button
                  className="mf-btn-primary"
                  onClick={handleCombineConfirm}
                  disabled={combineFiles.length === 0}
                >
                  Combine and Open
                </button>
              </div>
            )}
          </div>
        </div>
      )}

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
              <input ref={inputRef} type="file" accept=".pdf,application/pdf" multiple onChange={onFileChange} hidden />
              <div className="dropzone-inner">
                <div className="dropzone-icon">
                  <svg viewBox="0 0 24 24" width="48" height="48" fill="none">
                    <path d="M12 16V4m0 0-4 4m4-4 4 4" stroke="#007BFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke="#007BFF" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </div>
                <h2>Drop documents to begin</h2>
                <p>or click to browse — single or multiple PDFs</p>
                <p className="upload-hint">
                  Up to 500 files · 500MB per file · 2GB total
                </p>
                <button type="button" className="btn primary">Choose Documents</button>
              </div>
              {error && <p className="error">{error}</p>}
            </section>
            {/* sample link — below dropzone */}
            <div className="sample-link-row">
              <button type="button" className="sample-link" onClick={() => setShowSampleModal(true)}>
                Don't have a document? <span className="sample-link-cta">Try our sample construction project →</span>
              </button>
            </div>
          </main>

          {showSampleModal && (
            <div className="sample-modal-overlay" onClick={() => { if (!sampleLoading) setShowSampleModal(false); }}>
              <div className="sample-modal" onClick={(e) => e.stopPropagation()}>
                <div className="sample-modal-header">
                  <span className="sample-modal-title">Sample Documents</span>
                  {!sampleLoading && (
                    <button className="sample-modal-close" onClick={() => setShowSampleModal(false)}>✕</button>
                  )}
                </div>
                <div className="sample-modal-body">
                  <div className="sample-doc-card sample-doc-card--single">
                    <div className="sample-doc-info">
                      <div className="sample-doc-label">Wimbish Gym Addition</div>
                      <div className="sample-doc-desc">
                        Load the Wimbish Gym Addition project — includes construction drawings (151 MB) and project specifications (16 MB)
                      </div>
                      <ul className="sample-doc-files">
                        <li>Construction Drawings — 151 MB</li>
                        <li>Project Specifications — 16 MB</li>
                      </ul>
                    </div>
                    <button
                      type="button"
                      className="sample-doc-btn"
                      disabled={!!sampleLoading}
                      onClick={loadSampleProject}
                    >
                      {sampleLoading ? "Loading…" : "Load Sample Project"}
                    </button>
                  </div>
                  {sampleLoading && (
                    <div className="sample-fetch-progress">
                      <div className="sample-fetch-row">
                        <span>Construction Drawings (151 MB)</span>
                        <span>{sampleProgress.drawings}%</span>
                      </div>
                      <div className="sample-fetch-bar">
                        <div className="sample-fetch-bar-fill" style={{ width: `${sampleProgress.drawings}%` }} />
                      </div>
                      <div className="sample-fetch-row">
                        <span>Project Specifications (16 MB)</span>
                        <span>{sampleProgress.specs}%</span>
                      </div>
                      <div className="sample-fetch-bar">
                        <div className="sample-fetch-bar-fill" style={{ width: `${sampleProgress.specs}%` }} />
                      </div>
                    </div>
                  )}
                  {sampleError && (
                    <p className="sample-fetch-error">Error: {sampleError}</p>
                  )}
                </div>
              </div>
            </div>
          )}
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
        <WorkspaceErrorBoundary onReset={reset}>
          <Workspace
            file={file}
            meta={meta}
            pageTexts={pageTexts}
            pageTitles={pageTitles}
            pageSheets={pageSheets}
            isOcring={isOcring}
            ocrProgress={ocrProgress}
            onNewFile={reset}
            onboardDone={onboardDone}
            onOnboardDone={() => setOnboardDone(true)}
            pendingTabFiles={pendingTabFiles}
            extraFilesAsSameProject={extraFilesAsSameProject}
            pendingProjectName={pendingProjectName}
            isSampleProject={isSampleProject}
            onShowFeedback={() => setShowFeedback(true)}
          />
        </WorkspaceErrorBoundary>
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

// ── Client-side text extraction ───────────────────────────────────────────────

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

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}
