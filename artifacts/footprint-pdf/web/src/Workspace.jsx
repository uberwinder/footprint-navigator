import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// ── Session Memory (module-level, cleared when component mounts) ─────────────
const _sessionMemory = [];
const SESSION_MEMORY_MAX = 50;

function _wordOverlap(a, b) {
  const wa = new Set((a.toLowerCase().match(/\b\w{3,}\b/g) || []));
  const wb = new Set((b.toLowerCase().match(/\b\w{3,}\b/g) || []));
  if (wa.size === 0 || wb.size === 0) return 0;
  let n = 0; for (const w of wa) { if (wb.has(w)) n++; }
  return n / Math.max(wa.size, wb.size);
}

function _findInMemory(q) {
  const ql = q.toLowerCase().trim();
  for (const e of _sessionMemory) {
    if (e.question.toLowerCase().trim() === ql) return { entry: e, match: "exact" };
  }
  for (const e of _sessionMemory) {
    if (_wordOverlap(q, e.question) >= 0.7) return { entry: e, match: "similar" };
  }
  return null;
}

function _addToMemory(question, answer, pageRefs) {
  if (_sessionMemory.length >= SESSION_MEMORY_MAX) _sessionMemory.shift();
  _sessionMemory.push({ question, answer, pageRefs, timestamp: Date.now() });
}

const DEFAULT_SYSTEM_PROMPT =
  "You are a construction document assistant. Answer questions using ONLY the document text provided. " +
  "Always cite the page number where you found the answer. " +
  "If the answer is not clearly present, do NOT simply say you could not find it. " +
  "Instead, ask a clarifying follow-up question — for example: if asked about 'front elevations' and you see 'exterior elevations', ask 'Did you mean exterior elevations? I found references on page X.' " +
  "Never give up without first suggesting an alternative or asking a one-sentence follow-up question. " +
  "Only say 'I could not find that in this document.' if you have genuinely exhausted all related terms.";

// Usage stats (module-level, reset per document load)
const _usageStats = { geminiCalls: 0, fromMemory: 0, fromKeywords: 0, fromSummary: 0 };

