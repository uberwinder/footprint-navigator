import { useCallback, useEffect, useRef, useState } from "react";

const MAX_RENDERED  = 8;
const CONCURRENCY   = 2;
const PAGE_GAP      = 12;   // px between pages
const OBS_MARGIN    = "400px";
const SMOOTH_DELAY  = 700;  // ms to hold programmaticRef after smooth scroll

export default function ContinuousViewer({ pdfDoc, numPages, scale, pageNum, setPageNum }) {
  const containerRef      = useRef(null);
  const pageInfoRef       = useRef([]);     // [{ wrapEl, canvasEl, height, rendered }]
  const cumulativeRef     = useRef([0]);    // cumulative scroll offsets (length numPages+1)
  const renderQueueRef    = useRef([]);     // pages waiting to render
  const renderingRef      = useRef(new Set());
  const activeTasksRef    = useRef({});     // page# → renderTask (for cancellation)
  const renderedSetRef    = useRef(new Set());
  const observerRef       = useRef(null);
  const scrollRafRef      = useRef(null);
  const programmaticRef   = useRef(false);
  const scrollEndTimer    = useRef(null);
  const lastInternalPgRef = useRef(null);   // page# that came from our own scroll listener
  const [initialized, setInitialized] = useState(false);

  // ── Render engine (refs so closures are always fresh) ───────────────────────

  const processQFnRef = useRef(null);
  const renderFnRef   = useRef(null);

  useEffect(() => {
    processQFnRef.current = () => {
      while (renderingRef.current.size < CONCURRENCY && renderQueueRef.current.length > 0) {
        const pg   = renderQueueRef.current.shift();
        const info = pageInfoRef.current[pg - 1];
        if (!info || !info.canvasEl || info.rendered || renderingRef.current.has(pg)) continue;
        renderFnRef.current(pg, info);
      }
    };

    renderFnRef.current = async (pg, info) => {
      renderingRef.current.add(pg);
      try {
        const page = await pdfDoc.getPage(pg);
        const vp   = page.getViewport({ scale });
        const canvas = info.canvasEl;
        if (!canvas) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width  = Math.round(vp.width  * dpr);
        canvas.height = Math.round(vp.height * dpr);
        canvas.style.width  = `${Math.round(vp.width)}px`;
        canvas.style.height = `${Math.round(vp.height)}px`;

        // Update wrapper height if the actual page differs from the placeholder estimate
        if (info.wrapEl) {
          const actualH = Math.round(vp.height);
          if (actualH !== info.height) {
            info.height = actualH;
            info.wrapEl.style.height = `${actualH + PAGE_GAP}px`;
            // Patch cumulative forward
            const cum = cumulativeRef.current;
            for (let i = pg; i <= numPages; i++) {
              cum[i] = cum[i - 1] + pageInfoRef.current[i - 1].height + PAGE_GAP;
            }
          }
        }

        const ctx  = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const task = page.render({ canvasContext: ctx, viewport: vp });
        activeTasksRef.current[pg] = task;
        await task.promise;
        info.rendered = true;
        renderedSetRef.current.add(pg);
      } catch (err) {
        if (err?.name !== "RenderingCancelledException") {
          console.warn(`ContinuousViewer render p${pg}:`, err);
        }
      } finally {
        delete activeTasksRef.current[pg];
        renderingRef.current.delete(pg);
        processQFnRef.current?.();
      }
    };
  }, [pdfDoc, scale, numPages]);

  // ── Cancel all in-flight renders ────────────────────────────────────────────

  const cancelAll = useCallback(() => {
    Object.values(activeTasksRef.current).forEach((t) => { try { t.cancel(); } catch {} });
    activeTasksRef.current = {};
    renderingRef.current.clear();
    renderQueueRef.current = [];
    renderedSetRef.current.clear();
    pageInfoRef.current.forEach((info) => { info.rendered = false; });
  }, []);

  // ── Build placeholder array from first-page dimensions ──────────────────────

  const initPlaceholders = useCallback(async () => {
    if (!pdfDoc || !containerRef.current) return;
    cancelAll();

    const containerW = containerRef.current.clientWidth;
    const availW     = Math.max(100, containerW - 64);
    const pg1        = await pdfDoc.getPage(1);
    const vp1        = pg1.getViewport({ scale });
    const w          = Math.min(Math.round(vp1.width), availW);
    const h          = Math.round(w * (vp1.height / vp1.width));

    pageInfoRef.current = Array.from({ length: numPages }, (_, i) => ({
      pageNum:  i + 1,
      width:    w,
      height:   h,
      wrapEl:   null,
      canvasEl: null,
      rendered: false,
    }));

    const cum = [0];
    for (let i = 0; i < numPages; i++) cum.push(cum[i] + h + PAGE_GAP);
    cumulativeRef.current = cum;

    setInitialized(true);
  }, [pdfDoc, numPages, scale, cancelAll]);

  // Re-init whenever doc, page count, or scale changes
  useEffect(() => {
    setInitialized(false);
    if (pdfDoc && numPages) initPlaceholders();
  }, [pdfDoc, numPages, scale, initPlaceholders]);

  // ── IntersectionObserver: trigger renders + evict distant pages ─────────────

  useEffect(() => {
    if (!initialized || !containerRef.current) return;
    if (observerRef.current) observerRef.current.disconnect();

    const obs = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const pg   = parseInt(entry.target.dataset.page, 10);
        const info = pageInfoRef.current[pg - 1];
        if (!info) return;

        if (entry.isIntersecting) {
          renderedSetRef.current.add(pg);

          // Queue for render if needed
          if (!info.rendered && !renderingRef.current.has(pg)) {
            if (!renderQueueRef.current.includes(pg)) renderQueueRef.current.push(pg);
            processQFnRef.current?.();
          }

          // Evict farthest page when over limit
          if (renderedSetRef.current.size > MAX_RENDERED) {
            const all      = [...renderedSetRef.current].sort((a, b) => a - b);
            const farthest = all.reduce((far, p) =>
              Math.abs(p - pg) > Math.abs(far - pg) ? p : far, all[0]
            );
            if (farthest !== pg) {
              const fi = pageInfoRef.current[farthest - 1];
              if (fi) {
                if (activeTasksRef.current[farthest]) {
                  try { activeTasksRef.current[farthest].cancel(); } catch {}
                  delete activeTasksRef.current[farthest];
                }
                renderingRef.current.delete(farthest);
                renderQueueRef.current = renderQueueRef.current.filter((x) => x !== farthest);
                fi.rendered = false;
                if (fi.canvasEl) {
                  fi.canvasEl.getContext("2d")?.clearRect(0, 0, fi.canvasEl.width, fi.canvasEl.height);
                }
              }
              renderedSetRef.current.delete(farthest);
            }
          }
        }
      });
    }, { root: containerRef.current, rootMargin: OBS_MARGIN, threshold: 0 });

    pageInfoRef.current.forEach((info) => { if (info.wrapEl) obs.observe(info.wrapEl); });
    observerRef.current = obs;
    return () => obs.disconnect();
  }, [initialized]);

  // ── Scroll listener → update pageNum via rAF ────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !initialized) return;

    const onScroll = () => {
      if (scrollRafRef.current) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        if (programmaticRef.current) return;

        const scrollTop = container.scrollTop;
        const targetY   = scrollTop + container.clientHeight * 0.3;

        // Binary search cumulative heights
        const cum = cumulativeRef.current;
        let lo = 0, hi = numPages - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (cum[mid] <= targetY) lo = mid; else hi = mid - 1;
        }
        const detected = lo + 1;
        lastInternalPgRef.current = detected;
        setPageNum(detected);
      });
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (scrollRafRef.current) { cancelAnimationFrame(scrollRafRef.current); scrollRafRef.current = null; }
    };
  }, [initialized, numPages, setPageNum]);

  // ── Jump to page: react to external pageNum prop changes ────────────────────

  useEffect(() => {
    if (!initialized || !containerRef.current) return;
    // If this change came from our own scroll listener, skip (avoid feedback loop)
    if (lastInternalPgRef.current === pageNum) { lastInternalPgRef.current = null; return; }

    const offset = cumulativeRef.current[pageNum - 1] ?? 0;
    programmaticRef.current = true;
    containerRef.current.scrollTo({ top: offset, behavior: "smooth" });
    if (scrollEndTimer.current) clearTimeout(scrollEndTimer.current);
    scrollEndTimer.current = setTimeout(() => { programmaticRef.current = false; }, SMOOTH_DELAY);
  }, [pageNum, initialized]);

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  useEffect(() => () => {
    if (observerRef.current) observerRef.current.disconnect();
    cancelAll();
    if (scrollEndTimer.current) clearTimeout(scrollEndTimer.current);
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
  }, [cancelAll]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!initialized) {
    return (
      <div ref={containerRef} className="ws-cv-container">
        <div className="ws-cv-loading">
          <div className="ws-cv-spinner" />
          Preparing continuous view…
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="ws-cv-container">
      <div className="ws-cv-inner">
        {pageInfoRef.current.map((info, i) => (
          <div
            key={i + 1}
            data-page={i + 1}
            className="ws-cv-page-wrap"
            style={{ height: `${info.height + PAGE_GAP}px` }}
            ref={(el) => { info.wrapEl = el; }}
          >
            <div className="ws-cv-page-inner">
              <canvas
                className="ws-cv-canvas"
                ref={(el) => { info.canvasEl = el; }}
              />
            </div>
            {i < numPages - 1 && <div className="ws-cv-divider" />}
          </div>
        ))}
      </div>
    </div>
  );
}
