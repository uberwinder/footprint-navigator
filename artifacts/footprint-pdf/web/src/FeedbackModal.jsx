import { useState } from "react";

const RATE_FEATURES = [
  "PDF Upload",
  "Sheet and Thumbnail Detection",
  "Keyword Search",
  "Length Measurement",
  "Area Measurement",
  "Perimeter Measurement",
  "Angle Measurement",
  "Navigator AI Chat",
  "Page Navigation",
  "Zoom and Pan",
  "Overall Experience",
];

const SCORE_TIPS = ["Did not use", "Bad", "Poor", "Fair", "Good", "Excellent"];

const INITIAL_RATINGS = Object.fromEntries(RATE_FEATURES.map((f) => [f, null]));

export default function FeedbackModal({ onClose }) {
  const [info, setInfo] = useState({ firstName: "", lastName: "", email: "", company: "" });
  const [ratings, setRatings] = useState(INITIAL_RATINGS);
  const [openFeedback, setOpenFeedback] = useState("");
  const [loading, setLoading]   = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError]       = useState("");

  const setScore = (feature, score) => {
    setRatings((r) => ({ ...r, [feature]: score }));
  };

  const handleSkip = () => onClose();

  const handleSubmit = async () => {
    setLoading(true);
    setError("");
    const payload = {
      firstName:    info.firstName.trim() || undefined,
      lastName:     info.lastName.trim()  || undefined,
      email:        info.email.trim()     || undefined,
      company:      info.company.trim()   || undefined,
      ratings:      Object.fromEntries(
        Object.entries(ratings).filter(([, v]) => v !== null)
      ),
      openFeedback: openFeedback.trim()   || undefined,
    };
    try {
      const res  = await fetch("/pdf-api/feedback", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Server error");
      setSubmitted(true);
      setTimeout(() => onClose(), 3000);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fbk-overlay" role="dialog" aria-modal="true" aria-label="Feedback form">
      <div className="fbk-card">

        {/* Header */}
        <div className="fbk-header">
          <div>
            <h2 className="fbk-title">How did we do?</h2>
            <p className="fbk-subtitle">
              This is a pre-launch demo. Your feedback helps us build a better product. Takes 60 seconds.
            </p>
          </div>
          <button className="fbk-close" onClick={handleSkip} aria-label="Skip feedback">×</button>
        </div>

        {/* Body */}
        {submitted ? (
          <div className="fbk-thankyou">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="10" stroke="#007BFF" strokeWidth="2"/>
              <path d="M7 12l4 4 6-7" stroke="#007BFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <p>Thank you — your feedback goes directly to our team. We read every submission.</p>
          </div>
        ) : (
          <div className="fbk-body">

            {/* User info */}
            <section className="fbk-section">
              <div className="fbk-row-2">
                <label className="fbk-field">
                  <span className="fbk-label">First Name</span>
                  <input className="fbk-input" type="text" placeholder="Jane"
                    value={info.firstName} onChange={(e) => setInfo((i) => ({ ...i, firstName: e.target.value }))} />
                </label>
                <label className="fbk-field">
                  <span className="fbk-label">Last Name</span>
                  <input className="fbk-input" type="text" placeholder="Smith"
                    value={info.lastName} onChange={(e) => setInfo((i) => ({ ...i, lastName: e.target.value }))} />
                </label>
              </div>
              <div className="fbk-row-2">
                <label className="fbk-field">
                  <span className="fbk-label">Work Email</span>
                  <input className="fbk-input" type="email" placeholder="jane@company.com"
                    value={info.email} onChange={(e) => setInfo((i) => ({ ...i, email: e.target.value }))} />
                </label>
                <label className="fbk-field">
                  <span className="fbk-label">Company</span>
                  <input className="fbk-input" type="text" placeholder="Acme Corp"
                    value={info.company} onChange={(e) => setInfo((i) => ({ ...i, company: e.target.value }))} />
                </label>
              </div>
            </section>

            {/* Ratings */}
            <section className="fbk-section">
              <div className="fbk-rating-legend">
                <span className="fbk-legend-label">Feature</span>
                <div className="fbk-legend-scores">
                  {SCORE_TIPS.map((tip, i) => (
                    <span key={i} className={`fbk-legend-score ${i === 0 ? "fbk-legend-score--zero" : ""}`}>{i}</span>
                  ))}
                </div>
              </div>
              {RATE_FEATURES.map((feature) => (
                <div className="fbk-rating-row" key={feature}>
                  <span className="fbk-feature-name">{feature}</span>
                  <div className="fbk-score-btns">
                    {SCORE_TIPS.map((tip, score) => (
                      <button
                        key={score}
                        className={`fbk-score-btn ${ratings[feature] === score ? "fbk-score-btn--active" : ""} ${score === 0 ? "fbk-score-btn--zero" : ""}`}
                        title={tip}
                        onClick={() => setScore(feature, score)}
                        type="button"
                      >
                        {score === 0 ? "N/A" : score}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </section>

            {/* Open feedback */}
            <section className="fbk-section">
              <label className="fbk-field">
                <span className="fbk-label">Anything else? What worked, what did not, or what would you like to see added?</span>
                <textarea
                  className="fbk-textarea"
                  rows={4}
                  placeholder="Type anything here..."
                  value={openFeedback}
                  onChange={(e) => setOpenFeedback(e.target.value)}
                />
              </label>
            </section>

            {/* Actions */}
            {error && <p className="fbk-error">{error}</p>}
            <div className="fbk-actions">
              <button className="fbk-submit" onClick={handleSubmit} disabled={loading}>
                {loading ? "Sending…" : "Send Feedback"}
              </button>
              <button className="fbk-skip" onClick={handleSkip} type="button">Skip for now</button>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
