import { useEffect, useState } from "react";
import { I } from "../icons.jsx";
import { StartHighway } from "../pages/Start.jsx";
import { FRET_COLORS } from "../data/notePalette.js";

// The window updates and What's new open in: a big picture (the release's own,
// or the little highway), a headline, then whatever the release has to say,
// with its one button at the foot.
export default function ReleaseCard({ label, kicker, title, sub, image = "", footer, children, onClose }) {
  const [startAt] = useState(() => performance.now());

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="release-layer">
      <div className="release-scrim" onClick={onClose} aria-hidden="true" />
      <section className="release-card" role="dialog" aria-modal="true" aria-label={label}>
        <button type="button" className="release-close" onClick={onClose} aria-label={`Close ${label.toLowerCase()}`} title="Close (Esc)">
          <I.plus />
        </button>
        <div className="release-scroll">
          {image ? (
            <img className="release-hero-image" src={image} alt="" />
          ) : (
            <div className="release-hero" aria-hidden="true">
              <div className="release-hero-frets">
                {FRET_COLORS.map((color) => <i key={color} style={{ background: color }} />)}
              </div>
              <div className="release-hero-road">
                <StartHighway hot startAt={startAt} />
              </div>
            </div>
          )}
          <header className="release-head">
            {kicker && <span className="release-kicker">{kicker}</span>}
            <h2>{title}</h2>
            {sub && <p>{sub}</p>}
          </header>
          <div className="release-body">{children}</div>
        </div>
        {footer && <footer className="release-foot">{footer}</footer>}
      </section>
    </div>
  );
}

// What a release says, most important first: features as short rows (an
// icon, or the feature's own picture), then smaller changes and fixes in a
// quiet list that folds after a few lines.
const FIXES_SHOWN = 4;

export function ReleaseContent({ features = [], fixes = [] }) {
  const [allFixes, setAllFixes] = useState(false);
  const shownFixes = allFixes ? fixes : fixes.slice(0, FIXES_SHOWN);
  return (
    <>
      {features.length > 0 && (
        <ul className="release-features">
          {features.map((feature, index) => {
            const Icon = I[feature.icon] || I.star;
            return (
              <li key={feature.title} className="release-feature">
                <span className="release-feature-icon" style={{ "--gem": FRET_COLORS[index % FRET_COLORS.length] }} aria-hidden="true">
                  <Icon />
                </span>
                <span className="release-feature-copy">
                  <b>{feature.title}</b>
                  {feature.text && <span>{feature.text}</span>}
                </span>
                {feature.image && <img className="release-feature-image" src={feature.image} alt="" />}
              </li>
            );
          })}
        </ul>
      )}
      {fixes.length > 0 && (
        <div className="release-fixes">
          <b>Smaller changes and fixes</b>
          <ul>
            {shownFixes.map((fix) => <li key={fix}>{fix}</li>)}
          </ul>
          {fixes.length > FIXES_SHOWN && (
            <button type="button" className="release-link" onClick={() => setAllFixes((open) => !open)} aria-expanded={allFixes}>
              {allFixes ? "Show fewer" : `Show all ${fixes.length}`}
            </button>
          )}
        </div>
      )}
    </>
  );
}

// Opens in the browser, like every outside link in the app.
export function ReleaseNotesLink({ url }) {
  if (!url) return null;
  return (
    <a className="release-link" href={url} target="_blank" rel="noreferrer">
      Full release notes <I.open />
    </a>
  );
}
