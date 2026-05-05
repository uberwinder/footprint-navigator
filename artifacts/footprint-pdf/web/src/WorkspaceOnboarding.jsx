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
    tellMorePrompt:
      "The user is on the onboarding tour for Footprint Navigator. Tell them more about the sheet and thumbnail panel. " +
      "Explain that the thumbnail panel is on the left side of the screen. Sheet number detection works on any structured PDF — not just construction drawings. " +
      "If a sheet number is wrong the user can click the label on the thumbnail to correct it manually. " +
      "This makes navigating documents with 50, 100, or 500 pages fast and accurate. " +
      "Works great for construction drawing sets, legal documents, technical manuals, insurance files, or any large structured PDF.",
  },
  {
    title: "Keyword Search",
    intro:
      "Search every page of your document instantly by keyword. Results show the exact page number and a text snippet. Click any result to jump directly to that page.",
    tellMorePrompt:
      "The user is on the onboarding tour for Footprint Navigator. Tell them more about the keyword search feature. " +
      "The search bar is in the top toolbar and the keyboard shortcut is Ctrl+F. It searches extracted text from every page simultaneously. " +
      "Works best on text-based PDFs and may have limited results on fully scanned image PDFs. " +
      "Example uses: finding a room name, a spec section, a product name, a note keyword, a clause in a contract, or a person's name in a document.",
  },
  {
    title: "Measurement Tools",
    intro:
      "Navigator has a full set of measurement tools that work directly on any PDF page. Set your scale first and all measurements calculate real-world dimensions automatically. Navigator will prompt you to set scale if you forget.",
    tellMorePrompt:
      "The user is on the onboarding tour for Footprint Navigator. Tell them more about the measurement tools. " +
      "The tools are in the toolbar — keyboard shortcuts are L for length, A for area, P for perimeter, G for angle. " +
      "Scale must be set before measuring and Navigator will show a prompt if you try to measure without it. " +
      "Available tools are length, area, perimeter, angle, and count. Measurements are anchored to their specific page and do not appear on other pages. " +
      "All measurements export to CSV from the measurements panel. " +
      "Example uses: measuring room dimensions, calculating material quantities, verifying distances on any document.",
  },
  {
    title: "Navigator AI Chat",
    intro:
      "The chat panel in the bottom right is where the real power is. Ask Navigator anything about your document in plain language and it will find the answer and link directly to the page it came from.",
    tellMorePrompt:
      "The user is on the onboarding tour for Footprint Navigator. Tell them more about the AI chat. " +
      "Open the chat panel by clicking the chat icon in the bottom right of the screen. " +
      "Navigator reads and indexes the entire document so it can answer questions about any page. Answers always include a clickable page reference. " +
      "Navigator remembers the conversation so follow-up questions work naturally — ask what carpet is on page 3, then ask where else is this used, and Navigator understands. " +
      "Three AI modes: Free is fast and good for simple questions, Balanced is better accuracy, Best uses the most powerful models for complex reasoning. " +
      "Example questions: Where are the PTAC units, What finish is on the corridor walls, Find all references to fire stopping, Summarize page 12, What does clause 4.2 mean.",
  },
  {
    title: "What Is In Development",
    intro:
      "Footprint Navigator launched as a web app and a lot more is being built right now. Here is what the team is actively working on.",
    tellMorePrompt:
      "The user is on the onboarding tour for Footprint Navigator. Tell them what is currently in development. " +
      "A desktop app is in development for offline use and local file access without uploading. " +
      "Support for multiple documents open simultaneously is in development. " +
      "Navigator will connect to email and project management software so users can take action without leaving the app — this is in development. " +
      "Persistent project storage to save and reopen projects without re-uploading is in development. " +
      "Navigator is designed to work with any large PDF including construction drawings, legal documents, insurance files, and technical manuals. " +
      "Launch date is July 1 2026. Pricing is Solo $19 per month and Team $29 per user per month also in development. " +
      "Contact info@footprintnavigator.com for questions or large file support.",
  },
  {
    title: "Settings and AI Modes",
    intro:
      "The settings panel gives full control over how Navigator works. Choose your AI mode, customize behavior, and track usage all from one place.",
    tellMorePrompt:
      "The user is on the onboarding tour for Footprint Navigator. Tell them more about the settings panel and AI modes. " +
      "Open settings from the gear icon in the toolbar. " +
      "AI mode selector: Free uses Groq Llama for fast responses, Balanced combines models for better accuracy, Best uses Claude and GPT-4o for maximum reasoning. " +
      "Advanced users can override the exact model per tier. " +
      "The system prompt editor lets you customize how Navigator responds — useful for teams with specific workflows. " +
      "Session memory controls let you manage what Navigator remembers during the session. " +
      "API usage stats and cost tracker show exactly how many tokens have been used and the estimated cost. " +
      "Snap settings control measurement snapping behavior.",
  },
];

