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
    intro:
      "The left panel shows every page as a thumbnail. Navigator automatically reads each page title block and detects sheet numbers like A101, P201, E301. " +
      "Blue means auto-detected, white means manually corrected, gray means not detected. Click any thumbnail to jump to that page instantly.",
  },
  {
    title: "Keyword Search",
    intro:
      "Search every page of your document instantly by keyword. Results show the exact page number and a text snippet. Click any result to jump directly to that page.",
  },
  {
    title: "Measurement Tools",
    intro:
      "Navigator has a full set of measurement tools that work directly on any PDF page. Set your scale first and all measurements calculate real-world dimensions automatically. Navigator will prompt you to set scale if you forget.",
  },
  {
    title: "Navigator AI Chat",
    intro:
      "The chat panel in the bottom right is where the real power is. Ask Navigator anything about your document in plain language and it will find the answer and link directly to the page it came from.",
  },
  {
    title: "What Is In Development",
    intro:
      "Footprint Navigator launched as a web app and a lot more is being built right now. Here is what the team is actively working on.",
  },
  {
    title: "Settings and AI Modes",
    intro:
      "The settings panel gives full control over how Navigator works. Choose your AI mode, customize behavior, and track usage all from one place.",
  },
];

const TW_INTERVAL = 18;

// ── Phases ────────────────────────────────────────────────────────────────────
// opening → opening-buttons → feature-intro → chips → … → handoff
// → qa-input → qa-thinking → qa-answer → qa-input | done

export default function WorkspaceOnboarding({ onClose }) {
  const [phase,        setPhase]        = useState("opening");
  const [featureIndex, setFeatureIndex] = useState(0);
  const [streamedText, setStreamedText] = useState("");
  const [qaInput,      setQaInput]      = useState("");
  const [qaAnswer,     setQaAnswer]     = useState("");
  const [qaHistory,    setQaHistory]    = useState([]);
  const [loading,      setLoading]      = useState(false);

  const twTimerRef = useRef(null);
  const scrollRef  = useRef(null);
  const inputRef   = useRef(null);
  const onCloseRef = useRef(onClose);
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

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const callAI = useCallback(async (question, hist) => {
    try {
      const res  = await fetch("/pdf-api/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history: hist }),
      });
      const data = await res.json();
      return (data.answer || "That is a great question — I may not have enough context right now. Try asking Navigator directly using the chat panel after the tour, or reach us at info@footprintnavigator.com.").trim();
    } catch {
      return "That is a great question — I may not have enough context right now. Try asking Navigator directly using the chat panel after the tour, or reach us at info@footprintnavigator.com.";
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
    setPhase("done");
    onCloseRef.current?.();
  }, []);

  const handleGotIt = useCallback(() => advanceFeature(), [advanceFeature]);

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

          {phase === "chips" && (
            <button className="wob-btn wob-btn--primary" onClick={handleGotIt}>
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
