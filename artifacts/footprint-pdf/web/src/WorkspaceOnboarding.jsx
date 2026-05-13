import { useState, useRef, useEffect, useCallback } from "react";

const WELCOME_TEXT =
  "Hey, I'm Navigator — welcome to the Footprint Navigator demo. " +
  "This product officially launches July 1, 2026, so you may run into a few rough edges while we fine-tune things. " +
  "I'm going to walk you through what I can do. Let's go.";

const HANDOFF_TEXT =
  "That is everything for now. The chat panel in the bottom right is always available if you have questions about your document or the app. " +
  "I am here whenever you need me. Good luck — and remember, this is still a demo. " +
  "If something does not work right, we want to know about it. Reach us at info@footprintnavigator.com.";

const FEATURES = [
  {
    title: "Sheet and Thumbnail Panel",
    spotlight: ".ws-left-bar",
    intro:
      "The left panel shows every page as a thumbnail. Navigator automatically reads each page title block and detects sheet numbers like A101, P201, E301. " +
      "Blue means auto-detected, white means manually corrected, gray means not detected. Click any thumbnail to jump to that page instantly. " +
      "Use the ← → Back and Forward buttons in the top left toolbar to move between pages you have already visited — just like a browser.",
  },
  {
    title: "Project Files",
    spotlight: "#ws-settings-project-files",
    intro:
      "Navigator can work with up to 5 related documents at once in a single project. To set this up, open the chat panel in the bottom right corner, then click the gear icon inside the chat panel to open Settings. Look for the Project Files section. Add your specs, RFIs, submittals, or any related PDF there, give your project a name, and Navigator will search all of them together — always telling you which document an answer came from. You can also paste project links to keep everything in one place. Full integrations are currently in development.",
  },
  {
    title: "Measurement Tools",
    spotlight: '[data-menu-id="tools"]',
    intro:
      "Navigator has a full set of measurement tools that work directly on any PDF page. Set your scale first and all measurements calculate real-world dimensions automatically. Navigator will prompt you to set scale if you forget.",
  },
  {
    title: "Navigator AI Chat",
    spotlight: ".ws-chat-toggle",
    intro:
      "The chat panel is where the real power is. Ask Navigator anything about your document in plain language and it will find the answer and link directly to the page it came from. Press Ctrl+Enter now to open it.",
  },
  {
    title: "Settings and AI Modes",
    spotlight: ".ws-chat-gear",
    intro:
      "The chat panel also has its own settings that give you full control over how Navigator responds. To access them, open the chat panel and look for the settings icon inside it. From there you can choose your AI mode, customize how Navigator responds, and track your usage.",
  },
];

const TW_INTERVAL = 18;

// ── Phases ────────────────────────────────────────────────────────────────────
// opening → opening-buttons → feature-intro → chips → … → handoff
// → qa-input → qa-thinking → qa-answer → qa-input | done