function formatBytes(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

const MODEL_DISPLAY = {
  "groq-70b":      { name: "Groq 70B",       full: "Groq Llama 3.3 70B",  css: "groq70b"      },
  "gemini-flash":  { name: "Gemini Flash",   full: "Gemini 2.5 Flash",    css: "geminiflash"  },
  "gpt-4o-mini":   { name: "GPT-4o Mini",    full: "GPT-4o Mini",         css: "gpt4omini"    },
  "gpt-4o":        { name: "GPT-4o",         full: "GPT-4o",              css: "gpt4o"        },
  "claude-haiku":  { name: "Claude Haiku",   full: "Claude Haiku 4.5",    css: "claudehaiku"  },
  "claude-sonnet": { name: "Claude Sonnet",  full: "Claude Sonnet 4.5",   css: "claudesonnet" },
  // legacy keys kept for cached messages
  "groq-8b": { name: "Groq 8B",        full: "Groq Llama 3.1 8B",  css: "groq8b"     },
  "gemini":  { name: "Gemini Flash",   full: "Gemini 2.5 Flash",   css: "geminiflash" },
};

function _summaryToText(summary) {
  if (!summary) return "";
  return [
    `Project: ${summary.project_name || "Unknown"}`,
    summary.address        ? `Address: ${summary.address}` : null,
    summary.architect      ? `Architect: ${summary.architect}` : null,
    summary.building_type  ? `Building Type: ${summary.building_type}` : null,
    summary.total_pages    ? `Total Pages: ${summary.total_pages}` : null,
    summary.disciplines?.length
      ? `Disciplines: ${summary.disciplines.join(", ")}` : null,
    summary.sheet_list?.length
      ? `Sheets: ${summary.sheet_list.slice(0, 30).map(s => `${s.sheet_number} – ${s.title} (Pg.${s.page})`).join("; ")}` : null,
    summary.key_facts?.length
      ? `Key Facts:\n${summary.key_facts.map(f => `- ${f}`).join("\n")}` : null,
  ].filter(Boolean).join("\n");
}

// ── Data ─────────────────────────────────────────────────────────────────────

const MENUS = [
  {
    id: "file", label: "File",
    items: [
      { label: "Open Document",        action: "open",              note: "Ctrl+O" },
      { label: "Close Document",       action: "closeDoc" },
      "sep",
      { label: "Save Project",         action: "saveProject" },
      { label: "Save Project As…",     action: "saveProjectAs" },
      "sep",
      { label: "Export Chat History",  action: "exportChat" },
      { label: "Print",                action: "print",             note: "Ctrl+P" },
      "sep",
      { label: "Recent Documents",     action: "recentDocuments" },
    ],
  },
  {
    id: "edit", label: "Edit",
    items: [
      { label: "Undo",        action: "undo",        note: "Ctrl+Z" },
      { label: "Redo",        action: "redo",        note: "Ctrl+Y" },
      "sep",
      { label: "Find",        action: "find",        note: "Ctrl+F" },
      "sep",
      { label: "Select All",  action: "selectAll",   note: "Ctrl+A" },
      "sep",
      { label: "Cut",         action: "cut",         note: "Ctrl+X" },
      { label: "Copy",        action: "copy",        note: "Ctrl+C" },
      { label: "Paste",       action: "paste",       note: "Ctrl+V" },
      "sep",
      { label: "Preferences", action: "preferences" },
    ],
  },
  {
    id: "view", label: "View",
    items: [
      { label: "Single Page",       action: "viewSingle",      note: "Ctrl+1" },
      { label: "Split Vertical",    action: "viewSplitV",      note: "Ctrl+2" },
      { label: "Split Horizontal",  action: "viewSplitH",      note: "Ctrl+H" },
      "sep",
      { label: "Zoom In",           action: "zoomIn",          note: "+" },
      { label: "Zoom Out",          action: "zoomOut",         note: "−" },
      { label: "Fit Page",          action: "fitPage" },
      { label: "Fit Width",         action: "fitWidth" },
      { label: "Actual Size",       action: "actualSize",      note: "100%" },
      "sep",
      { label: "Thumbnails Panel",  action: "panel-thumbnails" },
      { label: "Search Panel",      action: "panel-search" },
      { label: "Navigator Chat",    action: "toggleChat" },
      "sep",
      { label: "Full Screen",       action: "fullscreen",      note: "F11" },
    ],
  },
  {
    id: "document", label: "Document",
    items: [
      { label: "Document Properties", action: "docProperties" },
      "sep",
      { label: "OCR This Document",   action: "ocrDocument" },
      { label: "Re-index Document",   action: "reindex" },
      "sep",
      { label: "Rotate Pages",        action: "cs-rotatepages" },
      { label: "Extract Pages",       action: "cs-extractpages" },
      "sep",
      { label: "Page Setup",          action: "cs-pagesetup" },
    ],
  },
  {
    id: "tools", label: "Tools",
    items: [
      { label: "Select",          action: "tool-select",  note: "V" },
      { label: "Pan",             action: "tool-pan",     note: "⇧V" },
      { label: "Select Text",     action: "tool-text",    note: "⇧T" },
      { label: "Zoom",            action: "tool-zoom",    note: "Z" },
      "sep",
      { label: "Measure", submenu: [
        { label: "Set Scale…",       action: "cs-scalecal" },
        "sep",
        { label: "Length",           action: "tool-length",     note: "⇧⌥L" },
        { label: "Polylength",       action: "tool-polylength", note: "⇧⌥Q" },
        { label: "Area",             action: "tool-area",       note: "⇧⌥A" },
        { label: "Perimeter",        action: "tool-perimeter",  note: "⇧⌥P" },
        { label: "Diameter",         action: "cs-diameter",     cs: true },
        { label: "Center Radius",    action: "cs-centerradius", cs: true },
        { label: "3-Point Radius",   action: "cs-3ptradius",    cs: true },
        { label: "Angle",            action: "tool-angle",      note: "⇧⌥G" },
        { label: "Volume",           action: "cs-volume",       cs: true },
        "sep",
        { label: "Polygon Cutout",   action: "cs-polygoncutout", cs: true },
        { label: "Ellipse Cutout",   action: "cs-ellipsecutout", cs: true },
        "sep",
        { label: "Count",            action: "tool-count",      note: "⇧⌥C" },
        { label: "Dynamic Fill",     action: "cs-dynamicfill",  cs: true },
      ]},
      "sep",
      { label: "Annotate",        action: "cs-annotate" },
      { label: "Highlight",       action: "cs-highlight" },
      { label: "Add Note",        action: "cs-note" },
    ],
  },
  {
    id: "window", label: "Window",
    items: [
      { label: "Thumbnails",      action: "panel-thumbnails" },
      { label: "Search",          action: "panel-search" },
      { label: "Navigator Chat",  action: "toggleChat" },
      "sep",
      { label: "Bookmarks",       action: "cs-bookmarks" },
      { label: "Layers",          action: "cs-layers" },
      "sep",
      { label: "Reset Workspace", action: "resetWorkspace" },
    ],
  },
  {
    id: "help", label: "Help",
    items: [
      { label: "Keyboard Shortcuts",        action: "keyboardShortcuts" },
      { label: "About Footprint Navigator", action: "about" },
      "sep",
      { label: "Send Feedback",             action: "sendFeedback" },
      { label: "Check for Updates",         action: "checkUpdates" },
    ],
  },
];

const RAIL_TABS = [
  { id: "thumbnails", icon: "⊞", tooltip: "Thumbnails" },
  { id: "search",     icon: "⌕", tooltip: "Search" },
  { id: "bookmarks",  icon: "⊟", tooltip: "Bookmarks" },
  { id: "layers",     icon: "⧉", tooltip: "Layers" },
  { id: "markups",    icon: "✎", tooltip: "Markups" },
  { id: "measure",    icon: "⊢", tooltip: "Measurements" },
  { id: "properties", icon: "ℹ", tooltip: "Properties" },
];

const TOOL_CURSOR = {
  select: "default", pan: "grab", text: "text", zoom: "zoom-in",
  length: "crosshair", polylength: "crosshair", area: "crosshair",
  perimeter: "crosshair", angle: "crosshair", count: "crosshair",
};

const MTOOLS = ["length", "polylength", "area", "perimeter", "angle", "count"];

// ── Measurement drawing helpers (module-level) ────────────────────────────────

function mPxDist(a, b) { return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2); }
function mPolyLen(pts) { let t = 0; for (let i = 1; i < pts.length; i++) t += mPxDist(pts[i-1], pts[i]); return t; }
function mPolyArea(pts) {
  let a = 0; const n = pts.length;
  for (let i = 0; i < n; i++) { const j = (i+1)%n; a += pts[i].x*pts[j].y - pts[j].x*pts[i].y; }
  return Math.abs(a) / 2;
}
function mFormatDist(px, calib) {
  if (!calib) return `${Math.round(px)}px`;
  const u = px / calib.pixelsPerUnit;
  if (calib.unit === "feet") {
    const ft = Math.floor(u); const inches = Math.round((u - ft) * 12);
    if (inches === 12) return `${ft + 1}'-0"`;
    return ft > 0 ? `${ft}'-${inches}"` : `${inches}"`;
  }
  return `${u.toFixed(2)} ${calib.unit}`;
}
function mFormatArea(pxArea, calib) {
  if (!calib) return `${Math.round(pxArea)} px²`;
  const u = pxArea / (calib.pixelsPerUnit ** 2);
  if (calib.unit === "feet")   return `${u.toFixed(2)} sq ft`;
  if (calib.unit === "meters") return `${u.toFixed(2)} m²`;
  if (calib.unit === "inches") return `${u.toLocaleString("en-US", { maximumFractionDigits: 0 })} sq in`;
  return `${u.toFixed(2)} ${calib.unit}²`;
}
function mAngleDeg(v, p2, p3) {
  const a = { x: p2.x - v.x, y: p2.y - v.y }, b = { x: p3.x - v.x, y: p3.y - v.y };
  const magA = Math.sqrt(a.x**2 + a.y**2), magB = Math.sqrt(b.x**2 + b.y**2);
  if (!magA || !magB) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, (a.x*b.x + a.y*b.y) / (magA*magB)))) * 180) / Math.PI;
}
function mDrawLabel(ctx, text, x, y, color = "#00e5ff") {
  ctx.save();
  ctx.font = "bold 11px Montserrat, system-ui, sans-serif";
  const w = ctx.measureText(text).width, pad = 4;
  ctx.fillStyle = "rgba(0,0,0,0.78)";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x - w/2 - pad, y - 9 - pad, w + pad*2, 18 + pad*2, 3);
  else ctx.rect(x - w/2 - pad, y - 9 - pad, w + pad*2, 18 + pad*2);
  ctx.fill();
  ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, x, y); ctx.restore();
}
function mDot(ctx, x, y, color = "#00e5ff") {
  ctx.save(); ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
}
function mDrawMeasurement(ctx, m, calib) {
  const { type, points: pts } = m;
  if (!pts || pts.length === 0) return;
  ctx.save(); ctx.strokeStyle = "#00e5ff"; ctx.lineWidth = 1.5; ctx.setLineDash([]);
  if (type === "length" && pts.length >= 2) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
    mDot(ctx, pts[0].x, pts[0].y); mDot(ctx, pts[1].x, pts[1].y);
    mDrawLabel(ctx, mFormatDist(mPxDist(pts[0], pts[1]), calib), (pts[0].x+pts[1].x)/2, (pts[0].y+pts[1].y)/2 - 14);
  } else if (type === "polylength" && pts.length >= 2) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke(); pts.forEach(p => mDot(ctx, p.x, p.y));
    for (let i = 1; i < pts.length; i++) {
      const mx = (pts[i-1].x+pts[i].x)/2, my = (pts[i-1].y+pts[i].y)/2;
      if (pts.length > 2) mDrawLabel(ctx, mFormatDist(mPxDist(pts[i-1], pts[i]), calib), mx, my - 12, "#88ddff");
    }
    mDrawLabel(ctx, `Total: ${mFormatDist(mPolyLen(pts), calib)}`, pts[pts.length-1].x, pts[pts.length-1].y - 22);
  } else if ((type === "area" || type === "perimeter") && pts.length >= 3) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    if (type === "area") { ctx.fillStyle = "rgba(0,229,255,0.1)"; ctx.fill(); }
    ctx.stroke(); pts.forEach(p => mDot(ctx, p.x, p.y));
    const cx = pts.reduce((s,p)=>s+p.x,0)/pts.length, cy = pts.reduce((s,p)=>s+p.y,0)/pts.length;
    const label = type === "area"
      ? mFormatArea(mPolyArea(pts), calib)
      : mFormatDist(mPolyLen([...pts, pts[0]]), calib);
    mDrawLabel(ctx, label, cx, cy);
  } else if (type === "angle" && pts.length >= 3) {
    const [v, p2, p3] = pts;
    ctx.beginPath(); ctx.moveTo(v.x,v.y); ctx.lineTo(p2.x,p2.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(v.x,v.y); ctx.lineTo(p3.x,p3.y); ctx.stroke();
    const r = 22, a1 = Math.atan2(p2.y-v.y, p2.x-v.x), a2 = Math.atan2(p3.y-v.y, p3.x-v.x);
    ctx.beginPath(); ctx.arc(v.x, v.y, r, Math.min(a1,a2), Math.max(a1,a2)); ctx.stroke();
    mDot(ctx,v.x,v.y); mDot(ctx,p2.x,p2.y); mDot(ctx,p3.x,p3.y);
    mDrawLabel(ctx, `${mAngleDeg(v,p2,p3).toFixed(1)}°`, v.x, v.y - 30);
  } else if (type === "count" && pts.length >= 1) {
    const p = pts[0];
    ctx.save(); ctx.fillStyle = "#00e5ff"; ctx.beginPath(); ctx.arc(p.x,p.y,9,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = "#000"; ctx.font = "bold 10px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("#", p.x, p.y); ctx.restore();
  }
  ctx.restore();
}
function mDrawInProgress(ctx, pts, type, mousePos, calib) {
  if (pts.length === 0 && !mousePos) return;
  const DASH = [6, 4];
  ctx.save();

  // ── Draw committed segments ──────────────────────────────────────────────
  ctx.strokeStyle = "#007BFF"; ctx.lineWidth = 1.5; ctx.setLineDash(DASH);
  if (["length","polylength","area","perimeter"].includes(type) && pts.length > 0) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    pts.forEach(p => mDot(ctx, p.x, p.y, "#007BFF"));
  } else if (type === "angle") {
    if (pts.length >= 2) { ctx.beginPath(); ctx.moveTo(pts[0].x,pts[0].y); ctx.lineTo(pts[1].x,pts[1].y); ctx.stroke(); }
    if (pts.length >= 3) { ctx.beginPath(); ctx.moveTo(pts[0].x,pts[0].y); ctx.lineTo(pts[2].x,pts[2].y); ctx.stroke(); }
    pts.forEach(p => mDot(ctx, p.x, p.y, "#007BFF"));
  }

  // ── Draw live preview from last point to mouse cursor ───────────────────
  if (mousePos && pts.length > 0) {
    ctx.globalAlpha = 0.6;
    const last = pts[pts.length - 1];

    if (type === "length" && pts.length === 1) {
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(mousePos.x, mousePos.y); ctx.stroke();
    } else if (type === "polylength") {
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(mousePos.x, mousePos.y); ctx.stroke();
      const total = mPolyLen([...pts, mousePos]);
      mDrawLabel(ctx, `Total: ${mFormatDist(total, calib)}`, mousePos.x, mousePos.y - 18, "#007BFF");
    } else if (type === "area" || type === "perimeter") {
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(mousePos.x, mousePos.y); ctx.stroke();
      if (pts.length >= 2) {
        ctx.beginPath(); ctx.moveTo(mousePos.x, mousePos.y); ctx.lineTo(pts[0].x, pts[0].y); ctx.stroke();
      }
    } else if (type === "angle" && pts.length === 1) {
      ctx.beginPath(); ctx.moveTo(pts[0].x,pts[0].y); ctx.lineTo(mousePos.x,mousePos.y); ctx.stroke();
    } else if (type === "angle" && pts.length === 2) {
      ctx.beginPath(); ctx.moveTo(pts[0].x,pts[0].y); ctx.lineTo(mousePos.x,mousePos.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ── Cursor crosshair dot ─────────────────────────────────────────────────
  if (mousePos) {
    ctx.save(); ctx.fillStyle = "#007BFF"; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.arc(mousePos.x, mousePos.y, 3, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

// ── Snap to Content ────────────────────────────────────────────────────────

const SNAP_CELL_SIZE = 20;
const SNAP_MAX_PTS   = 5000;

function snapStrengthToThreshold(strength) {
  return 4 + (strength - 1) * (8 / 9); // 1→4px, 6→8.4px, 10→12px
}

async function getPageSnapPoints(page, scale, cache) {
  const key = `${page.pageNumber}-${scale.toFixed(4)}`;
  if (cache.has(key)) return cache.get(key);
  let opList;
  try { opList = await page.getOperatorList(); } catch { return null; }
  const OPS = window.pdfjsLib?.OPS;
  if (!OPS) { cache.set(key, null); return null; }
  const vp   = page.getViewport({ scale });
  const pts  = [];
  let pathOps = 0, curX = 0, curY = 0;
  const cv = (x, y) => { const [cx, cy] = vp.convertToViewportPoint(x, y); return { x: cx, y: cy }; };
  const fns = opList.fnArray, args = opList.argsArray;
  for (let i = 0; i < fns.length && pts.length < SNAP_MAX_PTS; i++) {
    const fn = fns[i], a = args[i];
    if (fn === OPS.moveTo) {
      const p = cv(a[0], a[1]); curX = a[0]; curY = a[1]; pts.push(p); pathOps++;
    } else if (fn === OPS.lineTo) {
      const from = cv(curX, curY), to = cv(a[0], a[1]);
      pts.push(to);
      pts.push({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, isMid: true });
      curX = a[0]; curY = a[1]; pathOps++;
    } else if (fn === OPS.curveTo) {
      const p = cv(a[4], a[5]); pts.push(p); curX = a[4]; curY = a[5]; pathOps++;
    } else if (fn === OPS.curveTo1 || fn === OPS.curveTo2) {
      const p = cv(a[2], a[3]); pts.push(p); curX = a[2]; curY = a[3]; pathOps++;
    } else if (fn === OPS.rectangle) {
      const [rx, ry, rw, rh] = a;
      const corners = [cv(rx,ry), cv(rx+rw,ry), cv(rx+rw,ry+rh), cv(rx,ry+rh)];
      corners.forEach(p => pts.push(p));
      for (let j = 0; j < 4; j++) {
        const ca = corners[j], cb = corners[(j+1)%4];
        pts.push({ x: (ca.x+cb.x)/2, y: (ca.y+cb.y)/2, isMid: true });
      }
      pathOps += 4;
    }
  }
  const result = { points: pts.slice(0, SNAP_MAX_PTS), pathOps };
  cache.set(key, result);
  return result;
}

function buildSnapGrid(points) {
  const grid = new Map();
  for (const p of points) {
    const k = `${Math.floor(p.x / SNAP_CELL_SIZE)},${Math.floor(p.y / SNAP_CELL_SIZE)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }
  return grid;
}

function snapToContent(mx, my, grid, settings, threshold) {
  if (!grid) return null;
  const c0x = Math.floor((mx - threshold) / SNAP_CELL_SIZE);
  const c0y = Math.floor((my - threshold) / SNAP_CELL_SIZE);
  const c1x = Math.floor((mx + threshold) / SNAP_CELL_SIZE);
  const c1y = Math.floor((my + threshold) / SNAP_CELL_SIZE);
  let best = null, bestDist = threshold + 1;
  for (let gcx = c0x; gcx <= c1x; gcx++) {
    for (let gcy = c0y; gcy <= c1y; gcy++) {
      const bucket = grid.get(`${gcx},${gcy}`);
      if (!bucket) continue;
      for (const p of bucket) {
        if (p.isMid && !settings.midpoints) continue;
        if (!p.isMid && !settings.endpoints) continue;
        const d = Math.sqrt((p.x - mx) ** 2 + (p.y - my) ** 2);
        if (d < bestDist) { bestDist = d; best = { x: p.x, y: p.y, type: p.isMid ? "midpoint" : "endpoint", dist: d }; }
      }
    }
  }
  return best ? { snapped: true, ...best } : null;
}

function mDrawSnapIndicator(ctx, snap) {
  if (!snap) return;
  const { x, y, type } = snap;
  ctx.save();
  ctx.strokeStyle = "#007BFF"; ctx.lineWidth = 1.5; ctx.setLineDash([]);
  if (type === "endpoint") {
    ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
  } else if (type === "midpoint") {
    ctx.beginPath(); ctx.moveTo(x, y - 5.5); ctx.lineTo(x + 5, y + 4); ctx.lineTo(x - 5, y + 4); ctx.closePath(); ctx.stroke();
  } else if (type === "intersection") {
    ctx.beginPath();
    ctx.moveTo(x-4,y-4); ctx.lineTo(x+4,y+4);
    ctx.moveTo(x+4,y-4); ctx.lineTo(x-4,y+4);
    ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

// ── META question classifier ───────────────────────────────────────────────

const META_ANSWERS = [
  {
    id: "about_app",
    triggers: ["what is footprint navigator", "about this app", "what is this tool", "tell me about the app", "about navigator", "about footprint navigator", "what does this app do", "what is this application"],
    words: ["footprint navigator", "this app", "this tool", "what is this", "about navigator"],
    answer: "Footprint Navigator is a document intelligence platform built by Footprint Technologies. It lets you upload large document sets, navigate them instantly, search page content, and ask questions in plain language. It was designed for construction professionals but works across any industry with large structured document sets.",
  },
  {
    id: "who_built",
    triggers: ["who made this", "who built this", "who created this", "who is behind this", "who made footprint", "who built footprint", "who created footprint"],
    words: ["who made", "who built", "who created", "who is behind"],
    answer: "Footprint Navigator was built by Footprint Technologies. For more information or support, contact us at info@footprintrobotics.com.",
  },
  {
    id: "how_ai_works",
    triggers: ["how does the ai work", "how do you work", "how are you built", "explain the ai", "how does navigator work", "how does this work", "what is your architecture"],
    words: ["how does", "how do you", "how are you", "explain the ai", "how does the ai"],
    answer: "Navigator uses a multi-tier AI routing system. Simple questions are answered by keyword search at no cost. More complex questions are routed to AI models based on complexity — simple lookups use faster models, complex reasoning uses more powerful ones. Every answer is grounded in your document content to minimize hallucination. The system also maintains a document summary and session memory to avoid repeat API calls.",
  },
  {
    id: "what_model",
    triggers: ["what model are you", "which ai model", "what ai are you using", "are you chatgpt", "are you claude", "are you gemini", "what model is this", "which model", "what model do you use"],
    words: ["what model", "which model", "which ai", "what ai", "are you chatgpt", "are you claude", "are you gemini", "are you gpt"],
    answer: "Navigator uses a model routing system that selects the best AI model for each question. Depending on your settings, this may include Groq (Llama 3.3 70B), Google Gemini, Anthropic Claude, or OpenAI GPT-4o. You can see which model answered each question by the colored badge next to the response, and change your model preferences in Navigator Settings.",
  },
  {
    id: "what_can_you_do",
    triggers: ["what can you do", "what features do you have", "how do i use this", "help me understand", "what are your features", "show me what you can do", "what are your capabilities"],
    words: ["what can you do", "what features", "how do i use", "help me understand", "your capabilities", "what are you capable"],
    answer: "Navigator can: search any document for keywords and jump to matching pages, answer questions about your document content, navigate to specific sheets by number, measure lengths, areas, and perimeters on calibrated drawings, detect sheet numbers automatically, and remember your conversation history. Open Navigator Settings (⚙) to customize AI behavior and model preferences.",
  },
  {
    id: "footprint_company",
    triggers: ["what is footprint technologies", "tell me about footprint technologies", "footprint company", "footprint technologies"],
    words: ["footprint technologies", "footprint company"],
    answer: "Footprint Technologies is the company behind Footprint Navigator. Contact: info@footprintrobotics.com.",
  },
  {
    id: "what_are_you",
    triggers: ["what are you", "who are you", "are you an ai", "are you a bot", "are you a chatbot"],
    words: ["what are you", "who are you", "are you an ai", "are you a bot"],
    answer: "I'm Footprint Navigator — a document intelligence assistant built by Footprint Technologies. I can search your documents, answer questions about their content, and help you navigate large PDF sets. Ask me anything about the document you've loaded.",
  },
];

// Terms that indicate the question is about the document, not the app
const META_DOCUMENT_GUARDS = [
  "this document", "this pdf", "this file", "in the document", "on this page",
  "structural", "mechanical", "electrical", "plumbing", "architectural",
  "sheet number", "drawing number", "specification", "submittal",
  "floor plan", "elevation", "section", "detail", "rfi", "rfi#",
  "square footage", "sq ft", "cubic", "load", "span", "beam", "column",
];

function classifyMeta(q) {
  const ql = q.toLowerCase().trim();

  // Guard: if document terms are present, this is a document question
  for (const guard of META_DOCUMENT_GUARDS) {
    if (ql.includes(guard)) return null;
  }

  // Check each META category
  for (const cat of META_ANSWERS) {
    // First: exact trigger phrase match
    for (const trigger of cat.triggers) {
      if (ql.includes(trigger)) return cat.answer;
    }
    // Second: fuzzy — count how many trigger words/phrases appear
    let hits = 0;
    for (const word of cat.words) {
      if (ql.includes(word)) hits++;
    }
    if (hits >= 2) return cat.answer;
  }
  return null;
}

const VIEW_MODE_BTNS = [
  { id: "single",   icon: "⬜", tooltip: "Single Page (Ctrl+1)" },
  { id: "splitV",   icon: "◫",  tooltip: "Split Vertical (Ctrl+2)" },
  { id: "splitH",   icon: "⊟",  tooltip: "Split Horizontal (Ctrl+H)" },
];

const TOOL_BTNS = [
  { id: "pan",    icon: "✥",  tooltip: "Pan (Shift+V)" },
  { id: "select", icon: "↖",  tooltip: "Select (V)" },
  { id: "text",   icon: "Ⅰ",  tooltip: "Select Text (Shift+T)" },
  { id: "zoom",   icon: "⌕",  tooltip: "Zoom (Z)" },
];

// ── Workspace ────────────────────────────────────────────────────────────────

export default function Workspace({ file, meta, pageTexts, pageTitles, pageSheets, isOcring, ocrProgress, onNewFile }) {
  // PDF
  const [pdfDoc,   setPdfDoc]   = useState(null);
  const [numPages, setNumPages] = useState(meta.pages || 0);
  const [pageNum,  setPageNum]  = useState(1);
  const [scale,    setScale]    = useState(null); // null = waiting for fit-width calc
  const [isRendering, setIsRendering] = useState(false);

  // UI
  const [currentTool,    setCurrentTool]    = useState("pan");
  const [openMenu,       setOpenMenu]       = useState(null);
  const [openSubmenu,    setOpenSubmenu]    = useState(null);
  const [activePanelTab, setActivePanelTab] = useState("thumbnails");
  const [panelOpen,      setPanelOpen]      = useState(true);
  const [leftOpen,       setLeftOpen]       = useState(true);
  const [viewMode,       setViewMode]       = useState("single"); // "single"|"splitV"|"splitH"
  const [pageDims,       setPageDims]       = useState("");

  // Search
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const searchResults = searchQuery ? buildSearchResults(pageTexts, searchQuery) : [];

  // Page num input (local, committed on blur/enter)
  const [pageInputVal, setPageInputVal] = useState("1");
  useEffect(() => { setPageInputVal(String(pageNum)); }, [pageNum]);

  // Chat
  const [chatOpen,     setChatOpen]     = useState(false);
  const [chatHeight,   setChatHeight]   = useState(160);
  const [chatInput,    setChatInput]    = useState("");
  const [chatMessages, setChatMessages] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`chat:${meta.filename}`) || "[]"); }
    catch { return []; }
  });
  const [chatBannerDismissed, setChatBannerDismissed] = useState(
    () => sessionStorage.getItem("nav-banner-dismissed") === "1"
  );
  const [docSummary,     setDocSummary]     = useState(null);
  const [summaryStatus,  setSummaryStatus]  = useState("idle"); // idle|loading|ready|error
  const [summaryExpanded,setSummaryExpanded] = useState(false);
  const [summaryAnalyzedAt, setSummaryAnalyzedAt] = useState(null);
  const [thinkingText,      setThinkingText]       = useState("Navigator is thinking…");
  const [docIntelGlow,  setDocIntelGlow]   = useState(false);
  // Settings panel
  const [settingsOpen,    setSettingsOpen]    = useState(false);
  const [customPrompt,    setCustomPrompt]    = useState(() => localStorage.getItem("navigator-system-prompt") || "");
  const [responseLength,  setResponseLength]  = useState(() => localStorage.getItem("navigator-response-length") || "medium");
  const [keywordThreshold,setKeywordThreshold]= useState(() => parseInt(localStorage.getItem("navigator-keyword-threshold") || "3", 10));
  const [contextFiles,    setContextFiles]    = useState(() => { try { return JSON.parse(localStorage.getItem(`navigator-context-files-${meta.filename}`) || "[]"); } catch { return []; } });
  const [usageStats,      setUsageStats]      = useState({ geminiCalls: 0, fromMemory: 0, fromKeywords: 0, fromSummary: 0 });
  // Editable staging for settings (committed on Save)
  const [stgPrompt,       setStgPrompt]       = useState(() => localStorage.getItem("navigator-system-prompt") || "");
  const [stgResponseLen,  setStgResponseLen]  = useState(() => localStorage.getItem("navigator-response-length") || "medium");
  const [stgThreshold,    setStgThreshold]    = useState(() => parseInt(localStorage.getItem("navigator-keyword-threshold") || "3", 10));
  // AI model mode + custom overrides
  const [navigatorMode,        setNavigatorMode]        = useState(() => localStorage.getItem("navigator-mode") || "balanced");
  const [customModelsEnabled,  setCustomModelsEnabled]  = useState(() => localStorage.getItem("navigator-custom-enabled") === "true");
  const [customModelConfig,    setCustomModelConfig]    = useState(() => { try { return JSON.parse(localStorage.getItem("navigator-custom-models") || "{}"); } catch { return {}; } });
  // Session cost tracker
  const [sessionCost,     setSessionCost]     = useState(() => { try { return parseFloat(sessionStorage.getItem("navigator-session-cost") || "0") || 0; } catch { return 0; } });
  const [sessionAICount,  setSessionAICount]  = useState(0);
  // Toast & modal system
  const [toasts,     setToasts]     = useState([]);
  const [modal,      setModal]      = useState(null); // null | { type: string }
  const [saveAsName, setSaveAsName] = useState("");
  // Measurement tools
  const [measureTool,       setMeasureTool]       = useState(null); // "length"|"area"|"perimeter"|"count"|null
  const [measurePoints,     setMeasurePoints]     = useState([]);   // {x, y} in document coordinates
  const [measurements,      setMeasurements]      = useState([]);   // completed measurements
  const [showMeasurePanel,  setShowMeasurePanel]  = useState(false);
  // Snap to Content
  const [snapEnabled,  setSnapEnabled]  = useState(() => localStorage.getItem("navigator-snap-enabled") !== "false");
  const [snapSettings, setSnapSettings] = useState(() => {
    try { return JSON.parse(localStorage.getItem("navigator-snap-settings") || "null") || { endpoints: true, midpoints: true, intersections: true, strength: 6 }; }
    catch { return { endpoints: true, midpoints: true, intersections: true, strength: 6 }; }
  });
  const [snapStatus, setSnapStatus] = useState(null); // "vector"|"scanned"|null

  // Scale calibration
  const [calibMode,  setCalibMode]  = useState(false);
  const [calibPts,   setCalibPts]   = useState([]);
  const [calibDist,  setCalibDist]  = useState("");
  const [calibUnit,  setCalibUnit]  = useState("feet");
  const [calibSaved, setCalibSaved] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`navigator-scale-${meta.filename}`) || "null"); }
    catch { return null; }
  });
  const [calibDistError, setCalibDistError] = useState("");
  const toastIdRef     = useRef(0);
  const textLayerRef   = useRef(null);
  const calibCanvasRef     = useRef(null);
  const measureCanvasRef   = useRef(null);
  const measurePointsRef   = useRef([]);
  const currentToolRef     = useRef("pan");
  const mousePosRef        = useRef({ x: 0, y: 0 });
  const snapResultRef      = useRef(null);
  const snapGridRef        = useRef(null);
  const snapCacheRef       = useRef(new Map());
  const snapEnabledRef     = useRef(true);
  const snapSettingsRef    = useRef({ endpoints: true, midpoints: true, intersections: true, strength: 6 });
  const snapToastShownRef  = useRef(false);
  const prevToolRef        = useRef("pan");
  const calibModeRef       = useRef(false);
  const chatBottomRef   = useRef(null);
  const docIntelRef        = useRef(null);
  const chatMessagesRef    = useRef(null);
  const thinkingTimersRef  = useRef([]);

  // View history — stored in refs to avoid re-renders on push
  const viewHistRef    = useRef({ history: [{ page: 1, scale: null, panX: 0, panY: 0 }] });
  const viewHistIdxRef = useRef(0);
  const isNavHistRef   = useRef(false);

  // Refs
  const canvasRef           = useRef(null);
  const canvasWrapRef       = useRef(null);
  const renderTaskRef       = useRef(null);
  const menuBarRef          = useRef(null);
  const fileInputRef        = useRef(null);
  const pendingScrollAdjRef = useRef(null); // { docX, docY, cx, cy, ratio }

  // Mirror current page/scale into refs for use inside event handlers
  const pageNumRef = useRef(pageNum);
  const scaleRef   = useRef(scale);
  useEffect(() => { pageNumRef.current = pageNum; }, [pageNum]);
  useEffect(() => { scaleRef.current   = scale;   }, [scale]);

  // ── PDF Load ───────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const buffer = await file.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
      if (cancelled) { doc.destroy(); return; }
      setPdfDoc(doc);
      setNumPages(doc.numPages);
    })();
    return () => { cancelled = true; };
  }, [file]);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const calcFitWidthScale = useCallback(async (doc, num) => {
    if (!doc || !canvasWrapRef.current) return 1;
    const page = await doc.getPage(num);
    const vp = page.getViewport({ scale: 1 });
    const availW = canvasWrapRef.current.clientWidth - 64;
    return Math.max(0.1, availW / vp.width);
  }, []);

  const calcFitPageScale = useCallback(async (doc, num) => {
    if (!doc || !canvasWrapRef.current) return 1;
    const page = await doc.getPage(num);
    const vp = page.getViewport({ scale: 1 });
    const w = canvasWrapRef.current.clientWidth  - 64;
    const h = canvasWrapRef.current.clientHeight - 64;
    return Math.max(0.1, Math.min(w / vp.width, h / vp.height));
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  const renderPage = useCallback(async (doc, num, s, query) => {
    if (!doc || !canvasRef.current) return;
    setIsRendering(true);
    if (renderTaskRef.current) { renderTaskRef.current.cancel(); renderTaskRef.current = null; }
    try {
      const page = await doc.getPage(num);
      const viewport = page.getViewport({ scale: s });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;

      canvas.width  = Math.floor(viewport.width  * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width  = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      // Apply pending zoom-to-cursor scroll adjustment
      if (pendingScrollAdjRef.current && canvasWrapRef.current) {
        const { docX, docY, mouseX, mouseY } = pendingScrollAdjRef.current;
        pendingScrollAdjRef.current = null;
        const w = canvasWrapRef.current;
        requestAnimationFrame(() => {
          w.scrollLeft = docX * s - mouseX;
          w.scrollTop  = docY * s - mouseY;
        });
      }

      const task = page.render({
        canvasContext: ctx, viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      });
      renderTaskRef.current = task;
      await task.promise;
      renderTaskRef.current = null;

      if (query && query.trim()) await drawHighlights(ctx, page, viewport, dpr, query.trim());

      // Render PDF.js text layer for text selection
      if (textLayerRef.current) {
        const tl = textLayerRef.current;
        tl.innerHTML = "";
        tl.style.width  = `${Math.floor(viewport.width)}px`;
        tl.style.height = `${Math.floor(viewport.height)}px`;
        try {
          const textContent = await page.getTextContent();
          if (pdfjsLib.TextLayer) {
            // PDF.js v4+ class-based API
            const layer = new pdfjsLib.TextLayer({ textContentSource: textContent, container: tl, viewport });
            await layer.render();
          } else if (typeof pdfjsLib.renderTextLayer === "function") {
            // Legacy PDF.js v2/v3 function API
            pdfjsLib.renderTextLayer({ textContentSource: textContent, container: tl, viewport });
          }
        } catch { /* graceful degradation */ }
      }
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") console.error("Render:", err);
    } finally {
      setIsRendering(false);
    }
  }, []);

  // Initial fit-width when pdfDoc loads + extract page dimensions
  useEffect(() => {
    if (!pdfDoc) return;
    (async () => {
      const s = await calcFitWidthScale(pdfDoc, 1);
      setScale(s);
      await renderPage(pdfDoc, 1, s, searchQuery);
      // Page dimensions (1 PDF unit = 1/72 inch)
      const page = await pdfDoc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const wIn = (vp.width / 72).toFixed(2);
      const hIn = (vp.height / 72).toFixed(2);
      setPageDims(`${wIn} × ${hIn} in`);
    })();
  }, [pdfDoc]); // eslint-disable-line

  // Push view state to history whenever page or scale changes
  useEffect(() => {
    if (isNavHistRef.current) return;
    const vh = viewHistRef.current;
    const cur = vh.history[viewHistIdxRef.current];
    if (cur?.page === pageNum && cur?.scale === scale) return;
    const newState = {
      page: pageNum, scale,
      panX: canvasWrapRef.current?.scrollLeft ?? 0,
      panY: canvasWrapRef.current?.scrollTop  ?? 0,
    };
    vh.history = vh.history.slice(0, viewHistIdxRef.current + 1);
    vh.history.push(newState);
    if (vh.history.length > 50) vh.history.shift();
    else viewHistIdxRef.current++;
  }, [pageNum, scale]);

  // Re-render on changes (scale !== null guards against running before init)
  const prevRenderKey = useRef(null);
  useEffect(() => {
    if (!pdfDoc || scale === null) return;
    const key = `${pageNum}|${scale}|${searchQuery}`;
    if (prevRenderKey.current === null) { prevRenderKey.current = key; return; } // skip initial
    if (key === prevRenderKey.current) return;
    prevRenderKey.current = key;
    renderPage(pdfDoc, pageNum, scale, searchQuery);
  }, [pdfDoc, pageNum, scale, searchQuery, renderPage]);

  // ── Mouse Wheel: Ctrl = zoom toward cursor, else = native scroll ───────────

  useEffect(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return; // let browser scroll naturally
      e.preventDefault();
      const currentS = scaleRef.current;
      if (!currentS) return;
      const rect   = wrap.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      // Document-space point under cursor (scale-independent)
      const docX = (mouseX + wrap.scrollLeft) / currentS;
      const docY = (mouseY + wrap.scrollTop)  / currentS;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const next = Math.min(5, Math.max(0.1, parseFloat((currentS * factor).toFixed(3))));
      // Store so renderPage can reposition: newScrollLeft = docX * newScale - mouseX
      pendingScrollAdjRef.current = { docX, docY, mouseX, mouseY };
      setScale(next);
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, []);

  // ── Pan Drag ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    let isDown = false, startX = 0, startY = 0, sl = 0, st = 0;

    const onDown = (e) => {
      if (currentTool !== "pan") return;
      if (e.target?.closest?.("button, input, a, select")) return;
      isDown = true;
      startX = e.clientX; startY = e.clientY;
      sl = wrap.scrollLeft; st = wrap.scrollTop;
      wrap.classList.add("panning");
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!isDown) return;
      wrap.scrollLeft = sl - (e.clientX - startX);
      wrap.scrollTop  = st - (e.clientY - startY);
    };
    const onUp = () => {
      if (!isDown) return;
      isDown = false;
      wrap.classList.remove("panning");
      // Push pan position into history on drag end
      if (!isNavHistRef.current) {
        const vh = viewHistRef.current;
        const newState = {
          page: pageNumRef.current, scale: scaleRef.current,
          panX: wrap.scrollLeft, panY: wrap.scrollTop,
        };
        vh.history = vh.history.slice(0, viewHistIdxRef.current + 1);
        vh.history.push(newState);
        if (vh.history.length > 50) vh.history.shift();
        else viewHistIdxRef.current++;
      }
    };

    wrap.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      wrap.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [currentTool]);

  // ── Zoom Click ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap || currentTool !== "zoom") return;
    const onClick = (e) => {
      if (e.target?.closest?.("button, input, a")) return;
      const factor = e.altKey ? 0.8 : 1.25;
      setScale((s) => s === null ? s : Math.min(5, Math.max(0.1, parseFloat((s * factor).toFixed(3)))));
    };
    wrap.addEventListener("click", onClick);
    return () => wrap.removeEventListener("click", onClick);
  }, [currentTool]);

  // ── View History Navigation ────────────────────────────────────────────────

  const goBackView = useCallback(() => {
    const vh = viewHistRef.current;
    if (viewHistIdxRef.current <= 0) return;
    viewHistIdxRef.current--;
    const state = vh.history[viewHistIdxRef.current];
    isNavHistRef.current = true;
    setPageNum(state.page);
    if (state.scale !== null) setScale(state.scale);
    requestAnimationFrame(() => {
      if (canvasWrapRef.current) {
        canvasWrapRef.current.scrollLeft = state.panX;
        canvasWrapRef.current.scrollTop  = state.panY;
      }
    });
    setTimeout(() => { isNavHistRef.current = false; }, 600);
  }, []);

  const goForwardView = useCallback(() => {
    const vh = viewHistRef.current;
    if (viewHistIdxRef.current >= vh.history.length - 1) return;
    viewHistIdxRef.current++;
    const state = vh.history[viewHistIdxRef.current];
    isNavHistRef.current = true;
    setPageNum(state.page);
    if (state.scale !== null) setScale(state.scale);
    requestAnimationFrame(() => {
      if (canvasWrapRef.current) {
        canvasWrapRef.current.scrollLeft = state.panX;
        canvasWrapRef.current.scrollTop  = state.panY;
      }
    });
    setTimeout(() => { isNavHistRef.current = false; }, 600);
  }, []);

  // ── Keyboard Shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e) => {
      const inInput = e.target?.tagName === "INPUT" || e.target?.tagName === "TEXTAREA";
      const ctrl  = e.ctrlKey || e.metaKey;
      const alt   = e.altKey;
      const shift = e.shiftKey;
      const k     = e.key;

      // Close modal / cancel calibration / cancel measurement
      if (k === "Escape") {
        if (calibModeRef.current) {
          setCalibMode(false); setCalibPts([]); setModal(null);
          setCurrentTool(prevToolRef.current);
        } else if (measurePointsRef.current.length > 0) {
          setMeasurePoints([]);
        } else {
          setModal(null);
        }
        return;
      }

      // Full Screen
      if (k === "F11") { e.preventDefault(); if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.(); return; }

      // Tool shortcuts (not in input, no ctrl/alt)
      if (!inInput && !ctrl && !alt) {
        if (k === "v" && !shift) { e.preventDefault(); setCurrentTool("select"); return; }
        if ((k === "v" || k === "V") && shift) { e.preventDefault(); setCurrentTool("pan"); return; }
        if ((k === "t" || k === "T") && shift) { e.preventDefault(); setCurrentTool("text"); return; }
        if ((k === "z" || k === "Z"))           { e.preventDefault(); setCurrentTool("zoom"); return; }
      }

      // Measurement shortcuts (Shift+Alt+key)
      if (!inInput && shift && alt) {
        const activate = (tool) => { e.preventDefault(); setCurrentTool(tool); setMeasureTool(tool); setMeasurePoints([]); };
        if (k === "l" || k === "L") { activate("length");     return; }
        if (k === "q" || k === "Q") { activate("polylength"); return; }
        if (k === "a" || k === "A") { activate("area");       return; }
        if (k === "p" || k === "P") { activate("perimeter");  return; }
        if (k === "g" || k === "G") { activate("angle");      return; }
        if (k === "c" || k === "C") { activate("count");      return; }
      }

      // F3: toggle snap
      if (k === "F3") {
        e.preventDefault();
        setSnapEnabled((v) => !v);
        snapResultRef.current = null;
        return;
      }

      // Backspace: undo last measurement point
      if (!inInput && k === "Backspace" && measurePointsRef.current.length > 0) {
        e.preventDefault();
        setMeasurePoints((prev) => prev.slice(0, -1));
        return;
      }

      // Enter: complete polylength / area / perimeter
      if (!inInput && k === "Enter") {
        const tool = currentToolRef.current;
        const pts  = measurePointsRef.current;
        if (tool === "polylength" && pts.length >= 2) {
          e.preventDefault();
          setMeasurements((ms) => [...ms, { id: Date.now(), page: pageNum, type: tool, points: [...pts] }]);
          setMeasurePoints([]);
          return;
        }
        if ((tool === "area" || tool === "perimeter") && pts.length >= 3) {
          e.preventDefault();
          setMeasurements((ms) => [...ms, { id: Date.now(), page: pageNum, type: tool, points: [...pts] }]);
          setMeasurePoints([]);
          return;
        }
        if ((tool === "area" || tool === "perimeter") && pts.length > 0 && pts.length < 3) {
          e.preventDefault();
          showToast(`${tool === "area" ? "Area" : "Perimeter"} requires at least 3 points`);
          return;
        }
      }

      // View mode (Ctrl+1, Ctrl+2, Ctrl+H)
      if (ctrl && k === "1") { e.preventDefault(); setViewMode("single");  return; }
      if (ctrl && k === "2") { e.preventDefault(); setViewMode("splitV");  return; }
      if (ctrl && (k === "h" || k === "H")) { e.preventDefault(); setViewMode("splitH"); return; }

      // Ctrl+A: select all text on current page (text tool only)
      if (ctrl && (k === "a" || k === "A") && currentToolRef.current === "text") {
        e.preventDefault();
        if (textLayerRef.current) {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(textLayerRef.current);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        return;
      }

      // View history: Alt+Arrows and Ctrl+Z / Ctrl+Y (skip when text tool active — let browser handle)
      if (alt && k === "ArrowLeft")  { e.preventDefault(); goBackView();    return; }
      if (alt && k === "ArrowRight") { e.preventDefault(); goForwardView(); return; }
      if (!inInput && ctrl && (k === "z" || k === "Z") && currentToolRef.current !== "text") { e.preventDefault(); goBackView();    return; }
      if (!inInput && ctrl && (k === "y" || k === "Y") && currentToolRef.current !== "text") { e.preventDefault(); goForwardView(); return; }

      // Find (Ctrl+F)
      if (!inInput && ctrl && (k === "f" || k === "F")) { e.preventDefault(); setActivePanelTab("search"); setPanelOpen(true); return; }

      // Page navigation
      if (ctrl && k === "Home") { e.preventDefault(); setPageNum(1); return; }
      if (ctrl && k === "End")  { e.preventDefault(); setPageNum(numPages || meta.pages); return; }
      if (ctrl && k === "ArrowLeft")  { e.preventDefault(); setPageNum((p) => Math.max(1, p - 1)); return; }
      if (ctrl && k === "ArrowRight") { e.preventDefault(); setPageNum((p) => Math.min(numPages || meta.pages, p + 1)); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [numPages, meta.pages, goBackView, goForwardView]);

  // ── Menu Close on Outside Click ────────────────────────────────────────────

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e) => { if (!menuBarRef.current?.contains(e.target)) setOpenMenu(null); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openMenu]);

  // ── Text layer pointer-events (imperative, reacts to tool changes) ──────────

  useEffect(() => {
    if (textLayerRef.current) {
      textLayerRef.current.style.pointerEvents = currentTool === "text" ? "auto" : "none";
    }
  }, [currentTool]);

  // ── Calibration helpers ────────────────────────────────────────────────────

  useEffect(() => { calibModeRef.current      = calibMode;    }, [calibMode]);
  useEffect(() => { currentToolRef.current    = currentTool;  }, [currentTool]);
  useEffect(() => { measurePointsRef.current  = measurePoints; }, [measurePoints]);
  useEffect(() => { snapEnabledRef.current    = snapEnabled;
    localStorage.setItem("navigator-snap-enabled", String(snapEnabled)); }, [snapEnabled]);
  useEffect(() => { snapSettingsRef.current   = snapSettings;
    localStorage.setItem("navigator-snap-settings", JSON.stringify(snapSettings)); }, [snapSettings]);

  // Background snap point extraction — runs after page/scale change
  useEffect(() => {
    if (!pdfDoc || !scale) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await pdfDoc.getPage(pageNum);
        if (cancelled) return;
        snapGridRef.current   = null;
        snapResultRef.current = null;
        if (!snapEnabledRef.current) { setSnapStatus(null); return; }
        const data = await getPageSnapPoints(page, scale, snapCacheRef.current);
        if (cancelled || !data) return;
        if (data.pathOps < 10) {
          setSnapStatus("scanned");
          snapGridRef.current = null;
          if (!snapToastShownRef.current) {
            snapToastShownRef.current = true;
            showToast("Snap: vector paths not found on this page");
          }
        } else {
          setSnapStatus("vector");
          snapGridRef.current = buildSnapGrid(data.points);
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [pdfDoc, pageNum, scale]);

  // Draw calibration crosshairs + dashed line on the overlay canvas
  useEffect(() => {
    const canvas = calibCanvasRef.current;
    const pdfCanvas = canvasRef.current;
    if (!canvas || !pdfCanvas) return;
    const w = parseFloat(pdfCanvas.style.width)  || pdfCanvas.offsetWidth  || 800;
    const h = parseFloat(pdfCanvas.style.height) || pdfCanvas.offsetHeight || 600;
    canvas.width  = w;
    canvas.height = h;
    canvas.style.width  = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    if (!calibMode || calibPts.length === 0) return;
    const drawCross = ({ x, y }) => {
      ctx.strokeStyle = "#007BFF"; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y);
      ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10);
      ctx.stroke();
      ctx.fillStyle = "#007BFF";
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    };
    calibPts.forEach(drawCross);
    if (calibPts.length === 2) {
      ctx.strokeStyle = "#007BFF"; ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(calibPts[0].x, calibPts[0].y);
      ctx.lineTo(calibPts[1].x, calibPts[1].y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [calibMode, calibPts]);

  const cancelCalib = useCallback(() => {
    setCalibMode(false);
    setCalibPts([]);
    setModal(null);
    setCurrentTool(prevToolRef.current);
  }, []);

  const confirmCalib = useCallback((pixelDist) => {
    const dist = parseCalibDist(calibDist, calibUnit);
    if (dist === null || dist <= 0) {
      setCalibDistError("Invalid format. Try: 3'7\" or 37");
      return;
    }
    setCalibDistError("");
    const pixelsPerUnit = pixelDist / dist;
    const data = { pixelsPerUnit, unit: calibUnit, pixelDistance: pixelDist, realDistance: dist, calibratedAt: new Date().toISOString() };
    try { localStorage.setItem(`navigator-scale-${meta.filename}`, JSON.stringify(data)); } catch {}
    setCalibSaved(data);
    showToast("Scale calibrated successfully");
    setCalibMode(false);
    setCalibPts([]);
    setModal(null);
    setCurrentTool(prevToolRef.current);
  }, [calibDist, calibUnit, meta.filename]); // showToast is stable ([] deps)

  const handleCalibClick = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setCalibPts((pts) => {
      if (pts.length >= 2) return pts;
      const next = [...pts, { x, y }];
      if (next.length === 2) {
        const dx = next[1].x - next[0].x;
        const dy = next[1].y - next[0].y;
        const pixelDist = Math.sqrt(dx * dx + dy * dy);
        setTimeout(() => setModal({ type: "calibrate", pixelDist }), 50);
      }
      return next;
    });
  }, []);

  // ── Toast helper ───────────────────────────────────────────────────────────

  const showToast = useCallback((msg) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, msg, fading: false }]);
    setTimeout(() => {
      setToasts((prev) => prev.map((t) => t.id === id ? { ...t, fading: true } : t));
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 160);
    }, 2500);
  }, []);

  // ── Save / Export helpers ──────────────────────────────────────────────────

  const saveProjectJson = useCallback((customName) => {
    const date  = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const base  = customName?.trim() || `footprint-${meta.filename.replace(/\.pdf$/i, "")}-${date}`;
    const sheetLabels = (() => { try { return JSON.parse(localStorage.getItem(`sheet-labels-${meta.filename}`) || "{}"); } catch { return {}; } })();
    const data  = { filename: meta.filename, pageCount: numPages || meta.pages, pageTexts, chatHistory: chatMessages, sheetLabels, docSummary, exportedAt: new Date().toISOString() };
    const blob  = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement("a");
    a.href = url; a.download = `${base}.json`; a.click();
    URL.revokeObjectURL(url);
  }, [meta, numPages, pageTexts, chatMessages, docSummary]);

  const exportChatHistory = useCallback(() => {
    if (!chatMessages.length) { showToast("No chat history to export"); return; }
    const lines = chatMessages
      .map((m) => (m.role === "user" ? "User: " : "Navigator: ") + (m.content ?? m.text ?? ""))
      .join("\n\n");
    const blob = new Blob([lines], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `chat-${meta.filename}-${new Date().toISOString().slice(0, 10)}.txt`; a.click();
    URL.revokeObjectURL(url);
  }, [chatMessages, meta.filename, showToast]);

  // ── Menu/Toolbar Actions ───────────────────────────────────────────────────

  const handleAction = useCallback(async (action) => {
    setOpenMenu(null);
    if (!action) return;

    // File
    if      (action === "open")             fileInputRef.current?.click();
    else if (action === "closeDoc")         onNewFile();
    else if (action === "saveProject")      saveProjectJson();
    else if (action === "saveProjectAs")  { setSaveAsName(meta.filename.replace(/\.pdf$/i, "")); setModal({ type: "saveAs" }); }
    else if (action === "exportChat")       exportChatHistory();
    else if (action === "print")            window.print();
    else if (action === "recentDocuments")  showToast("Recent Documents — Coming Soon");

    // Edit
    else if (action === "undo")           goBackView();
    else if (action === "redo")           goForwardView();
    else if (action === "find")         { setActivePanelTab("search"); setPanelOpen(true); }
    else if (action === "selectAll")    { if (currentTool === "text") document.execCommand("selectAll"); }
    else if (action === "cut")            showToast("Cut — Coming Soon");
    else if (action === "copy")           showToast("Copy — Coming Soon");
    else if (action === "paste")          showToast("Paste — Coming Soon");
    else if (action === "preferences")  { setChatOpen(true); setSettingsOpen(true); }

    // View
    else if (action === "viewSingle")     setViewMode("single");
    else if (action === "viewSplitV")     setViewMode("splitV");
    else if (action === "viewSplitH")     setViewMode("splitH");
    else if (action === "fitWidth")     { const s = await calcFitWidthScale(pdfDoc, pageNum); setScale(s); }
    else if (action === "fitPage")      { const s = await calcFitPageScale(pdfDoc, pageNum);  setScale(s); }
    else if (action === "actualSize")     setScale(1.0);
    else if (action === "zoomIn")         setScale((s) => s === null ? s : Math.min(5,   parseFloat((s * 1.1).toFixed(3))));
    else if (action === "zoomOut")        setScale((s) => s === null ? s : Math.max(0.1, parseFloat((s / 1.1).toFixed(3))));
    else if (action === "toggleChat")     setChatOpen((c) => !c);
    else if (action === "fullscreen")   { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.(); }

    // Document
    else if (action === "docProperties")   setModal({ type: "docProps" });
    else if (action === "ocrDocument")     showToast("OCR — Coming Soon");
    else if (action === "reindex")         showToast("Re-indexing — reload the document to refresh the text index");
    else if (action === "cs-rotatepages")  showToast("Rotate Pages — Coming Soon");
    else if (action === "cs-extractpages") showToast("Extract Pages — Coming Soon");
    else if (action === "cs-scalecal") {
      prevToolRef.current = currentTool;
      setCalibMode(true);
      setCalibPts([]);
      setCalibDist("");
    }
    else if (action === "cs-pagesetup")    showToast("Page Setup — Coming Soon");

    // Tools
    else if (action === "tool-select")   setCurrentTool("select");
    else if (action === "tool-pan")      setCurrentTool("pan");
    else if (action === "tool-text")     setCurrentTool("text");
    else if (action === "tool-zoom")     setCurrentTool("zoom");
    else if (action === "tool-length")     { setCurrentTool("length");     setMeasureTool("length");     setMeasurePoints([]); }
    else if (action === "tool-polylength") { setCurrentTool("polylength"); setMeasureTool("polylength"); setMeasurePoints([]); }
    else if (action === "tool-area")       { setCurrentTool("area");       setMeasureTool("area");       setMeasurePoints([]); }
    else if (action === "tool-perimeter")  { setCurrentTool("perimeter");  setMeasureTool("perimeter");  setMeasurePoints([]); }
    else if (action === "tool-angle")      { setCurrentTool("angle");      setMeasureTool("angle");      setMeasurePoints([]); }
    else if (action === "tool-count")      { setCurrentTool("count");      setMeasureTool("count");      setMeasurePoints([]); }
    else if (action === "cs-diameter")     showToast("Diameter — Coming Soon");
    else if (action === "cs-centerradius") showToast("Center Radius — Coming Soon");
    else if (action === "cs-3ptradius")    showToast("3-Point Radius — Coming Soon");
    else if (action === "cs-volume")       showToast("Volume — Coming Soon");
    else if (action === "cs-polygoncutout") showToast("Polygon Cutout — Coming Soon");
    else if (action === "cs-ellipsecutout") showToast("Ellipse Cutout — Coming Soon");
    else if (action === "cs-dynamicfill")  showToast("Dynamic Fill — Coming Soon");
    else if (action === "cs-annotate")   showToast("Markup Tools — Coming Soon");
    else if (action === "cs-highlight")  showToast("Highlight Tool — Coming Soon");
    else if (action === "cs-note")       showToast("Notes — Coming Soon");

    // Window
    else if (action === "cs-bookmarks")   showToast("Bookmarks — Coming Soon");
    else if (action === "cs-layers")      showToast("Layers — Coming Soon");
    else if (action === "resetWorkspace") {
      setActivePanelTab("thumbnails"); setPanelOpen(true);
      setChatOpen(false); setViewMode("single"); setCurrentTool("pan");
      const s = await calcFitWidthScale(pdfDoc, pageNum); setScale(s);
    }

    // Help
    else if (action === "keyboardShortcuts") setModal({ type: "shortcuts" });
    else if (action === "about")             setModal({ type: "about" });
    else if (action === "sendFeedback")      window.open("mailto:info@footprintrobotics.com");
    else if (action === "checkUpdates")      showToast("You are on the latest version (1.0.0 Beta)");

    // Panel toggle (rail + legacy actions)
    else if (action?.startsWith("panel-")) {
      const tab = action.replace("panel-", "");
      if (activePanelTab === tab && panelOpen) setPanelOpen(false);
      else { setActivePanelTab(tab); setPanelOpen(true); }
    }
  }, [
    pdfDoc, pageNum, activePanelTab, panelOpen, currentTool, meta,
    numPages, pageTexts, chatMessages, docSummary,
    calcFitWidthScale, calcFitPageScale, onNewFile,
    goBackView, goForwardView, showToast, saveProjectJson, exportChatHistory,
  ]);

  const jumpToPage = useCallback((n) => {
    const p = Math.max(1, Math.min(numPages || meta.pages, n));
    setPageNum(p);
    document.getElementById(`thumb-${p}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [numPages, meta.pages]);

  const runSearch = (e) => {
    if (e) e.preventDefault();
    setSearchQuery(searchInput.trim());
    if (activePanelTab !== "search") { setActivePanelTab("search"); setPanelOpen(true); }
  };

  const commitPageInput = () => {
    const n = parseInt(pageInputVal, 10);
    if (!Number.isNaN(n)) jumpToPage(n);
    else setPageInputVal(String(pageNum));
  };

  // ── Chat Logic ─────────────────────────────────────────────────────────────

  // Persist chat to localStorage
  useEffect(() => {
    try { localStorage.setItem(`chat:${meta.filename}`, JSON.stringify(chatMessages)); }
    catch {}
  }, [chatMessages, meta.filename]);

  // Auto-scroll to newest message
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // ── Document Summary ───────────────────────────────────────────────────────

  const generateSummary = useCallback(async (force = false) => {
    const storageKey = `navigator-summary-${meta.filename}`;
    if (!force) {
      try {
        const cached = localStorage.getItem(storageKey);
        if (cached) {
          setDocSummary(JSON.parse(cached));
          setSummaryStatus("ready");
          setSummaryAnalyzedAt(localStorage.getItem(`navigator-summary-at-${meta.filename}`) || new Date().toISOString());
          console.log("[Summary] loaded from cache");
          return;
        }
      } catch {}
    }
    setSummaryStatus("loading");
    const totalPages = pageTexts?.length || 0;
    const seenPages  = new Set([1, 2, 3]);
    const samplePages = [1, 2, 3]
      .filter((n) => n <= totalPages)
      .map((n) => ({ page: n, text: pageTexts[n - 1] || "", title: pageTitles?.[n - 1] || undefined, sheet: pageSheets?.[n - 1] || undefined }));
    for (let p = 8; p <= totalPages && samplePages.length < 20; p += 8) {
      if (!seenPages.has(p)) {
        seenPages.add(p);
        samplePages.push({ page: p, text: pageTexts[p - 1] || "", title: pageTitles?.[p - 1] || undefined, sheet: pageSheets?.[p - 1] || undefined });
      }
    }
    console.log(`[Summary] generating with ${samplePages.length} pages`);
    try {
      const resp = await fetch("/pdf-api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageTexts: samplePages }),
        signal: AbortSignal.timeout(60000),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || `Server error ${resp.status}`);
      const { summary } = data;
      const ts = new Date().toISOString();
      setDocSummary(summary);
      setSummaryStatus("ready");
      setSummaryAnalyzedAt(ts);
      try {
        localStorage.setItem(storageKey, JSON.stringify(summary));
        localStorage.setItem(`navigator-summary-at-${meta.filename}`, ts);
      } catch {}
      console.log("[Summary] generated — project:", summary.project_name);
    } catch (err) {
      console.error("[Summary] failed:", err?.message);
      setSummaryStatus("error");
    }
  }, [meta.filename, pageTexts, pageTitles, pageSheets]);

  // Clear session memory + usage stats on mount, then generate summary
  useEffect(() => {
    _sessionMemory.length = 0;
    _usageStats.geminiCalls = 0; _usageStats.fromMemory = 0;
    _usageStats.fromKeywords = 0; _usageStats.fromSummary = 0;
    generateSummary(false);
  }, []); // eslint-disable-line

  const sendChat = useCallback(async (e) => {
    if (e) e.preventDefault();
    const q = chatInput.trim();
    if (!q) return;
    setChatInput("");
    setChatOpen(true);
    setChatMessages((prev) => [...prev, { role: "user", text: q }]);

    // ── Pre-classification: answer metadata questions instantly, no AI ─────────
    const ql = q.toLowerCase();
    const isPageCount = /how many pages|page count|total pages|how long is|how big is/.test(ql);
    const isCurrentPg = /what page am i on|current page|where am i/.test(ql);
    const isFileInfo  = /what file is this|what document is this|what is the filename/.test(ql);
    const navMatch    = ql.match(/(?:go to|jump to|show) page (\d+)/);

    if (isPageCount) {
      console.log("[Navigator] pre-classification: PAGE_COUNT");
      setChatMessages((prev) => [...prev, { role: "navigator", text: `This document has ${numPages || meta.pages} pages.`, results: [] }]);
      return;
    }
    if (isCurrentPg) {
      console.log("[Navigator] pre-classification: CURRENT_PAGE");
      setChatMessages((prev) => [...prev, { role: "navigator", text: `You are on page ${pageNum} of ${numPages || meta.pages}.`, results: [] }]);
      return;
    }
    if (isFileInfo) {
      console.log("[Navigator] pre-classification: FILE_INFO");
      setChatMessages((prev) => [...prev, { role: "navigator", text: `The current document is "${meta.filename}".`, results: [] }]);
      return;
    }
    if (navMatch) {
      const n = parseInt(navMatch[1], 10);
      const target = Math.max(1, Math.min(numPages || meta.pages, n));
      console.log("[Navigator] pre-classification: NAV_COMMAND →", target);
      jumpToPage(target);
      setChatMessages((prev) => [...prev, { role: "navigator", text: `Navigating to page ${target}.`, results: [] }]);
      return;
    }

    // ── META classification: answer app-knowledge questions instantly ──────────
    const metaAnswer = classifyMeta(q);
    if (metaAnswer) {
      console.log("[Navigator] pre-classification: META");
      setChatMessages((prev) => [...prev, { role: "navigator", text: metaAnswer, results: [], isMeta: true }]);
      return;
    }

    // ── Session memory check ───────────────────────────────────────────────────
    const memHit = _findInMemory(q);
    if (memHit) {
      const { entry, match: memMatch } = memHit;
      console.log(`[Navigator] memory hit (${memMatch}):`, entry.question.slice(0, 60));
      const memoryNote = memMatch === "exact" ? "(from memory)" : "Similar question answered above — (from memory)";
      _usageStats.fromMemory++;
      setUsageStats((s) => ({ ...s, fromMemory: s.fromMemory + 1 }));
      setChatMessages((prev) => [...prev, {
        role: "navigator", text: entry.answer, results: [], fromMemory: true, memoryNote,
      }]);
      return;
    }

    // Sheet number pattern: A3.10, P2.01, S-101, M1.00, A101, etc.
    const sheetMatch = q.match(/^([A-Za-z]{1,3}[-.]?\d{1,2}[-.]\d{2,3}|[A-Za-z]\d{3})$/);
    if (sheetMatch) {
      const sheet = sheetMatch[1].toUpperCase();
      const idx = pageTexts?.findIndex((pt) => pt && pt.toUpperCase().includes(sheet));
      if (idx >= 0) {
        jumpToPage(idx + 1);
        setChatMessages((prev) => [...prev,
          { role: "navigator", text: `Navigating to sheet ${sheet}.`, results: [] }]);
      } else {
        setChatMessages((prev) => [...prev,
          { role: "navigator", text: `Sheet ${sheet} not found in this document.`, results: [] }]);
      }
      return;
    }

    // Keyword search
    const allResults = buildSearchResults(pageTexts, q);
    const topResults = allResults.slice(0, 5);
    console.log(`[Navigator] keyword results for "${q}":`, allResults.length);

    // High-confidence: keyword threshold met → return results only, no AI
    if (allResults.length >= keywordThreshold) {
      _usageStats.fromKeywords++;
      setUsageStats((s) => ({ ...s, fromKeywords: s.fromKeywords + 1 }));
      console.log("[Navigator] high-confidence keyword match — skipping Gemini");
      setChatMessages((prev) => [...prev, {
        role: "navigator",
        text: `Found ${allResults.length} result${allResults.length !== 1 ? "s" : ""} for "${q}".`,
        results: topResults,
      }]);
      return;
    }

    // 0–2 matches → always escalate to Gemini (never show "no results")
    // Check cache first
    const cacheKey = `gemini-cache:${q.toLowerCase().trim()}`;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const { answer, results } = JSON.parse(cached);
        console.log("[Navigator] returning cached Gemini answer");
        setChatMessages((prev) => [...prev, {
          role: "navigator",
          text: answer,
          results: results || topResults,
          aiAnswer: true,
        }]);
        return;
      }
    } catch {}

    // Show thinking state with progressive messages
    thinkingTimersRef.current.forEach(clearTimeout);
    thinkingTimersRef.current = [];
    setThinkingText("Navigator is thinking…");
    setChatMessages((prev) => [...prev, { role: "navigator", thinking: true, text: null, results: [] }]);
    thinkingTimersRef.current = [
      setTimeout(() => setThinkingText("Still working on it…"),        4000),
      setTimeout(() => setThinkingText("Taking longer than usual…"),   8000),
    ];

    // Build context with title + sheet metadata
    const makeContextPage = (n) => ({
      page: n,
      text: pageTexts[n - 1] || "",
      title: pageTitles?.[n - 1] || undefined,
      sheet: pageSheets?.[n - 1] || undefined,
    });

    const MAX_CONTEXT  = 15;
    const totalPages   = pageTexts?.length || 0;
    let   summaryCtx   = docSummary ? _summaryToText(docSummary) : undefined;
    if (contextFiles.length > 0) {
      const fileCtx = contextFiles.map((f) => `[File: ${f.name}]\n${f.text.slice(0, 3000)}`).join("\n\n");
      summaryCtx = summaryCtx ? `${summaryCtx}\n\nAdditional project context:\n${fileCtx}` : fileCtx;
    }
    const usedSummary = !!summaryCtx;

    const BROAD_RE     = /tell me about|describe|overview|summarize|what buildings|how many|list all|what types|what is this|what'?s in/i;
    const isBroadQuery = BROAD_RE.test(q);

    let contextPages;
    let contextStrategy;

    if (topResults.length > 0) {
      // Keyword hits — use matched pages; with summary we can trim to top 3
      const seenPages = new Set();
      const matchedPages = topResults
        .filter((r) => { if (seenPages.has(r.page)) return false; seenPages.add(r.page); return true; })
        .slice(0, 3)
        .map((r) => makeContextPage(r.page));
      if (!summaryCtx && matchedPages.length < 3) {
        const extra = (pageTexts || [])
          .slice(0, 5)
          .map((_, i) => makeContextPage(i + 1))
          .filter((p) => !seenPages.has(p.page));
        contextPages = [...matchedPages, ...extra].slice(0, MAX_CONTEXT);
      } else {
        contextPages = matchedPages;
      }
      contextStrategy = summaryCtx ? "keyword-match+summary" : "keyword-match";
    } else if (isBroadQuery) {
      if (summaryCtx) {
        // Summary alone covers broad questions — zero extra pages
        contextPages     = [];
        contextStrategy  = "summary-only (broad)";
      } else {
        // No summary — sample every 5th page across the document
        const seenPages = new Set([1, 2, 3]);
        const sampled   = [1, 2, 3].map(makeContextPage);
        for (let p = 5; p <= totalPages && sampled.length < MAX_CONTEXT; p += 5) {
          if (!seenPages.has(p)) { seenPages.add(p); sampled.push(makeContextPage(p)); }
        }
        contextPages    = sampled;
        contextStrategy = "broad-sample (every 5th page)";
      }
    } else {
      // Default: first few pages + summary if available
      const count     = summaryCtx ? 3 : 5;
      contextPages    = (pageTexts || []).slice(0, count).map((_, i) => makeContextPage(i + 1));
      contextStrategy = summaryCtx ? "summary+first-3-pages" : "first-5-pages";
    }

    console.log(`[Navigator] Gemini strategy: ${contextStrategy} — ${contextPages.length} pages:`, contextPages.map((p) => p.page));

    // Build conversation history for the AI — completed turns only, last 10 messages
    const history = chatMessages
      .filter((m) => !m.thinking && (m.role === "user" || (m.role === "navigator" && m.text)))
      .slice(-10)
      .map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text,
      }));

    try {
      const resp = await fetch("/pdf-api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q, pageTexts: contextPages, summaryContext: summaryCtx,
          history,
          customPrompt: customPrompt || undefined, responseLength,
          mode: navigatorMode,
          customModels: customModelsEnabled ? customModelConfig : undefined,
        }),
        signal: AbortSignal.timeout(30000),
      });

      const data = await resp.json();
      console.log("[Navigator] /pdf-api/chat response:", resp.status, data);

      if (!resp.ok) {
        throw new Error(data?.error || `Server error ${resp.status}`);
      }

      const { answer, model: ansModel, complexity: ansComplexity, latencyMs: ansLatency } = data;

      // Update session cost tracker
      setSessionCost((prev) => {
        const next = prev + (data.estimatedCostUSD || 0);
        try { sessionStorage.setItem("navigator-session-cost", String(next)); } catch {}
        return next;
      });
      setSessionAICount((c) => c + 1);

      // Calculate confidence from keyword match count + summary usage
      const ansConfidence =
        (topResults.length >= 3 && usedSummary) ? "high"   :
        (topResults.length >= 1 || usedSummary)  ? "medium" :
        "low";

      // Clear progressive loading timers
      thinkingTimersRef.current.forEach(clearTimeout);
      thinkingTimersRef.current = [];

      // Cache the result
      try { localStorage.setItem(cacheKey, JSON.stringify({ answer, results: topResults })); } catch {}

      // Track usage
      _usageStats.geminiCalls++;
      if (usedSummary) _usageStats.fromSummary++;
      setUsageStats((s) => ({ ...s, geminiCalls: s.geminiCalls + 1, ...(usedSummary && { fromSummary: s.fromSummary + 1 }) }));

      // Store in session memory
      _addToMemory(q, answer, topResults.map((r) => r.page));

      setChatMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.thinking) {
          next[next.length - 1] = {
            role: "navigator", text: answer, results: topResults, aiAnswer: true, usedSummary,
            model: ansModel, complexity: ansComplexity, latencyMs: ansLatency, confidence: ansConfidence,
          };
        }
        return next;
      });
    } catch (err) {
      thinkingTimersRef.current.forEach(clearTimeout);
      thinkingTimersRef.current = [];
      console.error("[Navigator] Gemini call failed:", err?.message ?? err);
      setChatMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.thinking) {
          next[next.length - 1] = {
            role: "navigator",
            text: topResults.length > 0
              ? "Navigator is temporarily unavailable. Showing keyword results instead."
              : "Navigator is temporarily unavailable. Please try again in a moment.",
            results: topResults,
          };
        }
        return next;
      });
    }
  }, [chatInput, pageTexts, jumpToPage, numPages, pageNum, meta, docSummary, keywordThreshold, contextFiles, customPrompt, responseLength, navigatorMode, customModelsEnabled, customModelConfig]);

  const startChatResize = useCallback((e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = chatHeight;
    const onMove = (ev) => setChatHeight(Math.min(400, Math.max(100, startH + (startY - ev.clientY))));
    const onUp   = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [chatHeight]);

  // ── Handler callbacks ──────────────────────────────────────────────────────

  const handleSummaryLinkClick = useCallback(() => {
    setSummaryExpanded(true);
    setSettingsOpen(false);
    if (chatMessagesRef.current) chatMessagesRef.current.scrollTop = 0;
    setDocIntelGlow(true);
    setTimeout(() => setDocIntelGlow(false), 1300);
  }, []);

  const handleSavePrompt = useCallback(() => {
    setCustomPrompt(stgPrompt);
    try { localStorage.setItem("navigator-system-prompt", stgPrompt); } catch {}
  }, [stgPrompt]);

  const handleResetPrompt = useCallback(() => {
    setStgPrompt(""); setCustomPrompt("");
    try { localStorage.removeItem("navigator-system-prompt"); } catch {}
  }, []);

  const handleSaveResponseSettings = useCallback(() => {
    setResponseLength(stgResponseLen);
    setKeywordThreshold(stgThreshold);
    try {
      localStorage.setItem("navigator-response-length", stgResponseLen);
      localStorage.setItem("navigator-keyword-threshold", String(stgThreshold));
    } catch {}
  }, [stgResponseLen, stgThreshold]);

  const handleContextFileAdd = useCallback(async (files) => {
    for (const file of Array.from(files)) {
      if (!file.type.includes("pdf")) continue;
      try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        let text = "";
        for (let p = 1; p <= Math.min(pdf.numPages, 30); p++) {
          const pg = await pdf.getPage(p);
          const ct = await pg.getTextContent();
          text += ct.items.map((i) => i.str).join(" ") + "\n";
        }
        const entry = { name: file.name, text: text.slice(0, 8000), addedAt: new Date().toISOString() };
        setContextFiles((prev) => {
          const next = [...prev.filter((f) => f.name !== file.name), entry];
          try { localStorage.setItem(`navigator-context-files-${meta.filename}`, JSON.stringify(next)); } catch {}
          return next;
        });
      } catch (err) { console.error("[ContextFile] failed:", err?.message); }
    }
  }, [meta.filename]);

  const handleContextFileRemove = useCallback((name) => {
    setContextFiles((prev) => {
      const next = prev.filter((f) => f.name !== name);
      try { localStorage.setItem(`navigator-context-files-${meta.filename}`, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [meta.filename]);

  const handleClearMemory = useCallback(() => {
    if (window.confirm("Clear all session memory? Navigator will not recall previous answers.")) {
      _sessionMemory.length = 0;
      setUsageStats((s) => ({ ...s, fromMemory: 0 }));
    }
  }, []);

  const handleClearChat = useCallback(() => {
    if (window.confirm("Clear all chat history? This cannot be undone.")) {
      setChatMessages([]);
      try { localStorage.removeItem(`chat:${meta.filename}`); } catch {}
      setSessionCost(0);
      setSessionAICount(0);
      try { sessionStorage.removeItem("navigator-session-cost"); } catch {}
    }
  }, [meta.filename]);

  const scaleDisplay = scale !== null ? Math.round(scale * 100) : "";
  const cursor = calibMode ? "crosshair" : (TOOL_CURSOR[currentTool] || "default");

  const getMenuItemCheck = (action) => {
    if (action === "viewSingle")       return viewMode === "single";
    if (action === "viewSplitV")       return viewMode === "splitV";
    if (action === "viewSplitH")       return viewMode === "splitH";
    if (action === "panel-thumbnails") return activePanelTab === "thumbnails" && panelOpen;
    if (action === "panel-search")     return activePanelTab === "search"     && panelOpen;
    if (action === "toggleChat")       return chatOpen;
    if (action === "tool-select")      return currentTool === "select";
    if (action === "tool-pan")         return currentTool === "pan";
    if (action === "tool-text")        return currentTool === "text";
    if (action === "tool-zoom")        return currentTool === "zoom";
    return false;
  };

  // ── Measurement canvas draw + click handlers ──────────────────────────────

  const drawMeasureCanvas = useCallback((overrideMousePos) => {
    const canvas = measureCanvasRef.current;
    const pdfCanvas = canvasRef.current;
    if (!canvas || !pdfCanvas) return;
    const w = parseFloat(pdfCanvas.style.width)  || pdfCanvas.offsetWidth  || 800;
    const h = parseFloat(pdfCanvas.style.height) || pdfCanvas.offsetHeight || 600;
    // Only resize if needed to avoid clearing during rapid mousemove
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    measurements
      .filter((m) => m.page == null || m.page === pageNum)
      .forEach((m) => mDrawMeasurement(ctx, m, calibSaved));
    const pts  = measurePointsRef.current;
    const tool = currentToolRef.current;
    const mp   = overrideMousePos !== undefined ? overrideMousePos : mousePosRef.current;
    if (MTOOLS.includes(tool)) {
      mDrawInProgress(ctx, pts, tool, pts.length > 0 ? mp : null, calibSaved);
    }
    mDrawSnapIndicator(ctx, snapResultRef.current);
  }, [measurements, calibSaved, pageNum]);

  useEffect(() => { drawMeasureCanvas(); }, [drawMeasureCanvas, measurePoints, currentTool]);

  const handleMeasureClick = useCallback((e) => {
    if (e.detail > 1) return; // skip — this click is part of a dblclick
    const rect = e.currentTarget.getBoundingClientRect();
    const raw  = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const snap = snapResultRef.current;
    const pt   = (snap?.snapped && snapEnabledRef.current) ? { x: snap.x, y: snap.y } : raw;
    const tool = currentToolRef.current;
    if (tool === "count") {
      setMeasurements((ms) => [...ms, { id: Date.now(), page: pageNum, type: "count", points: [pt] }]);
      return;
    }
    setMeasurePoints((prev) => {
      const pts = [...prev, pt];
      if (tool === "length" && pts.length === 2) {
        setMeasurements((ms) => [...ms, { id: Date.now(), page: pageNum, type: "length", points: pts }]);
        return [];
      }
      if (tool === "angle" && pts.length === 3) {
        setMeasurements((ms) => [...ms, { id: Date.now(), page: pageNum, type: "angle", points: pts }]);
        return [];
      }
      return pts;
    });
  }, [pageNum]);

  const handleMeasureMouseMove = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    let pos = raw;
    if (snapEnabledRef.current && snapGridRef.current && MTOOLS.includes(currentToolRef.current)) {
      const threshold = snapStrengthToThreshold(snapSettingsRef.current.strength);
      const result    = snapToContent(raw.x, raw.y, snapGridRef.current, snapSettingsRef.current, threshold);
      snapResultRef.current = result;
      if (result) pos = { x: result.x, y: result.y };
    } else {
      snapResultRef.current = null;
    }
    mousePosRef.current = pos;
    if (MTOOLS.includes(currentToolRef.current)) drawMeasureCanvas(pos);
  }, [drawMeasureCanvas]);

  const handleMeasureDblClick = useCallback((e) => {
    e.preventDefault();
    const tool = currentToolRef.current;
    if (!["polylength", "area", "perimeter"].includes(tool)) return;
    const pts = measurePointsRef.current;
    const minPts = tool === "polylength" ? 2 : 3;
    if (pts.length < minPts) {
      showToast(`${tool === "area" ? "Area" : tool === "perimeter" ? "Perimeter" : "Polylength"} requires at least ${minPts} points`);
      return;
    }
    setMeasurements((ms) => [...ms, { id: Date.now(), page: pageNum, type: tool, points: [...pts] }]);
    setMeasurePoints([]);
  }, [pageNum]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="ws-root">
      {/* ── Menu Bar ── */}
      <div className="ws-menubar" ref={menuBarRef}>
        {MENUS.map((menu) => (
          <div key={menu.id} className="ws-menu-wrap">
            <button
              className={`ws-menu-btn ${openMenu === menu.id ? "open" : ""}`}
              onClick={() => { setOpenMenu(openMenu === menu.id ? null : menu.id); setOpenSubmenu(null); }}
            >
              {menu.label}
            </button>
            {openMenu === menu.id && (
              <div className="ws-dropdown">
                {menu.items.map((item, i) =>
                  item === "sep" ? (
                    <div key={i} className="ws-dropdown-sep" />
                  ) : item.submenu ? (
                    <div
                      key={i}
                      className="ws-submenu-wrap"
                      onMouseEnter={() => setOpenSubmenu(item.label)}
                      onMouseLeave={() => setOpenSubmenu(null)}
                    >
                      <button className="ws-dropdown-item ws-dropdown-item--submenu">
                        <span className="ws-dropdown-check" />
                        <span className="ws-dropdown-label">{item.label}</span>
                        <span className="ws-dropdown-arrow">›</span>
                      </button>
                      {openSubmenu === item.label && (
                        <div className="ws-submenu">
                          {item.submenu.map((sub, j) =>
                            sub === "sep" ? (
                              <div key={j} className="ws-dropdown-sep" />
                            ) : (
                              <button
                                key={j}
                                className={`ws-dropdown-item${sub.cs ? " ws-dropdown-item--cs" : ""}${getMenuItemCheck(sub.action) ? " ws-dropdown-item--checked" : ""}`}
                                onClick={() => { handleAction(sub.action); setOpenMenu(null); setOpenSubmenu(null); }}
                              >
                                <span className="ws-dropdown-check">{getMenuItemCheck(sub.action) ? "✓" : ""}</span>
                                <span className="ws-dropdown-label">{sub.label}</span>
                                <span className="ws-dropdown-note">
                                  {sub.cs ? <span className="ws-cs-badge">Soon</span> : (sub.note || "")}
                                </span>
                              </button>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <button
                      key={i}
                      className={`ws-dropdown-item${getMenuItemCheck(item.action) ? " ws-dropdown-item--checked" : ""}`}
                      onClick={() => handleAction(item.action)}
                    >
                      <span className="ws-dropdown-check">{getMenuItemCheck(item.action) ? "✓" : ""}</span>
                      <span className="ws-dropdown-label">{item.label}</span>
                      {item.note && <span className="ws-dropdown-note">{item.note}</span>}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <input ref={fileInputRef} type="file" accept="application/pdf" hidden onChange={(e) => { if (e.target.files?.[0]) onNewFile(); }} />

      {/* ── Tab Bar ── */}
      <div className="ws-tabbar">
        <div className="ws-tab active">
          <span className="ws-tab-name" title={meta.filename}>{meta.filename}</span>
          <button className="ws-tab-close" onClick={onNewFile} title="Close document">×</button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="ws-body">
        {/* Collapsible left bar (rail + panel) */}
        <div className={`ws-left-bar ${leftOpen ? "ws-left-bar--open" : "ws-left-bar--closed"}`}>
          {/* Tool Rail */}
          <div className="ws-toolrail">
            {RAIL_TABS.map((tab) => (
              <button
                key={tab.id}
                className={`ws-rail-btn ${activePanelTab === tab.id && panelOpen ? "active" : ""}`}
                title={tab.tooltip}
                onClick={() => {
                  if (activePanelTab === tab.id && panelOpen) setPanelOpen(false);
                  else { setActivePanelTab(tab.id); setPanelOpen(true); }
                }}
              >
                {tab.icon}
              </button>
            ))}
          </div>

          {/* Navigation Panel */}
          {panelOpen && (
            <div className="ws-panel">
              <div className="ws-panel-header">
                <span className="ws-panel-title">
                  {RAIL_TABS.find((t) => t.id === activePanelTab)?.tooltip}
                </span>
                <button className="ws-panel-close" onClick={() => setPanelOpen(false)} title="Close panel">×</button>
              </div>
              <div className="ws-panel-body">
                {activePanelTab === "thumbnails" && pdfDoc && (
                  <ThumbnailList
                    pdfDoc={pdfDoc}
                    numPages={numPages || meta.pages}
                    currentPage={pageNum}
                    onSelect={jumpToPage}
                    filename={meta.filename}
                  />
                )}
                {activePanelTab === "search" && (
                  <SearchPanel
                    searchInput={searchInput}
                    setSearchInput={setSearchInput}
                    searchQuery={searchQuery}
                    runSearch={runSearch}
                    searchResults={searchResults}
                    jumpToPage={jumpToPage}
                  />
                )}
                {activePanelTab !== "thumbnails" && activePanelTab !== "search" && (
                  <div className="ws-panel-empty">
                    <p className="ws-panel-empty-title">
                      {RAIL_TABS.find((t) => t.id === activePanelTab)?.tooltip}
                    </p>
                    <p className="ws-panel-empty-hint">No content available</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Left bar collapse/expand toggle */}
        <button
          className="ws-left-toggle"
          onClick={() => setLeftOpen((v) => !v)}
          title={leftOpen ? "Collapse left panel" : "Expand left panel"}
          aria-label={leftOpen ? "Collapse left panel" : "Expand left panel"}
        >
          {leftOpen ? "‹" : "›"}
        </button>

        {/* Canvas Column */}
        <div className="ws-canvas-col">
          {calibMode && (
            <div className="ws-calib-banner">
              <span>
                {calibPts.length === 0
                  ? "⊕ Scale Calibration: Click the first point on the drawing"
                  : "⊕ Scale Calibration: Click the second point on the drawing"}
              </span>
              <button className="ws-calib-cancel" onClick={cancelCalib}>Cancel (Esc)</button>
            </div>
          )}
          {isOcring && (
            <div className="ws-ocr-bar">
              <div className="ws-ocr-spinner" />
              <span>Scanned document detected — running OCR…</span>
              {ocrProgress.total > 0 && (
                <span className="ws-ocr-page">
                  Page {ocrProgress.page} / {ocrProgress.total}
                </span>
              )}
            </div>
          )}

          {viewMode === "single" ? (
            <div
              className="ws-doc-canvas"
              style={{ cursor: cursor === "grab" ? "grab" : cursor }}
              ref={canvasWrapRef}
            >
              <div className="ws-canvas-inner">
                <div className="ws-page-frame">
                  <canvas ref={canvasRef} className={isRendering ? "rendering" : ""} />
                  <div
                    ref={textLayerRef}
                    className="ws-text-layer"
                    style={{ pointerEvents: currentTool === "text" ? "auto" : "none" }}
                  />
                  <canvas ref={calibCanvasRef} className="ws-calib-canvas" />
                  {calibMode && <div className="ws-calib-hit" onClick={handleCalibClick} />}
                  <canvas ref={measureCanvasRef} className="ws-measure-canvas" />
                  {MTOOLS.includes(currentTool) && (
                    <div className="ws-measure-hit"
                      onClick={handleMeasureClick}
                      onDoubleClick={handleMeasureDblClick}
                      onMouseMove={handleMeasureMouseMove}
                    />
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className={`ws-split-wrap ${viewMode === "splitV" ? "ws-split-wrap--v" : "ws-split-wrap--h"}`}>
              {/* Panel 1 — primary (uses main canvas + canvasWrapRef) */}
              <div className="ws-split-panel">
                <div
                  className="ws-doc-canvas"
                  style={{ cursor: cursor === "grab" ? "grab" : cursor }}
                  ref={canvasWrapRef}
                >
                  <div className="ws-canvas-inner">
                    <div className="ws-page-frame">
                      <canvas ref={canvasRef} className={isRendering ? "rendering" : ""} />
                      <div
                        ref={textLayerRef}
                        className="ws-text-layer"
                        style={{ pointerEvents: currentTool === "text" ? "auto" : "none" }}
                      />
                      <canvas ref={calibCanvasRef} className="ws-calib-canvas" />
                      {calibMode && <div className="ws-calib-hit" onClick={handleCalibClick} />}
                      <canvas ref={measureCanvasRef} className="ws-measure-canvas" />
                      {MTOOLS.includes(currentTool) && (
                        <div className="ws-measure-hit"
                          onClick={handleMeasureClick}
                          onDoubleClick={handleMeasureDblClick}
                          onMouseMove={handleMeasureMouseMove}
                        />
                      )}
                    </div>
                  </div>
                </div>
                <div className="ws-split-nav">
                  <button className="ws-tbtn" onClick={() => jumpToPage(1)} disabled={pageNum <= 1} title="First">|◄</button>
                  <button className="ws-tbtn" onClick={() => jumpToPage(pageNum - 1)} disabled={pageNum <= 1} title="Prev">◄</button>
                  <span className="ws-tlabel">{pageNum} of {numPages || meta.pages}</span>
                  <button className="ws-tbtn" onClick={() => jumpToPage(pageNum + 1)} disabled={pageNum >= (numPages || meta.pages)} title="Next">►</button>
                  <button className="ws-tbtn" onClick={() => jumpToPage(numPages || meta.pages)} disabled={pageNum >= (numPages || meta.pages)} title="Last">►|</button>
                </div>
              </div>
              {/* Panel 2 — independent */}
              {pdfDoc && <SplitPanel pdfDoc={pdfDoc} numPages={numPages || meta.pages} />}
            </div>
          )}
        </div>
      </div>

      {/* ── Chat Panel ── */}
      {chatOpen && (
        <div className="ws-chat-panel" style={{ height: chatHeight }}>
          <div className="ws-chat-drag" onMouseDown={startChatResize} title="Drag to resize" />

          {settingsOpen ? (
            /* ── Settings Panel ───────────────────────────────────────── */
            <div className="ws-settings-panel">
              <div className="ws-settings-header">
                <button className="ws-settings-back" onClick={() => setSettingsOpen(false)} title="Back to chat">←</button>
                <span className="ws-settings-title">Navigator Settings</span>
              </div>
              <div className="ws-settings-body">

                {/* ── Left column ── */}
                <div className="ws-settings-col">

                  {/* S0: AI Model */}
                  <div className="ws-settings-section">
                    <div className="ws-settings-section-title">AI Model</div>
                    <div className="ws-mode-cards">
                      {[
                        { id: "free",     label: "Free",         badge: "Free",        badgeCls: "free",     desc: "All questions answered by Groq. Zero API cost.", models: "All questions: Groq 70B" },
                        { id: "balanced", label: "Balanced",     badge: "Recommended", badgeCls: "balanced", desc: "Groq for simple, Claude for harder questions. Best value.", models: "Simple: Groq 70B · Moderate: Claude Haiku · Complex: Claude Sonnet" },
                        { id: "best",     label: "Best Quality", badge: "Premium",     badgeCls: "best",     desc: "Premium models for every question. Highest accuracy.", models: "Simple: Claude Haiku · Moderate: Claude Sonnet · Complex: GPT-4o" },
                      ].map(({ id, label, badge, badgeCls, desc, models }) => (
                        <div
                          key={id}
                          className={`ws-mode-card${navigatorMode === id ? " ws-mode-card--active" : ""}`}
                          onClick={() => { setNavigatorMode(id); try { localStorage.setItem("navigator-mode", id); } catch {} }}
                        >
                          <span className={`ws-mode-badge ws-mode-badge--${badgeCls}`}>{badge}</span>
                          <span className="ws-mode-card-label">{label}</span>
                          <span className="ws-mode-card-desc">{desc}</span>
                          <span className="ws-mode-card-models">{models}</span>
                        </div>
                      ))}
                    </div>
                    <label className="ws-custom-toggle">
                      <input
                        type="checkbox"
                        checked={customModelsEnabled}
                        onChange={(e) => {
                          setCustomModelsEnabled(e.target.checked);
                          try { localStorage.setItem("navigator-custom-enabled", String(e.target.checked)); } catch {}
                        }}
                      />
                      Customize models per tier
                    </label>
                    {customModelsEnabled && (
                      <div className="ws-custom-grids">
                        {[
                          { key: "simple",   label: "Simple",   opts: ["groq-70b", "gemini-flash", "gpt-4o-mini", "claude-haiku"] },
                          { key: "moderate", label: "Moderate", opts: ["groq-70b", "gemini-flash", "gpt-4o-mini", "gpt-4o", "claude-haiku", "claude-sonnet"] },
                          { key: "complex",  label: "Complex",  opts: ["gemini-flash", "gpt-4o-mini", "gpt-4o", "claude-haiku", "claude-sonnet"] },
                        ].map(({ key, label, opts }) => (
                          <div key={key} className="ws-custom-row">
                            <span className="ws-custom-label">{label}</span>
                            <select
                              className="ws-custom-select"
                              value={customModelConfig[key] || opts[0]}
                              onChange={(e) => {
                                const next = { ...customModelConfig, [key]: e.target.value };
                                setCustomModelConfig(next);
                                try { localStorage.setItem("navigator-custom-models", JSON.stringify(next)); } catch {}
                              }}
                            >
                              {opts.map((o) => (
                                <option key={o} value={o}>{MODEL_DISPLAY[o]?.full || o}</option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="ws-cost-tracker">
                      <span className="ws-cost-main">Session cost: ${sessionCost.toFixed(4)}</span>
                      <span className="ws-cost-detail">AI questions answered: {sessionAICount}</span>
                    </div>
                  </div>

                  {/* S1: System Prompt */}
                  <div className="ws-settings-section">
                    <div className="ws-settings-section-title">System Prompt</div>
                    <p className="ws-settings-desc">Edit the instructions Navigator follows when answering questions.</p>
                    <textarea
                      className="ws-settings-textarea"
                      rows={5}
                      placeholder={DEFAULT_SYSTEM_PROMPT}
                      value={stgPrompt}
                      onChange={(e) => setStgPrompt(e.target.value)}
                    />
                    <div className="ws-settings-row">
                      <button className="ws-settings-save" onClick={handleSavePrompt}>Save</button>
                      <button className="ws-settings-reset" onClick={handleResetPrompt}>Reset to Default</button>
                    </div>
                  </div>

                  {/* S2: Response Settings */}
                  <div className="ws-settings-section">
                    <div className="ws-settings-section-title">Response Settings</div>
                    <div className="ws-settings-field">
                      <div className="ws-settings-field-label">Response Length</div>
                      {[
                        { val: "short",    label: "Short (2–3 sentences)" },
                        { val: "medium",   label: "Medium (up to 5 sentences)" },
                        { val: "detailed", label: "Detailed (as thorough as needed)" },
                      ].map(({ val, label }) => (
                        <label key={val} className="ws-settings-radio">
                          <input type="radio" name="navResLen" value={val} checked={stgResponseLen === val} onChange={() => setStgResponseLen(val)} />
                          {label}
                        </label>
                      ))}
                    </div>
                    <div className="ws-settings-field">
                      <div className="ws-settings-field-label">
                        AI Trigger Threshold <span className="ws-settings-field-val">{stgThreshold}</span>
                      </div>
                      <p className="ws-settings-desc">Keyword matches needed before skipping AI. Lower = more AI usage.</p>
                      <input type="range" min={0} max={10} className="ws-settings-slider" value={stgThreshold} onChange={(e) => setStgThreshold(Number(e.target.value))} />
                    </div>
                    <button className="ws-settings-save" style={{ alignSelf: "flex-start" }} onClick={handleSaveResponseSettings}>Save</button>
                  </div>

                  {/* Snap Settings */}
                  <div className="ws-settings-section">
                    <div className="ws-settings-section-title">Snap Settings</div>
                    <p className="ws-settings-desc">Snap cursor to vector lines and endpoints while measuring. Press F3 to toggle quickly.</p>
                    <div className="ws-settings-field">
                      {[
                        { key: "endpoints",    label: "Snap to Endpoints" },
                        { key: "midpoints",    label: "Snap to Midpoints" },
                        { key: "intersections",label: "Snap to Intersections" },
                      ].map(({ key, label }) => (
                        <label key={key} className="ws-settings-toggle-row">
                          <input type="checkbox"
                            checked={snapSettings[key]}
                            onChange={(e) => setSnapSettings((s) => ({ ...s, [key]: e.target.checked }))}
                          />
                          <span>{label}</span>
                        </label>
                      ))}
                    </div>
                    <div className="ws-settings-field">
                      <div className="ws-settings-field-label">
                        Snap Strength <span className="ws-settings-field-val">{snapSettings.strength}</span>
                        <span className="ws-settings-desc" style={{ display: "inline", marginLeft: 6 }}>
                          ({snapStrengthToThreshold(snapSettings.strength).toFixed(1)}px threshold)
                        </span>
                      </div>
                      <input type="range" min={1} max={10} className="ws-settings-slider"
                        value={snapSettings.strength}
                        onChange={(e) => setSnapSettings((s) => ({ ...s, strength: Number(e.target.value) }))}
                      />
                    </div>
                  </div>

                  {/* S5: Memory & History */}
                  <div className="ws-settings-section">
                    <div className="ws-settings-section-title">Memory &amp; History</div>
                    <div className="ws-settings-field">
                      <div className="ws-settings-field-label">Session Memory</div>
                      <p className="ws-settings-desc">{_sessionMemory.length} question{_sessionMemory.length !== 1 ? "s" : ""} remembered this session.</p>
                    </div>
                    <div className="ws-settings-row">
                      <button className="ws-settings-reset" onClick={handleClearMemory}>Clear Session Memory</button>
                      <button className="ws-settings-danger" onClick={handleClearChat}>Clear Chat History</button>
                    </div>
                  </div>

                  {/* S6: Usage Stats */}
                  <div className="ws-settings-section">
                    <div className="ws-settings-section-title">API Usage This Session</div>
                    <div className="ws-settings-stats">
                      {[
                        { label: "Gemini calls made",              val: usageStats.geminiCalls },
                        { label: "Answered from memory",           val: usageStats.fromMemory },
                        { label: "Answered from keywords only",    val: usageStats.fromKeywords },
                        { label: "Answered from document summary", val: usageStats.fromSummary },
                      ].map(({ label, val }) => (
                        <div key={label} className="ws-settings-stat">
                          <span>{label}</span>
                          <span className="ws-settings-stat-val">{val}</span>
                        </div>
                      ))}
                    </div>
                    <p className="ws-settings-stat-note">Free tier limit: ~1,000 requests/day</p>
                  </div>

                </div>{/* /left col */}

                {/* ── Right column ── */}
                <div className="ws-settings-col">

                  {/* S3: Document Intelligence */}
                  <div className="ws-settings-section">
                    <div className="ws-settings-section-title">Document Intelligence</div>
                    {summaryStatus === "loading" && <p className="ws-settings-desc">Analyzing document…</p>}
                    {summaryStatus === "error"   && <p className="ws-settings-desc" style={{ color: "#f88" }}>Analysis failed. Use ↺ to retry.</p>}
                    {summaryStatus === "ready" && docSummary ? (
                      <>
                        {summaryAnalyzedAt && (
                          <p className="ws-settings-summary-ts">Last analyzed: {new Date(summaryAnalyzedAt).toLocaleString()}</p>
                        )}
                        {[
                          { label: "Project",       val: docSummary.project_name },
                          { label: "Address",       val: docSummary.address },
                          { label: "Architect",     val: docSummary.architect },
                          { label: "Building Type", val: typeof docSummary.building_type === "string" ? docSummary.building_type : String(docSummary.building_type || "") },
                        ].filter(({ val }) => val).map(({ label, val }) => (
                          <div key={label} className="ws-settings-summary-field">
                            <span className="ws-settings-summary-label">{label}</span>
                            <span className="ws-settings-summary-value">{val}</span>
                          </div>
                        ))}
                        {docSummary.disciplines?.length > 0 && (
                          <div className="ws-settings-summary-field">
                            <span className="ws-settings-summary-label">Disciplines</span>
                            <div className="ws-doc-intel-pills" style={{ marginTop: 4 }}>
                              {docSummary.disciplines.map((d, di) => (
                                <span key={di} className="ws-doc-intel-pill ws-doc-intel-pill--disc">{d}</span>
                              ))}
                            </div>
                          </div>
                        )}
                        {docSummary.key_facts?.length > 0 && (
                          <div className="ws-settings-summary-field">
                            <span className="ws-settings-summary-label">Key Facts</span>
                            <ol style={{ margin: "4px 0 0 16px", padding: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                              {docSummary.key_facts.map((f, fi) => (
                                <li key={fi} style={{ fontSize: 11, color: "#ccc", lineHeight: 1.4 }}>{f}</li>
                              ))}
                            </ol>
                          </div>
                        )}
                        {docSummary.sheet_list?.length > 0 && (
                          <div className="ws-settings-summary-field">
                            <span className="ws-settings-summary-label">Sheet List</span>
                            <table className="ws-settings-sheet-table">
                              <thead><tr><th>Sheet</th><th>Title</th><th>Pg.</th></tr></thead>
                              <tbody>
                                {docSummary.sheet_list.map((s, si) => (
                                  <tr key={si} className="ws-settings-sheet-row" onClick={() => { jumpToPage(s.page); setSettingsOpen(false); }}>
                                    <td>{s.sheet_number}</td>
                                    <td>{s.title}</td>
                                    <td>{s.page}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        <button className="ws-settings-reset" style={{ alignSelf: "flex-start" }} onClick={() => generateSummary(true)}>↺ Regenerate Analysis</button>
                      </>
                    ) : summaryStatus === "idle" ? (
                      <p className="ws-settings-desc">Load a document to generate intelligence.</p>
                    ) : null}
                  </div>

                  {/* S4: Project Files */}
                  <div className="ws-settings-section">
                    <div className="ws-settings-section-title">Project Files</div>
                    <p className="ws-settings-desc">Upload additional documents (specs, RFIs, submittals) to give Navigator more context.</p>
                    <label
                      className="ws-settings-drop"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => { e.preventDefault(); handleContextFileAdd(e.dataTransfer.files); }}
                    >
                      <input type="file" accept="application/pdf" multiple hidden onChange={(e) => handleContextFileAdd(e.target.files)} />
                      Drop PDFs here or click to browse
                    </label>
                    {contextFiles.length > 0 && (
                      <div className="ws-settings-file-list">
                        {contextFiles.map((f) => (
                          <div key={f.name} className="ws-settings-file-item">
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                            <button className="ws-settings-file-remove" onClick={() => handleContextFileRemove(f.name)} title="Remove">×</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                </div>{/* /right col */}

              </div>
            </div>
          ) : (
            /* ── Normal Chat View ─────────────────────────────────────── */
            <>
              <div className="ws-chat-header">
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span className="ws-chat-title">Navigator</span>
                  <button className="ws-chat-gear" onClick={() => setSettingsOpen(true)} title="Settings">⚙</button>
                </div>
                <button className="ws-chat-close" onClick={() => setChatOpen(false)} title="Close">×</button>
              </div>

              <div className="ws-chat-messages" ref={chatMessagesRef}>
                {!chatBannerDismissed && (
                  <div className="ws-chat-banner">
                    <span className="ws-chat-banner-text">
                      Navigator AI answers are generated from extracted document text and may contain errors.
                      Always verify critical information against the original drawings.
                    </span>
                    <button
                      className="ws-chat-banner-close"
                      onClick={() => { setChatBannerDismissed(true); sessionStorage.setItem("nav-banner-dismissed", "1"); }}
                      title="Dismiss"
                    >×</button>
                  </div>
                )}
                {chatMessages.length === 0 && (
                  <div className="ws-chat-empty">Ask a question or type a sheet number to navigate.</div>
                )}
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`ws-chat-msg ws-chat-msg--${msg.role}`}>
                    <span className={`ws-chat-label${msg.isMeta ? " ws-chat-label--meta" : ""}`}>
                      {msg.role === "user" ? "User:" : "Navigator:"}
                      {msg.isMeta && <span className="ws-chat-meta-badge">app</span>}
                      {msg.aiAnswer && !msg.isMeta && (
                        <span
                          className={`ws-chat-ai-badge${msg.model ? ` ws-chat-ai-badge--${MODEL_DISPLAY[msg.model]?.css || "gemini"}` : ""}`}
                          title={MODEL_DISPLAY[msg.model]?.full || "AI"}
                        >AI</span>
                      )}
                      {msg.fromMemory && <span className="ws-chat-memory-badge">memory</span>}
                    </span>
                    {msg.thinking ? (
                      <span className="ws-chat-thinking">{thinkingText}</span>
                    ) : (
                      <>
                        <span className="ws-chat-text">{msg.text}</span>
                        {msg.aiAnswer && msg.model && (
                          <span className="ws-chat-model-line">
                            {MODEL_DISPLAY[msg.model]?.name || msg.model} · {msg.complexity} · {msg.latencyMs}ms
                          </span>
                        )}
                        {msg.aiAnswer && msg.confidence && (
                          <span className="ws-chat-confidence-line">
                            Confidence: <span className={`ws-chat-confidence-label--${msg.confidence}`}>
                              {msg.confidence.charAt(0).toUpperCase() + msg.confidence.slice(1)} ●
                            </span>
                          </span>
                        )}
                        {msg.aiAnswer && msg.usedSummary && (
                          <button className="ws-summary-link" onClick={handleSummaryLinkClick}>(Document Summary)</button>
                        )}
                        {msg.fromMemory && msg.memoryNote && (
                          <span className="ws-chat-memory-note">{msg.memoryNote}</span>
                        )}
                        {msg.results?.length > 0 && (
                          <div className="ws-chat-results">
                            {msg.results.map((r, j) => (
                              <div key={j} className="ws-chat-card">
                                <div className="ws-chat-card-meta">
                                  <span className="ws-chat-card-page">Page {r.page}</span>
                                  <span className="ws-chat-card-snippet">
                                    {r.before}<strong>{r.match}</strong>{r.after}
                                  </span>
                                </div>
                                <button className="ws-chat-card-btn" onClick={() => jumpToPage(r.page)}>Go to Page</button>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ))}
                <div ref={chatBottomRef} />
              </div>
              <form className="ws-chat-input-row" onSubmit={sendChat}>
                <input
                  className="ws-chat-input"
                  type="text"
                  placeholder="Ask anything..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                />
                <button className="ws-chat-send" type="submit">Send</button>
              </form>
            </>
          )}
        </div>
      )}

      {/* ── Bottom Toolbar ── */}
      <div className="ws-btbar">
        {/* Left: view mode icons */}
        <div className="ws-btbar-group">
          <button className={`ws-btbtn ${viewMode === "single" ? "ws-btbtn--active" : ""}`}
            title="Single Page (Ctrl+1)" onClick={() => setViewMode("single")}>⊡</button>
          <button className={`ws-btbtn ${viewMode === "splitV" ? "ws-btbtn--active" : ""}`}
            title="Split Vertical (Ctrl+2)" onClick={() => setViewMode("splitV")}>◫</button>
          <button className={`ws-btbtn ${viewMode === "splitH" ? "ws-btbtn--active" : ""}`}
            title="Split Horizontal (Ctrl+H)" onClick={() => setViewMode("splitH")}>⊟</button>
          <button className="ws-btbtn" title="Continuous scroll" disabled>☰</button>
          <button className="ws-btbtn" title="View" disabled>⊞</button>
        </div>

        {/* Center: tools + page nav + view history */}
        <div className="ws-btbar-center">
          <button className={`ws-btbtn ${currentTool === "pan"    ? "ws-btbtn--active" : ""}`}
            title="Hand tool (Shift+V)" onClick={() => setCurrentTool("pan")}>✥</button>
          <button className={`ws-btbtn ${currentTool === "select" ? "ws-btbtn--active" : ""}`}
            title="Select (V)" onClick={() => setCurrentTool("select")}>↖</button>
          <button className={`ws-btbtn ${currentTool === "text"   ? "ws-btbtn--active" : ""}`}
            title="Text Select (Shift+T)" onClick={() => setCurrentTool("text")}>Ⅰ</button>
          <button className={`ws-btbtn ${currentTool === "zoom"   ? "ws-btbtn--active" : ""}`}
            title="Zoom (Z)" onClick={() => setCurrentTool("zoom")}>⌕</button>

          <div className="ws-btbar-sep" />

          {[
            { id: "length",     label: "L",  title: "Length (Shift+Alt+L)" },
            { id: "polylength", label: "PL", title: "Polylength (Shift+Alt+Q)" },
            { id: "area",       label: "A",  title: "Area (Shift+Alt+A)" },
            { id: "perimeter",  label: "P",  title: "Perimeter (Shift+Alt+P)" },
            { id: "angle",      label: "∠",  title: "Angle (Shift+Alt+G)" },
            { id: "count",      label: "#",  title: "Count (Shift+Alt+C)" },
          ].map(({ id, label, title }) => (
            <button
              key={id}
              className={`ws-btbtn ws-btbtn--measure ${currentTool === id ? "ws-btbtn--active" : ""}`}
              title={title}
              onClick={() => { setCurrentTool(id); setMeasureTool(id); setMeasurePoints([]); }}
            >
              {label}
            </button>
          ))}

          <div className="ws-btbar-sep" />

          <button className="ws-btbtn" title="First page (Ctrl+Home)"
            onClick={() => jumpToPage(1)} disabled={pageNum <= 1}>|◄</button>
          <button className="ws-btbtn" title="Previous page (Ctrl+←)"
            onClick={() => jumpToPage(pageNum - 1)} disabled={pageNum <= 1}>◄</button>
          <div className="ws-btbar-page">
            <input
              className="ws-btbar-page-input"
              type="number" min="1" max={numPages || meta.pages}
              value={pageInputVal}
              onChange={(e) => setPageInputVal(e.target.value)}
              onBlur={commitPageInput}
              onKeyDown={(e) => e.key === "Enter" && commitPageInput()}
              title="Current page"
            />
            <span className="ws-btbar-page-of">of {numPages || meta.pages}</span>
          </div>
          <button className="ws-btbtn" title="Next page (Ctrl+→)"
            onClick={() => jumpToPage(pageNum + 1)} disabled={pageNum >= (numPages || meta.pages)}>►</button>
          <button className="ws-btbtn" title="Last page (Ctrl+End)"
            onClick={() => jumpToPage(numPages || meta.pages)} disabled={pageNum >= (numPages || meta.pages)}>►|</button>

          <div className="ws-btbar-sep" />

          <button className="ws-btbtn" title="Previous view (Alt+←)" onClick={goBackView}>←</button>
          <button className="ws-btbtn" title="Next view (Alt+→)"     onClick={goForwardView}>→</button>
        </div>

        {/* Right: snap toggle + page dimensions + scale + chat toggle */}
        <div className="ws-btbar-right">
          <button
            className={`ws-btbtn ws-btbtn--snap ${snapEnabled ? "ws-btbtn--snap-on" : ""}`}
            title={snapEnabled ? "Snap to Content: On (F3)" : "Snap to Content: Off (F3)"}
            onClick={() => { setSnapEnabled((v) => !v); snapResultRef.current = null; }}
          >
            ⊕ Snap
          </button>
          <div className="ws-btbar-sep" />
          {pageDims && <span className="ws-btbar-info">{pageDims}</span>}
          <span className="ws-btbar-info">
            {calibSaved
              ? `1 ${calibSaved.unit} = ${calibSaved.pixelsPerUnit.toFixed(1)}px`
              : "Scale Not Set"}
          </span>
          <div className="ws-btbar-sep" />
          <button
            className={`ws-btbtn ws-chat-toggle ${chatOpen ? "ws-btbtn--active" : ""}`}
            onClick={() => setChatOpen((v) => !v)}
            title={chatOpen ? "Close Navigator chat" : "Open Navigator chat"}
          >
            💬{chatMessages.filter((m) => m.role === "user").length > 0 && (
              <span style={{ marginLeft: 4 }}>
                {chatMessages.filter((m) => m.role === "user").length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ── Status Bar ── */}
      <div className="ws-statusbar">
        <span>Page {pageNum} of {numPages || meta.pages}</span>
        <span className="ws-stat-sep">|</span>
        <span>{scaleDisplay ? `${scaleDisplay}%` : "—"}</span>
        <span className="ws-stat-sep">|</span>
        <span>{TOOL_BTNS.find((t) => t.id === currentTool)?.tooltip?.split(" (")[0] ?? "Pan"}</span>
        <span className="ws-stat-sep">|</span>
        <span className="ws-stat-trim" title={meta.filename}>{meta.filename}</span>
        <span className="ws-stat-sep">|</span>
        <span>
          {calibSaved
            ? `1 ${calibSaved.unit} = ${calibSaved.pixelsPerUnit.toFixed(1)}px`
            : "Scale Not Set"}
        </span>
        {pageDims && <><span className="ws-stat-sep">|</span><span>{pageDims}</span></>}
        {snapEnabled && snapStatus && (
          <>
            <span className="ws-stat-sep">|</span>
            <span style={{ color: snapStatus === "vector" ? "#007BFF" : "#666" }}>
              {snapStatus === "vector" ? "Snap: Vector" : "Snap: N/A"}
            </span>
          </>
        )}
      </div>

      {/* ── Modals ── */}
      {modal?.type === "shortcuts" && (
        <div className="ws-overlay" onClick={() => setModal(null)}>
          <div className="ws-modal ws-modal--lg" onClick={(e) => e.stopPropagation()}>
            <div className="ws-modal-header">
              <span className="ws-modal-title">Keyboard Shortcuts</span>
              <button className="ws-modal-close" onClick={() => setModal(null)}>×</button>
            </div>
            <div className="ws-modal-body ws-shortcuts-body">
              {[
                ["V",          "Select Tool"],
                ["Shift+V",    "Pan Tool"],
                ["Shift+T",    "Select Text Tool"],
                ["Z",          "Zoom Tool"],
                ["Shift+Alt+L", "Length Tool"],
                ["Shift+Alt+Q", "Polylength Tool"],
                ["Shift+Alt+A", "Area Tool"],
                ["Shift+Alt+P", "Perimeter Tool"],
                ["Shift+Alt+G", "Angle Tool"],
                ["Shift+Alt+C", "Count Tool"],
                ["Backspace",   "Remove Last Measurement Point"],
                ["Escape",      "Cancel Measurement / Close Modal"],
                ["F3",          "Toggle Snap to Content"],
                ["Ctrl+1",     "Single Page"],
                ["Ctrl+2",     "Split Vertical"],
                ["Ctrl+H",     "Split Horizontal"],
                ["Ctrl+Home",  "First Page"],
                ["Ctrl+End",   "Last Page"],
                ["Ctrl+←",     "Previous Page"],
                ["Ctrl+→",     "Next Page"],
                ["Alt+←",      "Previous View"],
                ["Alt+→",      "Next View"],
                ["Ctrl+Z",     "Previous View (Undo)"],
                ["Ctrl+Y",     "Next View (Redo)"],
                ["Ctrl+F",     "Find / Search"],
                ["F11",        "Full Screen"],
              ].map(([key, desc]) => (
                <div key={key} className="ws-shortcut-row">
                  <kbd className="ws-kbd">{key}</kbd>
                  <span className="ws-shortcut-desc">{desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {modal?.type === "about" && (
        <div className="ws-overlay" onClick={() => setModal(null)}>
          <div className="ws-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ws-modal-header">
              <span className="ws-modal-title">About</span>
              <button className="ws-modal-close" onClick={() => setModal(null)}>×</button>
            </div>
            <div className="ws-modal-body ws-about-body">
              <div className="ws-about-icon">👣</div>
              <div className="ws-about-name">Footprint Navigator</div>
              <div className="ws-about-version">Version 1.0.0 Beta</div>
              <div className="ws-about-tagline">Tread boldly.</div>
              <button className="ws-settings-save" style={{ marginTop: 20 }} onClick={() => setModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {modal?.type === "docProps" && (
        <div className="ws-overlay" onClick={() => setModal(null)}>
          <div className="ws-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ws-modal-header">
              <span className="ws-modal-title">Document Properties</span>
              <button className="ws-modal-close" onClick={() => setModal(null)}>×</button>
            </div>
            <div className="ws-modal-body">
              {[
                ["Filename",   meta.filename],
                ["Pages",      String(numPages || meta.pages || "—")],
                ["File Size",  formatBytes(file?.size || 0)],
                ["Dimensions", pageDims || "—"],
                ["Scale",      scale ? `${Math.round(scale * 100)}%` : "Not Set"],
              ].map(([label, val]) => (
                <div key={label} className="ws-modal-prop-row">
                  <span className="ws-modal-prop-label">{label}</span>
                  <span className="ws-modal-prop-value">{val}</span>
                </div>
              ))}
            </div>
            <div className="ws-modal-footer">
              <button className="ws-settings-save" onClick={() => setModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {modal?.type === "saveAs" && (
        <div className="ws-overlay" onClick={() => setModal(null)}>
          <div className="ws-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ws-modal-header">
              <span className="ws-modal-title">Save Project As</span>
              <button className="ws-modal-close" onClick={() => setModal(null)}>×</button>
            </div>
            <div className="ws-modal-body">
              <p className="ws-settings-desc" style={{ marginBottom: 10 }}>Enter a filename for this project export.</p>
              <input
                className="ws-modal-input"
                type="text"
                value={saveAsName}
                onChange={(e) => setSaveAsName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { saveProjectJson(saveAsName); setModal(null); } }}
                autoFocus
              />
            </div>
            <div className="ws-modal-footer">
              <button className="ws-settings-save" onClick={() => { saveProjectJson(saveAsName); setModal(null); }}>Save</button>
              <button className="ws-settings-reset" onClick={() => setModal(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Scale Calibration Modal ── */}
      {modal?.type === "calibrate" && (
        <div className="ws-overlay" onClick={cancelCalib}>
          <div className="ws-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ws-modal-header">
              <span className="ws-modal-title">Set Scale</span>
              <button className="ws-modal-close" onClick={cancelCalib}>×</button>
            </div>
            <div className="ws-modal-body">
              <p className="ws-settings-desc" style={{ marginBottom: 12 }}>
                Enter the real-world distance between the two points you selected.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className={`ws-modal-input${calibDistError ? " ws-modal-input--error" : ""}`}
                  type="text"
                  placeholder={`e.g. 3'7", 3-7, 43", 3.5'`}
                  value={calibDist}
                  onChange={(e) => { setCalibDist(e.target.value); setCalibDistError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") confirmCalib(modal.pixelDist); }}
                  autoFocus
                  style={{ flex: 1 }}
                />
                <select
                  className="ws-modal-input"
                  value={calibUnit}
                  onChange={(e) => setCalibUnit(e.target.value)}
                  style={{ width: 140 }}
                >
                  <option value="inches">inches</option>
                  <option value="feet">feet</option>
                  <option value="yards">yards</option>
                  <option value="meters">meters</option>
                  <option value="centimeters">centimeters</option>
                  <option value="millimeters">millimeters</option>
                  <option value="kilometers">kilometers</option>
                </select>
              </div>
              {calibDistError
                ? <p className="ws-calib-input-error">{calibDistError}</p>
                : <p className="ws-calib-input-hint">Accepts: 37, 3'7", 3-7, 43", 3.5', 1m</p>
              }
            </div>
            <div className="ws-modal-footer">
              <button className="ws-settings-save" onClick={() => confirmCalib(modal.pixelDist)}>
                Set Scale
              </button>
              <button className="ws-settings-reset" onClick={cancelCalib}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toasts ── */}
      {toasts.length > 0 && (
        <div className="ws-toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className={`ws-toast${t.fading ? " ws-toast--fade" : ""}`}>{t.msg}</div>
          ))}
        </div>
      )}

    </div>
  );
}

// ── Sub-Components ────────────────────────────────────────────────────────────

function ThumbnailList({ pdfDoc, numPages, currentPage, onSelect, filename }) {
  const pages = Array.from({ length: numPages }, (_, i) => i + 1);
  return (
    <div className="ws-thumblist">
      {pages.map((n) => (
        <ThumbnailItem
          key={n}
          pdfDoc={pdfDoc}
          pageNum={n}
          isActive={n === currentPage}
          onSelect={onSelect}
          filename={filename}
        />
      ))}
    </div>
  );
}

function ThumbnailItem({ pdfDoc, pageNum, isActive, onSelect, filename }) {
  const canvasRef    = useRef(null);
  const containerRef = useRef(null);
  const rendered     = useRef(false);

  const storageKey = `footprint-label-${filename}-${pageNum}`;

  const [detectedSheet, setDetectedSheet] = useState(null);
  const [userLabel,     setUserLabel]     = useState(() => {
    try { return localStorage.getItem(storageKey) || null; } catch { return null; }
  });
  const [isEditing,  setIsEditing]  = useState(false);
  const [editValue,  setEditValue]  = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (!pdfDoc || !containerRef.current) return;
    const observer = new IntersectionObserver(
      async ([entry]) => {
        if (!entry.isIntersecting || rendered.current) return;
        rendered.current = true;
        observer.disconnect();
        try {
          const page = await pdfDoc.getPage(pageNum);
          if (!canvasRef.current) return;
          const viewport = page.getViewport({ scale: 0.18 });
          const canvas = canvasRef.current;
          canvas.width  = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

          // Detect sheet number after canvas render
          const fullVp = page.getViewport({ scale: 1 });
          const textContent = await page.getTextContent();
          const sheet = extractSheetNumber(textContent.items, fullVp, pageNum);
          if (sheet) setDetectedSheet(sheet);
        } catch { /* ignore cancelled renders */ }
      },
      { rootMargin: "150px" }
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [pdfDoc, pageNum]);

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) inputRef.current.focus();
  }, [isEditing]);

  const displayLabel = userLabel ?? detectedSheet ?? `Page ${pageNum}`;
  const labelColor   = userLabel
    ? "#ffffff"
    : detectedSheet
    ? "#a0c4ff"
    : "#888888";
  const showDot = !userLabel && !detectedSheet;

  const openEdit = (e) => {
    e.stopPropagation();
    setEditValue(displayLabel);
    setIsEditing(true);
  };

  const commitEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed) {
      setUserLabel(trimmed);
      try { localStorage.setItem(storageKey, trimmed); } catch {}
    }
    setIsEditing(false);
  };

  const cancelEdit = () => setIsEditing(false);

  return (
    <div
      id={`thumb-${pageNum}`}
      ref={containerRef}
      className={`ws-thumb ${isActive ? "active" : ""}`}
      onClick={() => onSelect(pageNum)}
      title={
        detectedSheet || userLabel
          ? `${userLabel ?? detectedSheet} (Pg. ${pageNum})`
          : `Page ${pageNum}`
      }
      style={{ cursor: "pointer" }}
    >
      <canvas ref={canvasRef} className="ws-thumb-canvas" />

      {isEditing ? (
        <input
          ref={inputRef}
          className="ws-thumb-label-input"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter")  { e.preventDefault(); commitEdit(); }
            if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
          }}
          onBlur={commitEdit}
        />
      ) : (
        <span
          className="ws-thumb-label"
          style={{ color: labelColor }}
          onClick={openEdit}
          title="Click to edit label"
        >
          {showDot && <span className="ws-thumb-dot">●</span>}
          {displayLabel}
        </span>
      )}
    </div>
  );
}

function SplitPanel({ pdfDoc, numPages }) {
  const maxP = numPages;
  const [pageNum, setPageNum] = useState(Math.min(2, maxP));
  const [scale,   setScale]   = useState(null);
  const [inputVal, setInputVal] = useState(String(Math.min(2, maxP)));
  const canvasRef     = useRef(null);
  const wrapRef       = useRef(null);
  const renderTaskRef = useRef(null);
  const renderGenRef  = useRef(0);

  useEffect(() => { setInputVal(String(pageNum)); }, [pageNum]);

  const calcScale = useCallback(async (doc, num) => {
    if (!doc || !wrapRef.current) return 1;
    const pg = await doc.getPage(num);
    const vp = pg.getViewport({ scale: 1 });
    return Math.max(0.1, (wrapRef.current.clientWidth - 64) / vp.width);
  }, []);

  const renderPage = useCallback(async (doc, num, s) => {
    if (!doc || !canvasRef.current || s === null) return;
    const gen = ++renderGenRef.current;
    if (renderTaskRef.current) {
      const old = renderTaskRef.current;
      renderTaskRef.current = null;
      old.cancel();
      try { await old.promise; } catch {}
    }
    if (gen !== renderGenRef.current) return;
    try {
      const page = await doc.getPage(num);
      if (gen !== renderGenRef.current) return;
      const viewport = page.getViewport({ scale: s });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const dpr = window.devicePixelRatio || 1;
      canvas.width  = Math.floor(viewport.width  * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width  = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const task = page.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
      renderTaskRef.current = task;
      await task.promise;
      if (gen !== renderGenRef.current) return;
      renderTaskRef.current = null;
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") console.error("SplitPanel:", err);
    }
  }, []);

  useEffect(() => {
    if (!pdfDoc) return;
    (async () => {
      const s = await calcScale(pdfDoc, pageNum);
      setScale(s);
      await renderPage(pdfDoc, pageNum, s);
    })();
  }, [pdfDoc]); // eslint-disable-line

  const prevKey = useRef(null);
  useEffect(() => {
    if (!pdfDoc || scale === null) return;
    const key = `${pageNum}|${scale}`;
    if (key === prevKey.current) return;
    prevKey.current = key;
    renderPage(pdfDoc, pageNum, scale);
  }, [pageNum, scale, pdfDoc, renderPage]);

  const jumpTo = (n) => setPageNum(Math.max(1, Math.min(maxP, n)));
  const commit = () => {
    const n = parseInt(inputVal, 10);
    if (!Number.isNaN(n)) jumpTo(n);
    else setInputVal(String(pageNum));
  };

  return (
    <div className="ws-split-panel">
      <div className="ws-doc-canvas" ref={wrapRef}>
        <div className="ws-canvas-inner">
          <div className="ws-page-frame">
            <canvas ref={canvasRef} />
          </div>
        </div>
      </div>
      <div className="ws-split-nav">
        <button className="ws-tbtn" onClick={() => jumpTo(1)} disabled={pageNum <= 1} title="First page">|◄</button>
        <button className="ws-tbtn" onClick={() => jumpTo(pageNum - 1)} disabled={pageNum <= 1} title="Prev page">◄</button>
        <input
          className="ws-page-input"
          type="number" min="1" max={maxP}
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
        <span className="ws-tlabel">of {maxP}</span>
        <button className="ws-tbtn" onClick={() => jumpTo(pageNum + 1)} disabled={pageNum >= maxP} title="Next page">►</button>
        <button className="ws-tbtn" onClick={() => jumpTo(maxP)} disabled={pageNum >= maxP} title="Last page">►|</button>
      </div>
    </div>
  );
}

function SearchPanel({ searchInput, setSearchInput, searchQuery, runSearch, searchResults, jumpToPage }) {
  return (
    <div className="ws-search-panel">
      <form className="ws-search-panel-form" onSubmit={runSearch}>
        <input
          className="ws-search-input ws-search-panel-input"
          type="text"
          placeholder="Search…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          autoFocus
        />
        <button type="submit" className="ws-tbtn" title="Search">Go</button>
      </form>
      {searchQuery && (
        <div className="ws-search-results-panel">
          <p className="ws-search-summary">
            {searchResults.length === 0
              ? `No matches for "${searchQuery}"`
              : `${searchResults.length} match${searchResults.length === 1 ? "" : "es"}`}
          </p>
          <ul className="result-list">
            {searchResults.map((r, idx) => (
              <li key={`${r.page}-${r.offset}-${idx}`}>
                <button className="result-item" onClick={() => jumpToPage(r.page)}>
                  <span className="result-page">Page {r.page}</span>
                  <span className="result-snippet">
                    {r.before}<mark>{r.match}</mark>{r.after}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function extractSheetNumber(items, viewport, pageLabel) {
  const pageW = viewport.width;
  const pageH = viewport.height;

  const validItems = items.filter(
    (item) => typeof item.str === "string" && item.str.trim().length > 0
  );

  // Patterns that a sheet number must fully match
  const SHEET_PATTERNS = [
    /^[A-Z]{1,3}[-.]?\d{1,2}[-.]\d{2,3}$/,   // A1.01, A-101, AB.2.100
    /^[ASMEPLCFI]\d{3}$/,                       // A101, M201, E301
    /^[A-Z]{1,3}-\d{3}$/,                       // ARC-101
    /^[A-Z]{1,3}[\-.]?\d{1,3}$/,               // A1, AB-12, E1 (short forms)
  ];
  const isSheetNumber = (s) => SHEET_PATTERNS.some((re) => re.test(s.trim()));

  // ── STRATEGY 0: Visual position priority (largest font in title block) ──────
  // Construction drawings almost always place the sheet number in the bottom-
  // right title block cell using the largest font on the page. Find it first.
  {
    // Bottom-right 20% width × bottom 15% height in PDF coordinates
    // (PDF y-axis: 0 = bottom, so low ty = near bottom)
    const cornerItems = validItems.filter((item) => {
      const [,,,, tx, ty] = item.transform;
      return tx >= pageW * 0.80 && ty <= pageH * 0.15;
    });

    // Sort by absolute font scale descending — transform[0] ≈ rendered font size
    const bySize = [...cornerItems].sort(
      (a, b) => Math.abs(b.transform[0]) - Math.abs(a.transform[0])
    );

    // Strict match first (exact sheet number patterns)
    for (const item of bySize) {
      const s = item.str.trim();
      if (s.length === 0 || s.length >= 12) continue;
      if (isSheetNumber(s)) {
        const [fs,,,, tx, ty] = item.transform;
        console.log(`[sheet] p${pageLabel} VISUAL(strict): scale=${Math.round(Math.abs(fs))} pos=(${Math.round(tx)},${Math.round(ty)}) → '${s}'`);
        return s;
      }
    }

    // Loose match: extract from short isolated strings in top-8 largest items
    const LOOSE_V0 = [
      /^([A-Z]{1,3}[-.]?\d{1,2}[-.]\d{2,3})$/,
      /^([ASMEPLCFI]\d{3})$/,
      /^([A-Z]{1,3}-\d{3})$/,
      /^([A-Z]{1,3}[\-.]?\d{1,3})$/,
    ];
    for (const item of bySize.slice(0, 8)) {
      const s = item.str.trim();
      if (s.length === 0 || s.length >= 12) continue;
      for (const re of LOOSE_V0) {
        const m = re.exec(s);
        if (m) {
          const [fs,,,, tx, ty] = item.transform;
          console.log(`[sheet] p${pageLabel} VISUAL(loose): scale=${Math.round(Math.abs(fs))} pos=(${Math.round(tx)},${Math.round(ty)}) → '${m[1]}'`);
          return m[1];
        }
      }
    }

    if (cornerItems.length > 0) {
      console.log(
        `[sheet] p${pageLabel} VISUAL: no match — ${cornerItems.length} corner items:`,
        bySize.slice(0, 6).map((i) => `'${i.str.trim()}'[${Math.round(Math.abs(i.transform[0]))}]`).join("  ")
      );
    }
  }

  // ── STRATEGY 1: Anchor label search ────────────────────────────────────────
  const ANCHORS = ["sheet number", "sheet no.", "sheet no", "sht no", "sht. no."];

  for (const anchor of validItems) {
    const label = anchor.str.trim().toLowerCase();
    if (!ANCHORS.includes(label)) continue;

    const [,,,, ax, ay] = anchor.transform;

    // Collect candidates: within 200 units right OR 100 units below the anchor
    const candidates = validItems
      .filter((item) => {
        if (item === anchor) return false;
        const [,,,, tx, ty] = item.transform;
        const dx = tx - ax;
        const dy = ay - ty; // positive = item is below anchor (lower y in PDF coords)
        return (dx >= 0 && dx <= 200 && Math.abs(ay - ty) <= 30) // same row, to the right
          || (dy >= 0 && dy <= 100 && Math.abs(tx - ax) <= 150); // below, roughly aligned
      })
      .sort((a, b) => {
        const [,,,, ax2, ay2] = [ax, ay, ax, ay, ax, ay]; // eslint-disable-line
        const [,,,, bx, by] = b.transform;
        const [,,,, cx, cy] = a.transform;
        const da = Math.hypot(cx - ax, cy - ay);
        const db = Math.hypot(bx - ax, by - ay);
        return da - db;
      });

    for (const cand of candidates) {
      const s = cand.str.trim();
      if (isSheetNumber(s)) {
        const [,,,, ax2, ay2] = anchor.transform;
        console.log(`[sheet] p${pageLabel} ANCHOR: found '${anchor.str.trim()}' at ${Math.round(ax2)},${Math.round(ay2)} → grabbed '${s}'`);
        return s;
      }
    }
  }

  // ── STRATEGY 2: Region fallback ────────────────────────────────────────────

  // Sort by proximity to bottom-right corner
  const distToCorner = (item) => {
    const [,,,, tx, ty] = item.transform;
    return Math.hypot(pageW - tx, ty); // low y = near bottom in PDF coords
  };
  const sorted = [...validItems].sort((a, b) => distToCorner(a) - distToCorner(b));

  const LOOSE_PATTERNS = [
    /\b([A-Z]{1,3}[-.]?\d{1,2}[-.]\d{2,3})\b/,
    /\b([ASMEPLCFI]\d{3})\b/,
    /\b([A-Z]{1,3}-\d{3})\b/,
  ];

  const tryIsolated = (candidates) => {
    for (const item of candidates) {
      const s = item.str.trim();
      if (s.length >= 10) continue;
      for (const re of LOOSE_PATTERNS) {
        const m = re.exec(s);
        if (m && m[1] === s) return m[1];
      }
    }
    return null;
  };

  const tryText = (candidates) => {
    const text = candidates.map((i) => i.str).join(" ");
    for (const re of LOOSE_PATTERNS) {
      const m = re.exec(text);
      if (m) return m[1];
    }
    return null;
  };

  const getRegion = (xFrac, yFrac) =>
    sorted.filter((item) => {
      const [,,,, tx, ty] = item.transform;
      return tx >= pageW * (1 - xFrac) && ty <= pageH * yFrac;
    });

  const tight = getRegion(0.15, 0.10);
  let hit = tryIsolated(tight);
  console.log(`[sheet] p${pageLabel} FALLBACK tight (15%w,10%h):`, tight.map((i) => i.str).join(" | "), "→", hit);
  if (hit) return hit;

  const medium = getRegion(0.25, 0.15);
  hit = tryIsolated(medium) || tryText(medium);
  console.log(`[sheet] p${pageLabel} FALLBACK medium (25%w,15%h):`, medium.map((i) => i.str).join(" | "), "→", hit);
  if (hit) return hit;

  hit = tryText(sorted);
  console.log(`[sheet] p${pageLabel} FALLBACK full page:`, sorted.map((i) => i.str).join(" ").slice(0, 200), "→", hit);
  return hit;
}

async function drawHighlights(context, page, viewport, dpr, query) {
  try {
    const textContent = await page.getTextContent();
    const q = query.toLowerCase();
    context.save();
    if (dpr !== 1) context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle   = "rgba(255, 235, 59, 0.45)";
    context.strokeStyle = "rgba(255, 193, 7, 0.85)";
    context.lineWidth   = 1;
    for (const item of textContent.items) {
      if (typeof item.str !== "string" || !item.str.toLowerCase().includes(q)) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const h  = Math.hypot(tx[2], tx[3]);
      const w  = (item.width || 0) * viewport.scale;
      context.fillRect(tx[4], tx[5] - h, w, h);
      context.strokeRect(tx[4], tx[5] - h, w, h);
    }
    context.restore();
  } catch { /* best-effort */ }
}

// ── Calibration distance parser ────────────────────────────────────────────

function _toInches(value, unit) {
  const factors = { inches: 1, feet: 12, yards: 36, meters: 39.3701, centimeters: 0.393701, millimeters: 0.0393701, kilometers: 39370.1 };
  return value * (factors[unit] ?? 1);
}
function _fromInches(inches, unit) {
  const factors = { inches: 1, feet: 1 / 12, yards: 1 / 36, meters: 1 / 39.3701, centimeters: 1 / 0.393701, millimeters: 1 / 0.0393701, kilometers: 1 / 39370.1 };
  return inches * (factors[unit] ?? 1);
}
function convertCalibUnit(value, fromUnit, toUnit) {
  if (fromUnit === toUnit) return value;
  return _fromInches(_toInches(value, fromUnit), toUnit);
}
function parseCalibDist(str, defaultUnit) {
  const s = str.trim();
  if (!s) return null;

  // Feet-inches: 3'7"  3'7  3'7.5"  3-7  3-7.5
  const ftIn = s.match(/^(\d+(?:\.\d+)?)['\u2018\u2019\-](\d+(?:\.\d+)?)["\u201C\u201D]?$/);
  if (ftIn) {
    const totalFt = parseFloat(ftIn[1]) + parseFloat(ftIn[2]) / 12;
    return convertCalibUnit(totalFt, "feet", defaultUnit);
  }

  // Inches only: 43"  43in  43inch  43inches
  const inOnly = s.match(/^(\d+(?:\.\d+)?)\s*(?:["\u201C\u201D]|in(?:ch(?:es?)?)?)$/i);
  if (inOnly) return convertCalibUnit(parseFloat(inOnly[1]), "inches", defaultUnit);

  // Feet only: 3.5'  3.5ft  3.5feet
  const ftOnly = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)$/i);
  if (ftOnly) return convertCalibUnit(parseFloat(ftOnly[1]), "feet", defaultUnit);

  // Meters: 1m  1.5m  1.5 m
  const mOnly = s.match(/^(\d+(?:\.\d+)?)\s*m$/i);
  if (mOnly) return convertCalibUnit(parseFloat(mOnly[1]), "meters", defaultUnit);

  // Centimeters: 150cm
  const cmOnly = s.match(/^(\d+(?:\.\d+)?)\s*cm$/i);
  if (cmOnly) return convertCalibUnit(parseFloat(cmOnly[1]), "centimeters", defaultUnit);

  // Millimeters: 500mm
  const mmOnly = s.match(/^(\d+(?:\.\d+)?)\s*mm$/i);
  if (mmOnly) return convertCalibUnit(parseFloat(mmOnly[1]), "millimeters", defaultUnit);

  // Yards: 2yd  2 yd  2yards  2 yards
  const ydOnly = s.match(/^(\d+(?:\.\d+)?)\s*(?:yds?|yards?)$/i);
  if (ydOnly) return convertCalibUnit(parseFloat(ydOnly[1]), "yards", defaultUnit);

  // Kilometers: 1km  1 km  1kilometer  1kilometers
  const kmOnly = s.match(/^(\d+(?:\.\d+)?)\s*(?:km|kilometers?)$/i);
  if (kmOnly) return convertCalibUnit(parseFloat(kmOnly[1]), "kilometers", defaultUnit);

  // Plain number — use selected unit as-is
  const plain = parseFloat(s);
  if (!isNaN(plain) && plain > 0) return plain;

  return null;
}

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
      const s   = Math.max(0, idx - R);
      const e   = Math.min(text.length, idx + q.length + R);
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
