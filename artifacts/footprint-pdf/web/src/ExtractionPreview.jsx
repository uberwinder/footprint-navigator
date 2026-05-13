import { useState } from "react";

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

  const allDone     = docs.length > 0 && docs.every((d) => d.isDone);
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

  const textSample = doc ? (doc.pageTexts[0] || "").slice(0, 400) : "";

  const statusBadge = (d) => {
    if (!d.isDone)                                  return { label: "Extracting…", cls: "ep-badge--gray"   };
    const hasSheets = d.pageSheets.some((s) => s && s.length > 0);
    const hasText   = d.pageTexts.some((t)  => t && t.length  > 10);
    if (!hasText)                                   return { label: "Check",       cls: "ep-badge--red"    };
    if (!hasSheets)                                 return { label: "Review",      cls: "ep-badge--yellow" };
    return                                                 { label: "Ready",       cls: "ep-badge--green"  };
  };

  return (
    <div className="ep-root">
      {/* ── Header — same branding as the rest of the app ── */}
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
            <h2 className="ep-title">Reviewing Your Documents</h2>
            <p className="ep-subtitle">
              {isExtracting
                ? `Extracting text… page ${donePages} of ${totalPages}`
                : "Extraction complete — everything looks good. Review below and click Open in Navigator when ready."}
            </p>
            {isExtracting && (
              <div className="ep-progress-bar">
                <div className="ep-progress-fill" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>

          {/* Document tabs — only shown if multiple docs */}
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

              {/* Doc header + status badge */}
              <div className="ep-doc-header">
                <div>
                  <div className="ep-doc-name">{doc.name}</div>
                  <div className="ep-doc-pages">
                    {doc.pages > 0 ? `${doc.pages} pages` : "Counting pages…"}
                  </div>
                </div>
                <span className={`ep-badge ${statusBadge(doc).cls}`}>
                  {statusBadge(doc).label}
                </span>
              </div>

              {/* Detected Sheets */}
              <div className="ep-section">
                <div className="ep-section-title">
                  Detected Sheets
                  {sheetsDetected.length > 0 && (
                    <span className="ep-sheet-count">{sheetsDetected.length} detected</span>
                  )}
                </div>
                {!doc.isDone ? (
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

              {/* Extracted text sample */}
              <div className="ep-section">
                <div className="ep-section-title">Extracted Text Sample (Page 1)</div>
                <div className="ep-text-sample">
                  {!doc.isDone ? (
                    <span className="ep-section-empty">Extracting…</span>
                  ) : textSample ? (
                    textSample
                  ) : (
                    <span className="ep-section-empty">No text extracted from this page</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Project name — only for multi-doc */}
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

      {/* ── Tour bubble (shown once, first time) ── */}
      {!onboardDone && !previewTourDone && (
        <div className="ep-tour-bubble">
          <div className="ep-tour-header">
            <span className="wob-logo">Navigator</span>
          </div>
          <p className="ep-tour-text">
            This is the document review screen. Here you can confirm your documents uploaded
            correctly, check detected sheet numbers, and preview extracted text. When everything
            looks good, click <strong>Open in Navigator</strong> to begin.
          </p>
          <div className="ep-tour-actions">
            <button className="wob-btn wob-btn--primary" onClick={onPreviewTourDone}>
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
