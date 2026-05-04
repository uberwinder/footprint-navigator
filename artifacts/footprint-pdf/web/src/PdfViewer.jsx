import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfViewer({ file, targetPage, highlightText }) {
  const wrapRef      = useRef(null);
  const canvasRef    = useRef(null);
  const textLayerRef = useRef(null);
  const pageWrapRef  = useRef(null);
  const renderTaskRef = useRef(null);
  const textLayerTaskRef = useRef(null);

  const [pdfDoc,       setPdfDoc]       = useState(null);
  const [pageNum,      setPageNum]      = useState(1);
  const [numPages,     setNumPages]     = useState(0);
  const [scale,        setScale]        = useState(null);
  const [isRendering,  setIsRendering]  = useState(false);
  const [loadError,    setLoadError]    = useState("");

  useEffect(() => {
    if (
      targetPage &&
      Number.isFinite(targetPage) &&
      targetPage >= 1 &&
      (numPages === 0 || targetPage <= numPages)
    ) {
      setPageNum(targetPage);
    }
  }, [targetPage, numPages]);

  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    setPdfDoc(null);
    setPageNum(1);
    setNumPages(0);
    setScale(null);

    if (!file) return;

    (async () => {
      try {
        const buffer = await file.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: buffer });
        const doc = await loadingTask.promise;
        if (cancelled) { doc.destroy(); return; }
        setPdfDoc(doc);
        setNumPages(doc.numPages);
      } catch (err) {
        if (!cancelled) setLoadError(err.message || "Failed to load PDF");
      }
    })();

    return () => { cancelled = true; };
  }, [file]);

  // Calculate fit-page scale after PDF loads (show entire page)
  useEffect(() => {
    if (!pdfDoc || !wrapRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await pdfDoc.getPage(1);
        if (cancelled) return;
        const defaultVp = page.getViewport({ scale: 1 });
        const wrap = wrapRef.current;
        const availW = wrap.clientWidth  - 48;
        const availH = wrap.clientHeight - 48;
        const scaleW = availW / defaultVp.width;
        const scaleH = availH / defaultVp.height;
        const fitScale = Math.max(0.1, Math.min(3, Math.min(scaleW, scaleH)));
        setScale(fitScale);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [pdfDoc]); // eslint-disable-line

  // Generation counter: each renderPage call gets a unique id; stale calls bail out
  const renderGenRef = useRef(0);

  const renderPage = useCallback(
    async (doc, num, currentScale, query) => {
      if (!doc || !canvasRef.current || currentScale === null) return;

      const gen = ++renderGenRef.current;
      setIsRendering(true);

      try {
        // Cancel + fully await previous render before touching the canvas
        if (renderTaskRef.current) {
          const oldTask = renderTaskRef.current;
          renderTaskRef.current = null;
          oldTask.cancel();
          try { await oldTask.promise; } catch { /* RenderingCancelledException */ }
        }
        if (textLayerTaskRef.current) {
          const oldTl = textLayerTaskRef.current;
          textLayerTaskRef.current = null;
          oldTl.cancel();
        }

        if (gen !== renderGenRef.current) return; // superseded by a newer call

        const page = await doc.getPage(num);
        if (gen !== renderGenRef.current) return;

        const viewport = page.getViewport({ scale: currentScale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext("2d");
        if (!context) return;

        const dpr = window.devicePixelRatio || 1;
        const cssW = Math.floor(viewport.width);
        const cssH = Math.floor(viewport.height);

        canvas.width  = Math.floor(viewport.width  * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width  = `${cssW}px`;
        canvas.style.height = `${cssH}px`;

        if (pageWrapRef.current) {
          pageWrapRef.current.style.width  = `${cssW}px`;
          pageWrapRef.current.style.height = `${cssH}px`;
        }

        const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
        const task = page.render({ canvasContext: context, viewport, transform });
        renderTaskRef.current = task;
        await task.promise;
        if (gen !== renderGenRef.current) return;
        renderTaskRef.current = null;

        if (query && query.trim()) {
          await drawHighlights(context, page, viewport, dpr, query.trim());
          if (gen !== renderGenRef.current) return;
        }

        // Text layer for selection
        const textLayerDiv = textLayerRef.current;
        if (textLayerDiv) {
          textLayerDiv.innerHTML = "";
          textLayerDiv.style.width  = `${cssW}px`;
          textLayerDiv.style.height = `${cssH}px`;

          const textContent = await page.getTextContent();
          if (gen !== renderGenRef.current) return;

          const tl = new pdfjsLib.TextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport,
          });
          textLayerTaskRef.current = tl;
          await tl.render();
          if (gen !== renderGenRef.current) return;
          textLayerTaskRef.current = null;
        }
      } catch (err) {
        if (err?.name !== "RenderingCancelledException") {
          if (gen === renderGenRef.current) {
            setLoadError(err.message || "Failed to render page");
          }
        }
      } finally {
        if (gen === renderGenRef.current) setIsRendering(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (pdfDoc && scale !== null) renderPage(pdfDoc, pageNum, scale, highlightText);
  }, [pdfDoc, pageNum, scale, highlightText, renderPage]);

  useEffect(() => {
    return () => {
      if (renderTaskRef.current) renderTaskRef.current.cancel();
      if (textLayerTaskRef.current) textLayerTaskRef.current.cancel();
    };
  }, []);

  // Click-and-drag to pan — don't activate when clicking on text layer content
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let isDown = false;
    let moved = false;
    let startX = 0, startY = 0, startScrollLeft = 0, startScrollTop = 0;

    const onDown = (e) => {
      const target = e.target;
      if (target && target.closest && target.closest("input, button, a")) return;
      // Allow native text selection on text layer spans
      if (target && target.closest && target.closest(".pdf-text-layer")) return;
      isDown = true;
      moved  = false;
      startX = e.clientX; startY = e.clientY;
      startScrollLeft = wrap.scrollLeft; startScrollTop = wrap.scrollTop;
    };
    const onMove = (e) => {
      if (!isDown) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 4) {
        moved = true;
        wrap.classList.add("panning");
      }
      if (moved) {
        e.preventDefault();
        wrap.scrollLeft = startScrollLeft - dx;
        wrap.scrollTop  = startScrollTop  - dy;
      }
    };
    const onUp = () => {
      if (!isDown) return;
      isDown = false;
      wrap.classList.remove("panning");
    };

    wrap.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      wrap.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // Refs to keep current values accessible in wheel listener closure
  const pageNumRef  = useRef(pageNum);
  const numPagesRef = useRef(numPages);
  const scrollToBottomRef = useRef(false);
  useEffect(() => { pageNumRef.current  = pageNum;  }, [pageNum]);
  useEffect(() => { numPagesRef.current = numPages; }, [numPages]);

  // After render completes, scroll to bottom if requested (prev-page scroll up)
  useEffect(() => {
    if (!isRendering && scrollToBottomRef.current && wrapRef.current) {
      scrollToBottomRef.current = false;
      wrapRef.current.scrollTop = wrapRef.current.scrollHeight;
    }
  }, [isRendering]);

  // Wheel: Ctrl+scroll = zoom | boundary scroll = advance page
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e) => {
      // ── Ctrl: zoom ──
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        setScale((s) => Math.max(0.1, Math.min(3, +((s ?? 1) + delta).toFixed(2))));
        return;
      }
      // ── No Ctrl: page advance at boundary ──
      const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 4;
      const atTop    = wrap.scrollTop <= 2;
      if (atBottom && e.deltaY > 0 && pageNumRef.current < numPagesRef.current) {
        e.preventDefault();
        setPageNum((n) => n + 1);
        requestAnimationFrame(() => { if (wrapRef.current) wrapRef.current.scrollTop = 0; });
      } else if (atTop && e.deltaY < 0 && pageNumRef.current > 1) {
        e.preventDefault();
        scrollToBottomRef.current = true;
        setPageNum((n) => n - 1);
      }
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, []);

  const goPrev = () => setPageNum((n) => Math.max(1, n - 1));
  const goNext = () => setPageNum((n) => Math.min(numPages, n + 1));
  const zoomIn  = () => setScale((s) => Math.min(3, +((s ?? 1) + 0.15).toFixed(2)));
  const zoomOut = () => setScale((s) => Math.max(0.1, +((s ?? 1) - 0.15).toFixed(2)));
  const onPageInput = (e) => {
    const value = Number(e.target.value);
    if (!Number.isNaN(value) && value >= 1 && value <= numPages) setPageNum(value);
  };

  return (
    <div className="viewer">
      <div className="viewer-toolbar">
        <div className="toolbar-group">
          <button type="button" className="btn icon" onClick={goPrev} disabled={pageNum <= 1} aria-label="Previous page">‹</button>
          <div className="page-indicator">
            <input type="number" min="1" max={numPages || 1} value={pageNum} onChange={onPageInput} />
            <span>/ {numPages || "—"}</span>
          </div>
          <button type="button" className="btn icon" onClick={goNext} disabled={pageNum >= numPages} aria-label="Next page">›</button>
        </div>
        <div className="toolbar-group">
          <button type="button" className="btn icon" onClick={zoomOut} disabled={(scale ?? 1) <= 0.1} aria-label="Zoom out">−</button>
          <span className="zoom-label">{scale !== null ? `${Math.round(scale * 100)}%` : "—"}</span>
          <button type="button" className="btn icon" onClick={zoomIn} disabled={(scale ?? 1) >= 3} aria-label="Zoom in">+</button>
        </div>
      </div>
      <div className="viewer-canvas-wrap" ref={wrapRef}>
        {loadError ? (
          <p className="error">{loadError}</p>
        ) : (
          <div className="pdf-page-wrap" ref={pageWrapRef}>
            <canvas ref={canvasRef} className={isRendering ? "rendering" : ""} />
            <div ref={textLayerRef} className="pdf-text-layer" />
          </div>
        )}
      </div>
    </div>
  );
}

async function drawHighlights(context, page, viewport, dpr, query) {
  try {
    const textContent = await page.getTextContent();
    const q = query.toLowerCase();
    context.save();
    if (dpr !== 1) context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = "rgba(255, 235, 59, 0.45)";
    context.strokeStyle = "rgba(255, 193, 7, 0.85)";
    context.lineWidth = 1;

    for (const item of textContent.items) {
      if (typeof item.str !== "string" || item.str.length === 0) continue;
      if (!item.str.toLowerCase().includes(q)) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      const w = (item.width || 0) * viewport.scale;
      context.fillRect(tx[4], tx[5] - fontHeight, w, fontHeight);
      context.strokeRect(tx[4], tx[5] - fontHeight, w, fontHeight);
    }
    context.restore();
  } catch {
    // best-effort
  }
}
