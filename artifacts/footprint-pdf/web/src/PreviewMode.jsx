import { useEffect, useRef, useState } from "react";
import PdfViewer from "./PdfViewer.jsx";

export default function PreviewMode({ file, meta, pageTexts, extractedText, onUseDocument }) {
  const [activeTab,    setActiveTab]    = useState("viewer");
  const [searchInput,  setSearchInput]  = useState("");
  const [searchQuery,  setSearchQuery]  = useState("");
  const [targetPage,   setTargetPage]   = useState(null);
  const [sidebarOpen,  setSidebarOpen]  = useState(true);
  const searchInputRef = useRef(null);

  // Ctrl+F → open sidebar and focus search
  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setSidebarOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const searchResults = searchQuery ? buildSearchResults(pageTexts, searchQuery) : [];

  const runSearch = (e) => {
    e.preventDefault();
    setSearchQuery(searchInput.trim());
  };

  const clearSearch = () => {
    setSearchInput("");
    setSearchQuery("");
    setActiveTab("viewer");
  };

  const goToPage = (page) => {
    setTargetPage(page);
    setActiveTab("viewer");
  };

  const hasSearch = searchInput.length > 0 || searchQuery.length > 0;

  const ext = (meta.filename || "PDF").split(".").pop().toUpperCase();
  const sizeLabel = formatSize(meta.size);

  return (
    <div className="preview-full">
      {/* Header */}
      <header className="header">
        <div className="brand">
          <img src="./footprint-logo.png" alt="Footprint Navigator logo" className="logo-img" />
          <div>
            <h1>Footprint Navigator</h1>
            <p className="tagline">Tread boldly.</p>
          </div>
        </div>
      </header>

      {/* Body: sidebar + viewer */}
      <div className="preview-full-body">
        {/* Sidebar wrapper (collapsible) */}
        <div className={`sidebar-wrap ${sidebarOpen ? "sidebar-wrap--open" : "sidebar-wrap--closed"}`}>
          <aside className="sidebar">
            {/* File info card */}
            <div className="file-info-card">
              <div className="info-chip">{ext}</div>
              <ul className="info-list">
                <li>
                  <span className="info-key">Name</span>
                  <span className="info-val" title={meta.filename}>{meta.filename}</span>
                </li>
                <li>
                  <span className="info-key">Pages</span>
                  <span className="info-val">{meta.pages}</span>
                </li>
                {meta.size != null && (
                  <li>
                    <span className="info-key">Size</span>
                    <span className="info-val">{sizeLabel}</span>
                  </li>
                )}
                {meta.info?.Title && (
                  <li>
                    <span className="info-key">Title</span>
                    <span className="info-val">{meta.info.Title}</span>
                  </li>
                )}
              </ul>
            </div>

            {/* Search */}
            <form className="search-form" onSubmit={runSearch}>
              <div className="search-box-wrap">
                <input
                  ref={searchInputRef}
                  className="search-box"
                  type="text"
                  placeholder="Search…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
                {hasSearch && (
                  <button
                    type="button"
                    className="search-clear-btn"
                    onClick={clearSearch}
                    title="Clear search and return to viewer"
                  >×</button>
                )}
              </div>
              <button type="submit" className="btn primary search-go">Go</button>
            </form>

            {/* Search results */}
            {searchQuery && (
              <div className="search-results-block">
                <p className="search-summary">
                  {searchResults.length === 0
                    ? `No matches for "${searchQuery}"`
                    : `${searchResults.length} match${searchResults.length === 1 ? "" : "es"}`}
                </p>
                {searchResults.length > 0 && (
                  <ul className="result-list">
                    {searchResults.map((r, i) => (
                      <li key={`${r.page}-${r.offset}-${i}`}>
                        <button className="result-item" onClick={() => goToPage(r.page)}>
                          <span className="result-page">Page {r.page}</span>
                          <span className="result-snippet">
                            {r.before}<mark>{r.match}</mark>{r.after}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Tabs */}
            <div className="tab-bar">
              <button
                className={`tab-btn ${activeTab === "viewer" ? "active" : ""}`}
                onClick={() => setActiveTab("viewer")}
              >
                Viewer
              </button>
              <button
                className={`tab-btn ${activeTab === "text" ? "active" : ""}`}
                onClick={() => setActiveTab("text")}
              >
                Extracted Text
              </button>
            </div>
          </aside>

          {/* Collapse/expand toggle */}
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
            title={sidebarOpen ? "Collapse panel" : "Expand panel"}
            aria-label={sidebarOpen ? "Collapse panel" : "Expand panel"}
          >
            {sidebarOpen ? "‹" : "›"}
          </button>
        </div>

        {/* Main content */}
        <main className="viewer-area">
          {activeTab === "viewer" && (
            <PdfViewer
              file={file}
              targetPage={targetPage}
              highlightText={searchQuery}
            />
          )}
          {activeTab === "text" && (
            <div className="text-view">
              {pageTexts && pageTexts.length > 0 ? (
                <div className="text-content">
                  {pageTexts.map((text, i) => (
                    <div key={i} className="text-page-block">
                      <div className="text-page-label">— Page {i + 1} —</div>
                      <pre className="text-page-body">{text || "(no text on this page)"}</pre>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-empty">No text extracted from this document.</p>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Use Document bar */}
      <div className="preview-use-bar">
        <button className="btn primary preview-use-btn" onClick={onUseDocument}>
          Use Document
        </button>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSearchResults(pageTexts, query) {
  const q = query.toLowerCase();
  if (!q) return [];
  const results = [];
  const R = 60, PER = 5, MAX = 200;
  for (let i = 0; i < pageTexts.length; i++) {
    const text  = pageTexts[i] || "";
    const lower = text.toLowerCase();
    let hits = 0, from = 0;
    while (hits < PER) {
      const idx = lower.indexOf(q, from);
      if (idx === -1) break;
      const s = Math.max(0, idx - R);
      const e = Math.min(text.length, idx + q.length + R);
      results.push({
        page:   i + 1,
        offset: idx,
        before: (s > 0 ? "…" : "") + text.slice(s, idx),
        match:  text.slice(idx, idx + q.length),
        after:  text.slice(idx + q.length, e) + (e < text.length ? "…" : ""),
      });
      hits++; from = idx + q.length;
      if (results.length >= MAX) return results;
    }
  }
  return results;
}

function formatSize(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024 ** 2)  return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
