import { useState, useEffect } from "react";

// ── Document type detection ───────────────────────────────────────────────────
function detectDocType(doc) {
  if (doc.pageSheets.some((s) => s && s.length > 0)) return "Drawings";
  const name = doc.name.toLowerCase();
  if (/spec|manual|division/.test(name)) return "Specifications";
  const allText = doc.pageTexts.join(" ");
  if (/\bSECTION\s+\d{2}\s+\d{2}|\bdivision\s+\d{2}|\bCSI\b/i.test(allText)) return "Specifications";
  return "Unspecified";
}

// ── Typewriter hook ───────────────────────────────────────────────────────────
function useTypewriter(text, charDelay = 13) {
  const [displayed, setDisplayed] = useState("");
  const [started,   setStarted]   = useState(false);

  useEffect(() => {
    if (!text) { setDisplayed(""); setStarted(false); return; }
    setDisplayed(""); setStarted(false);
    let cancelled = false;
    let i = 0;
    const startT = setTimeout(() => {
      if (cancelled) return;
      setStarted(true);
      const tick = () => {
        if (cancelled) return;
        i++;
        setDisplayed(text.slice(0, i));
        if (i < text.length) setTimeout(tick, charDelay);
      };
      setTimeout(tick, charDelay);
    }, 480);
    return () => { cancelled = true; clearTimeout(startT); };
  }, [text]);

  return { displayed, started, done: displayed.length >= text.length };
}

const TOUR_TEXT =
  "This is the document preview screen. Confirm your documents were read correctly, " +
  "check detected sheet numbers, and preview the extracted text. When everything " +
  "looks good, click Open in Navigator to begin.";