export default function WorkspaceOnboarding({ onClose, skipWelcome = false, onSwitchToDrawings, onSpotlight, chatOpen, onTourAction }) {
  const [phase,        setPhase]        = useState(skipWelcome ? "feature-intro" : "opening");
  const [featureIndex, setFeatureIndex] = useState(0);
  const [streamedText, setStreamedText] = useState("");
  const [qaInput,      setQaInput]      = useState("");
  const [qaAnswer,     setQaAnswer]     = useState("");
  const [qaHistory,    setQaHistory]    = useState([]);
  const [loading,      setLoading]      = useState(false);

  const twTimerRef     = useRef(null);
  const scrollRef      = useRef(null);
  const inputRef       = useRef(null);
  const onCloseRef     = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Auto-scroll body as text streams in
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [streamedText, qaAnswer]);

  // Focus QA input when that phase starts
  useEffect(() => {
    if (phase === "qa-input" && inputRef.current) inputRef.current.focus();
  }, [phase]);

  // Clean up typewriter on unmount
  useEffect(() => {
    return () => { if (twTimerRef.current) clearInterval(twTimerRef.current); };
  }, []);

  // ── Typewriter ───────────────────────────────────────────────────────────────
  const typewrite = useCallback((text, onDone) => {
    if (twTimerRef.current) clearInterval(twTimerRef.current);
    setStreamedText("");
    let i = 0;
    twTimerRef.current = setInterval(() => {
      i++;
      setStreamedText(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(twTimerRef.current);
        twTimerRef.current = null;
        onDone();
      }
    }, TW_INTERVAL);
  }, []);

  // ── Phase effects ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "opening") return;
    typewrite(WELCOME_TEXT, () => setPhase("opening-buttons"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (phase !== "feature-intro") return;
    typewrite(FEATURES[featureIndex].intro, () => setPhase("chips"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, featureIndex]);

  useEffect(() => {
    if (phase !== "handoff") return;
    typewrite(HANDOFF_TEXT, () => setPhase("qa-input"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Switch to drawings tab immediately on mount (before any streaming starts)
  useEffect(() => {
    onSwitchToDrawings?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Set spotlight when a feature starts streaming; signal Workspace for Project Files stop
  useEffect(() => {
    if (phase !== "feature-intro") return;
    onSpotlight?.(FEATURES[featureIndex].spotlight ?? null);
    if (featureIndex === 1) onTourAction?.("open-project-files");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, featureIndex]);

  // Auto-advance from Navigator AI Chat stop when user opens the chat
  useEffect(() => {
    if (!chatOpen) return;
    if (featureIndex !== 3) return;
    if (phase !== "chips" && phase !== "feature-intro") return;
    onSpotlight?.(null);
    advanceFeature();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen]);

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const callAI = useCallback(async (question, hist) => {
    try {
      const res  = await fetch("/pdf-api/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history: hist }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      if (!data.answer) throw new Error("Empty response from AI");
      return data.answer.trim();
    } catch (err) {
      console.error("[onboard] AI call failed:", err);
      return "Something went wrong reaching Navigator — please try again.";
    }
  }, []);

  const advanceFeature = useCallback(() => {
    const next = featureIndex + 1;
    if (next >= FEATURES.length) {
      setPhase("handoff");
    } else {
      setFeatureIndex(next);
      setPhase("feature-intro");
    }
  }, [featureIndex]);

  const handleClose = useCallback(() => {
    if (twTimerRef.current) clearInterval(twTimerRef.current);
    onSpotlight?.(null);
    setPhase("done");
    onCloseRef.current?.();
  }, [onSpotlight]);

  const handleGotIt = useCallback(() => {
    onSpotlight?.(null);
    advanceFeature();
  }, [advanceFeature, onSpotlight]);

  const handleProjectFilesGotIt = useCallback(() => {
    onSpotlight?.(null);
    onTourAction?.("close-chat");
    advanceFeature();
  }, [onSpotlight, onTourAction, advanceFeature]);

  const handleSettingsGotIt = useCallback(() => {
    onTourAction?.("close-chat");
    handleClose();
  }, [onTourAction, handleClose]);

  const handleQaSend = useCallback(async () => {
    const q = qaInput.trim();
    if (!q || loading) return;
    setLoading(true);
    setQaAnswer("");
    setPhase("qa-thinking");
    const newHist = [...qaHistory, { role: "user", content: q }];
    const answer  = await callAI(q, qaHistory);
    setQaHistory([...newHist, { role: "assistant", content: answer }]);
    setQaAnswer(answer);
    setQaInput("");
    setLoading(false);
    setPhase("qa-answer");
  }, [qaInput, loading, qaHistory, callAI]);

  if (phase === "done") return null;

  const showFeatureBadge = ["chips", "feature-intro"].includes(phase);

  return (
    <>
      {/* Non-blocking dim overlay */}
      <div className="wob-overlay" aria-hidden="true" />

      {/* Onboarding card */}
      <div className="wob-card" role="dialog" aria-label="Navigator onboarding tour">

        {/* Header */}
        <div className="wob-header">
          <div className="wob-header-left">
            <span className="wob-logo">Navigator</span>
            {showFeatureBadge && (
              <span className="wob-badge">{FEATURES[featureIndex].title}</span>
            )}
          </div>
          <button className="wob-close" onClick={handleClose} aria-label="Close onboarding tour">×</button>
        </div>

        {/* Body */}
        <div className="wob-body" ref={scrollRef}>
          {phase === "qa-thinking" ? (
            <div className="wob-typing-wrap" aria-label="Navigator is thinking">
              <span className="wob-typing"><span /><span /><span /></span>
            </div>
          ) : phase === "qa-answer" ? (
            <p className="wob-text">{qaAnswer}</p>
          ) : (
            <p className="wob-text">{streamedText}</p>
          )}
        </div>

        {/* Action row */}
        <div className="wob-actions">
          {phase === "opening-buttons" && (
            <button className="wob-btn wob-btn--primary" onClick={() => { setFeatureIndex(0); setPhase("feature-intro"); }}>
              I'm Ready
            </button>
          )}

          {phase === "chips" && featureIndex !== 1 && featureIndex !== 3 && featureIndex !== 4 && (
            <button className="wob-btn wob-btn--primary" onClick={handleGotIt}>
              Got it
            </button>
          )}
          {phase === "chips" && featureIndex === 1 && (
            <button className="wob-btn wob-btn--primary" onClick={handleProjectFilesGotIt}>
              Got it
            </button>
          )}
          {phase === "chips" && featureIndex === 3 && (
            <span className="wob-waiting-text">Waiting for you to open the chat…</span>
          )}
          {phase === "chips" && featureIndex === 4 && (
            <button className="wob-btn wob-btn--primary" onClick={handleSettingsGotIt}>
              Got it
            </button>
          )}

          {phase === "qa-input" && (
            <>
              <input
                ref={inputRef}
                className="wob-input"
                type="text"
                placeholder="Have a question before you get started? Ask me anything."
                value={qaInput}
                onChange={(e) => setQaInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleQaSend(); }}
                disabled={loading}
              />
              <button
                className="wob-btn wob-btn--primary wob-btn--send"
                onClick={handleQaSend}
                disabled={loading || !qaInput.trim()}
                aria-label="Send"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"
                    stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button className="wob-btn wob-btn--primary" onClick={handleClose}>
                Let's go
              </button>
            </>
          )}

          {phase === "qa-answer" && (
            <>
              <button className="wob-btn wob-btn--ghost" onClick={() => setPhase("qa-input")}>
                Ask another question
              </button>
              <button className="wob-btn wob-btn--primary" onClick={handleClose}>
                Let's go
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
