import { useState, useRef, useEffect, useCallback } from "react";

const TOUR_STEPS = [
  {
    title: "AI Chat",
    teaser: "Ask anything about your document and Navigator reads every page to answer.",
    question: "Tell me about the AI chat feature — where do I find it and what can it do?",
  },
  {
    title: "Measurement Tools",
    teaser: "Measure length, area, perimeter, angle, and count — all calibrated to real-world units.",
    question: "Tell me about the measurement tools — where are they and how do I use them?",
  },
  {
    title: "Smart Search",
    teaser: "Search across every page at once with instant keyword highlighting.",
    question: "Tell me about the search feature — where is it and how does it work?",
  },
  {
    title: "Sheet Detection",
    teaser: "Navigator auto-reads title blocks to label and organise your pages.",
    question: "Tell me about sheet detection — where does it show up and what does it do?",
  },
  {
    title: "Split View",
    teaser: "Compare two pages side by side — great for cross-referencing drawings.",
    question: "Tell me about split view — where is it and how do I use it?",
  },
];

const WELCOME_MSG = {
  role: "assistant",
  content: "Hi! I'm Navigator, your AI assistant from Footprint Technologies. Ready to see what Footprint Navigator can do?",
  isWelcome: true,
};

function renderText(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : <span key={i}>{part}</span>
  );
}

function hasReadyPrompt(text) {
  return /ready to move on\??/i.test(text) || /anything else about this.*ready to move on\??/i.test(text);
}

export default function OnboardingBubble() {
  const [open,         setOpen]         = useState(false);
  const [step,         setStep]         = useState(0);
  const [tourStarted,  setTourStarted]  = useState(false);
  const [tourDone,     setTourDone]     = useState(false);
  const [messages,     setMessages]     = useState([WELCOME_MSG]);
  const [input,        setInput]        = useState("");
  const [loading,      setLoading]      = useState(false);
  const [history,      setHistory]      = useState([]);

  const scrollRef = useRef(null);
  const inputRef  = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  const pushMsg = useCallback((msg) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const callAI = useCallback(async (question, hist) => {
    setLoading(true);
    try {
      const res  = await fetch("/pdf-api/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history: hist }),
      });
      const data = await res.json();
      return (data.answer || "I'm not sure — feel free to ask another way.").trim();
    } catch {
      return "Something went wrong. Please try again.";
    } finally {
      setLoading(false);
    }
  }, []);

  const handleStartTour = useCallback(() => {
    setTourStarted(true);
    const first = TOUR_STEPS[0];
    setMessages((prev) => [
      ...prev,
      { role: "user",      content: "Yes, show me around!" },
      { role: "assistant", content: `Let's go! First up: **${first.title}** — ${first.teaser}`, showTellMore: true },
    ]);
  }, []);

  const handleSkipTour = useCallback(() => {
    setTourStarted(true);
    setTourDone(true);
    pushMsg({
      role: "assistant",
      content: "No problem — I'm here whenever you need me. Drop a PDF above to get started, or ask me anything about Footprint Navigator.",
    });
  }, [pushMsg]);

  const handleTellMeMore = useCallback(async () => {
    if (loading || step >= TOUR_STEPS.length) return;
    const q = TOUR_STEPS[step].question;
    pushMsg({ role: "user", content: `Tell me more about ${TOUR_STEPS[step].title}` });
    const answer  = await callAI(q, history);
    const newHist = [...history, { role: "user", content: q }, { role: "assistant", content: answer }];
    setHistory(newHist);
    pushMsg({ role: "assistant", content: answer, showNav: true });
  }, [loading, step, history, callAI, pushMsg]);

  const handleYes = useCallback(() => {
    const next = step + 1;
    if (next >= TOUR_STEPS.length) {
      setTourDone(true);
      pushMsg({
        role: "assistant",
        content: "That's the full tour! Footprint Navigator goes live July 1, 2026. Drop a PDF above to try it for yourself — and send any feedback to info@footprintnavigator.com.",
      });
    } else {
      setStep(next);
      const s = TOUR_STEPS[next];
      pushMsg({ role: "assistant", content: `Up next: **${s.title}** — ${s.teaser}`, showTellMore: true });
    }
  }, [step, pushMsg]);

  const handleNo = useCallback(() => {
    pushMsg({
      role: "assistant",
      content: "No problem. Feel free to ask me anything specific, or just explore on your own.",
    });
  }, [pushMsg]);

  const handleSend = useCallback(async () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    pushMsg({ role: "user", content: q });
    const newHist = [...history, { role: "user", content: q }];
    const answer  = await callAI(q, history);
    setHistory([...newHist, { role: "assistant", content: answer }]);
    pushMsg({ role: "assistant", content: answer, showNav: true });
  }, [input, loading, history, callAI, pushMsg]);

  const isLastMsg = (i) => i === messages.length - 1;

  return (
    <div className="ob-root">
      {/* Minimised trigger */}
      {!open && (
        <button className="ob-trigger" onClick={() => setOpen(true)} aria-label="Open Navigator chat">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span>Ask Navigator</span>
        </button>
      )}

      {/* Chat panel */}
      {open && (
        <div className="ob-panel" role="dialog" aria-label="Navigator onboarding chat">
          {/* Header */}
          <div className="ob-header">
            <div className="ob-header-left">
              <span className="ob-avatar" aria-hidden="true">N</span>
              <div className="ob-header-text">
                <span className="ob-name">Navigator</span>
                <span className="ob-sub">by Footprint Technologies</span>
              </div>
            </div>
            <button className="ob-close" onClick={() => setOpen(false)} aria-label="Close chat">×</button>
          </div>

          {/* Messages */}
          <div className="ob-messages" ref={scrollRef}>
            {messages.map((msg, i) => (
              <div key={i} className={`ob-msg ob-msg--${msg.role}`}>
                <div className="ob-bubble">{renderText(msg.content)}</div>

                {/* Welcome: Yes / Maybe later */}
                {msg.isWelcome && !tourStarted && isLastMsg(i) && (
                  <div className="ob-actions">
                    <button className="ob-btn ob-btn--primary" onClick={handleStartTour}>
                      Yes, show me around
                    </button>
                    <button className="ob-btn ob-btn--ghost" onClick={handleSkipTour}>
                      Maybe later
                    </button>
                  </div>
                )}

                {/* Tour step: Tell me more */}
                {msg.showTellMore && !loading && isLastMsg(i) && step < TOUR_STEPS.length && (
                  <div className="ob-actions">
                    <button className="ob-btn ob-btn--more" onClick={handleTellMeMore}>
                      Tell me more
                    </button>
                  </div>
                )}

                {/* After AI response: Yes / No nav */}
                {(msg.showNav || hasReadyPrompt(msg.content)) && !msg.isWelcome && !loading && isLastMsg(i) && (
                  <div className="ob-actions">
                    {!tourDone && (
                      <button className="ob-btn ob-btn--primary" onClick={handleYes}>Yes</button>
                    )}
                    <button className="ob-btn ob-btn--ghost" onClick={handleNo}>No</button>
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div className="ob-msg ob-msg--assistant">
                <div className="ob-bubble ob-typing">
                  <span/><span/><span/>
                </div>
              </div>
            )}
          </div>

          {/* Input row */}
          <div className="ob-input-row">
            <input
              ref={inputRef}
              className="ob-input"
              type="text"
              placeholder="Ask anything about Footprint Navigator…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              disabled={loading}
              aria-label="Chat input"
            />
            <button
              className="ob-send"
              onClick={handleSend}
              disabled={loading || !input.trim()}
              aria-label="Send message"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