// ── Component ─────────────────────────────────────────────────────────────────
export default function ExtractionPreview({
  docs,
  projectName,
  setProjectName,
  onOpen,
  onboardDone,
  previewTourDone,
  onPreviewTourDone,
}) {
  console.log("[preview] ExtractionPreview mounted");
  const [activeTab, setActiveTab] = useState(0);

  const showBubble = !onboardDone && !previewTourDone;
  const { displayed: tourDisplayed, started: tourStarted, done: tourDone } =
    useTypewriter(showBubble ? TOUR_TEXT : "");

  const allDone      = docs.length > 0 && docs.every((d) => d.isDone);
  const isExtracting = !allDone;

  const totalPages = docs.reduce((s, d) => s + (d.pages || 0), 0);
  const donePages  = docs.reduce((s, d) => s + d.pagesExtracted, 0);
  const pct = totalPages > 0 ? Math.round((donePages / totalPages) * 100) : 0;

  const doc = docs[activeTab] ?? docs[0] ?? null;

  const sheetsDetected = doc
    ? doc.pageSheets
        .map((s, i) => (s && s.length > 0 ? { sheet: s, page: i + 1 } : null))
        .filter(Boolean)
    : [];

  // Full text with page breaks — updates progressively as pageTexts grows
  const fullText = doc
    ? doc.pageTexts
        .map((t, i) => {
          const header = `--- Page ${i + 1} ---`;
          const body   = t && t.trim() ? t.trim() : "(no text extracted)";
          return `${header}\n${body}`;
        })
        .join("\n\n")
    : "";

  const docType = doc && doc.isDone ? detectDocType(doc) : null;

  return (
    <div className="ep-root">
      {/* ── Header ── */}
      <header className="header">
        <div className="brand">
          <img src="./footprint-logo.png" alt="Footprint Navigator logo" className="logo-img" />
          <div>
            <h1>Footprint Navigator</h1>
            <p className="tagline">Tread boldly.</p>
          </div>
        </div>
      </header>

      {/* ── Main content ── */}
      <main className="ep-main">
        <div className="ep-card">

          {/* Title + progress */}
          <div className="ep-title-row">
            <h2 className="ep-title">Previewing Your Documents</h2>
            <p className="ep-subtitle">
              {isExtracting
                ? `Extracting text… page ${donePages} of ${totalPages}`
                : "Extraction complete — preview below and click Open in Navigator when ready."}
            </p>
            {isExtracting && (
              <div className="ep-progress-bar">
                <div className="ep-progress-fill" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>

          {/* Document tabs — only when multiple docs */}
          {docs.length > 1 && (
            <div className="ep-tabs">
              {docs.map((d, i) => (
                <button
                  key={d.id}
                  className={`ep-tab${activeTab === i ? " ep-tab--active" : ""}`}
                  onClick={() => setActiveTab(i)}
                >
                  {d.name.length > 30 ? d.name.slice(0, 27) + "…" : d.name}
                </button>
              ))}
            </div>
          )}

          {/* Document detail */}
          {doc && (
            <div className="ep-doc-content">

              {/* Doc header */}
              <div className="ep-doc-header">
                <div>
                  <div className="ep-doc-name">{doc.name}</div>
                  <div className="ep-doc-pages">
                    {doc.pages > 0 ? `${doc.pages} pages` : "Counting pages…"}
                  </div>
                  {docType && (
                    <div className="ep-doc-type">Document Type: {docType}</div>
                  )}
                </div>
              </div>

              {/* Detected Sheets */}
              <div className="ep-section">
                <div className="ep-section-title">
                  Detected Sheets
                  {sheetsDetected.length > 0 && (
                    <span className="ep-sheet-count">{sheetsDetected.length} detected</span>
                  )}
                </div>
                {!doc.isDone && doc.pageTexts.length === 0 ? (
                  <p className="ep-section-empty">Extracting…</p>
                ) : sheetsDetected.length === 0 ? (
                  <p className="ep-section-empty">No sheet numbers detected</p>
                ) : (
                  <div className="ep-sheet-list">
                    {sheetsDetected.map((item, i) => (
                      <div key={i} className="ep-sheet-row">
                        <span className="ep-sheet-num">{item.sheet}</span>
                        <span className="ep-sheet-page">Page {item.page}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Full extracted text — progressive */}
              <div className="ep-section">
                <div className="ep-section-title">Extracted Text</div>
                <div className="ep-text-full">
                  {doc.pageTexts.length === 0 ? (
                    <p className="ep-section-empty" style={{ padding: "12px 14px", margin: 0 }}>
                      Extracting…
                    </p>
                  ) : (
                    <pre className="ep-text-pre">{fullText}</pre>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Project name — multi-doc only */}
          {docs.length > 1 && (
            <div className="ep-project-name-wrap">
              <label className="ep-project-label">Project Name</label>
              <input
                className="ep-project-input"
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="My Project"
              />
              <p className="ep-project-hint">
                Documents in the same project are searched together by Navigator
              </p>
            </div>
          )}

          {/* Open in Navigator */}
          <button className="ep-open-btn" onClick={onOpen} disabled={isExtracting}>
            {isExtracting ? (
              <><span className="ep-spinner" /> Extracting…</>
            ) : (
              "Open in Navigator"
            )}
          </button>

        </div>
      </main>

      {/* ── Tour bubble — wob-card style + typewriter ── */}
      {showBubble && (
        <div className="wob-card ep-tour-card">
          <div className="wob-header">
            <div className="wob-header-left">
              <span className="wob-logo">Navigator</span>
              <span className="wob-badge">Preview Screen</span>
            </div>
          </div>
          <div className="wob-body">
            {!tourStarted ? (
              <div className="wob-typing-wrap">
                <div className="wob-typing">
                  <span /><span /><span />
                </div>
              </div>
            ) : (
              <p className="wob-text">{tourDisplayed}</p>
            )}
          </div>
          <div className="wob-actions">
            <button
              className="wob-btn wob-btn--primary"
              onClick={onPreviewTourDone}
              disabled={!tourDone}
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