const OPENING_TELL_MORE_PROMPT =
  "You are Navigator, the AI assistant for Footprint Navigator. " +
  "A new user has just arrived at the demo. In 3–4 sentences, explain what Footprint Navigator is, " +
  "what it is used for, who it is built for, and what they should expect from this demo. " +
  "Be conversational, concise, and engaging.";

const TW_INTERVAL = 18; // ms per character ≈ 55 chars/sec

export default function WorkspaceOnboarding({ onClose }) {
  const [phase,         setPhase]         = useState("opening");
  const [featureIndex,  setFeatureIndex]  = useState(0);
  const [streamedText,  setStreamedText]  = useState("");
  const [fetchedText,   setFetchedText]   = useState("");
  const [loading,       setLoading]       = useState(false);
  const [history,       setHistory]       = useState([]);
  const [followUpInput, setFollowUpInput] = useState("");

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
  }, [streamedText]);

  // Focus follow-up input when that phase starts
  useEffect(() => {
    if (phase === "follow-up-input" && inputRef.current) inputRef.current.focus();
  }, [phase]);

  // Clean up typewriter interval on unmount
  useEffect(() => {
    return () => { if (twTimerRef.current) clearInterval(twTimerRef.current); };
  }, []);

  // ── Typewriter ──────────────────────────────────────────────────────────────
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

  // ── Phase: opening ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "opening") return;
    typewrite(WELCOME_TEXT, () => {
      // Stop and wait — user must click a button to proceed
      setPhase("opening-buttons");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ── Phase: feature-intro ────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "feature-intro") return;
    typewrite(FEATURES[featureIndex].intro, () => setPhase("chips"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, featureIndex]);

  // ── Phase: opening-more — typewrite AI "tell me more" response ──────────────
  useEffect(() => {
    if (phase !== "opening-more" || !fetchedText) return;
    typewrite(fetchedText, () => setPhase("opening-ready"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, fetchedText]);

  // ── Phase: tell-more — typewrite AI response once it arrives ────────────────
  useEffect(() => {
    if (phase !== "tell-more" || !fetchedText) return;
    typewrite(fetchedText, () => setPhase("yes-no"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, fetchedText]);

  // ── Phase: follow-up — typewrite AI response once it arrives ───────────────
  useEffect(() => {
    if (phase !== "follow-up" || !fetchedText) return;
    typewrite(fetchedText, () => setPhase("yes-no"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, fetchedText]);

  // ── Phase: handoff ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "handoff") return;
    typewrite(HANDOFF_TEXT, () => {
      setTimeout(() => {
        setPhase("done");
        onCloseRef.current?.();
      }, 800);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const advanceFeature = useCallback(() => {
    const next = featureIndex + 1;
    if (next >= FEATURES.length) {
      setPhase("handoff");
    } else {
      setFeatureIndex(next);
      setPhase("feature-intro");
    }
  }, [featureIndex]);

  const callAI = useCallback(async (question, hist) => {
    try {
      const res  = await fetch("/pdf-api/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history: hist }),
      });
      const data = await res.json();
      return (data.answer || "I'm not sure — try asking another way.").trim();
    } catch {
      return "Something went wrong. Please try again.";
    }
  }, []);

  // ── Handlers (all must come after callAI) ───────────────────────────────────
  const handleOpeningReady = useCallback(() => {
    setFeatureIndex(0);
    setPhase("feature-intro");
  }, []);

  const handleOpeningTellMore = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setFetchedText("");
    setPhase("opening-more");
    const answer = await callAI(OPENING_TELL_MORE_PROMPT, []);
    setLoading(false);
    setFetchedText(answer);
  }, [loading, callAI]);

  const handleGotIt = useCallback(() => advanceFeature(), [advanceFeature]);

  const handleTellMore = useCallback(async () => {
    if (loading) return;
    const question = FEATURES[featureIndex].tellMorePrompt;
    setLoading(true);
    setFetchedText("");
    setPhase("tell-more");
    const answer = await callAI(question, history);
    setHistory((h) => [...h, { role: "user", content: question }, { role: "assistant", content: answer }]);
    setLoading(false);
    setFetchedText(answer);
  }, [loading, featureIndex, history, callAI]);

  const handleYes = useCallback(() => advanceFeature(), [advanceFeature]);

  const handleNo = useCallback(() => {
    setFollowUpInput("");
    setPhase("follow-up-input");
  }, []);

  const handleFollowUpSubmit = useCallback(async () => {
    const q = followUpInput.trim();
    if (!q || loading) return;
    setLoading(true);
    setFetchedText("");
    setPhase("follow-up");
    const answer = await callAI(q, history);
    setHistory((h) => [...h, { role: "user", content: q }, { role: "assistant", content: answer }]);
    setLoading(false);
    setFetchedText(answer);
  }, [followUpInput, loading, history, callAI]);

  const handleClose = useCallback(() => {
    if (twTimerRef.current) clearInterval(twTimerRef.current);
    setPhase("done");
    onCloseRef.current?.();
  }, []);

  if (phase === "done") return null;

  const isLoadingAI     = (phase === "opening-more" || phase === "tell-more" || phase === "follow-up") && loading;
  const showFeatureBadge = ["chips", "tell-more", "yes-no", "follow-up-input", "follow-up"].includes(phase);

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

        {/* Streamed text body */}
        <div className="wob-body" ref={scrollRef}>
          {isLoadingAI ? (
            <div className="wob-typing-wrap" aria-label="Navigator is thinking">
              <span className="wob-typing"><span /><span /><span /></span>
            </div>
          ) : (
            <p className="wob-text">{streamedText}</p>
          )}
        </div>

        {/* Action row */}
        <div className="wob-actions">
          {phase === "opening-buttons" && (
            <>
              <button className="wob-btn wob-btn--ghost"   onClick={handleOpeningReady}>I'm Ready</button>
              <button className="wob-btn wob-btn--primary" onClick={handleOpeningTellMore}>Tell Me More</button>
            </>
          )}
          {phase === "opening-ready" && (
            <button className="wob-btn wob-btn--primary" onClick={handleOpeningReady}>I'm Ready</button>
          )}
          {phase === "chips" && (
            <>
              <button className="wob-btn wob-btn--ghost"   onClick={handleGotIt}>Got it</button>
              <button className="wob-btn wob-btn--primary" onClick={handleTellMore}>Tell me more</button>
            </>
          )}
          {phase === "yes-no" && (
            <>
              <button className="wob-btn wob-btn--primary" onClick={handleYes}>Yes</button>
              <button className="wob-btn wob-btn--ghost"   onClick={handleNo}>No</button>
            </>
          )}
          {phase === "follow-up-input" && (
            <>
              <input
                ref={inputRef}
                className="wob-input"
                type="text"
                placeholder="Ask a follow-up question…"
                value={followUpInput}
                onChange={(e) => setFollowUpInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleFollowUpSubmit(); }}
                disabled={loading}
              />
              <button
                className="wob-btn wob-btn--primary wob-btn--send"
                onClick={handleFollowUpSubmit}
                disabled={loading || !followUpInput.trim()}
                aria-label="Send"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"
                    stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
