// A small ring for busy states: fills with `value` (0..100), or turns as a
// short arc when there is no number yet.
export default function ProgressRing({ value = null, className = "" }) {
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const known = Number.isFinite(value);
  const pct = known ? Math.max(4, Math.min(100, value)) : 28;
  return (
    <svg
      className={"progress-ring" + (known ? "" : " is-indeterminate") + (className ? " " + className : "")}
      viewBox="0 0 18 18"
      aria-hidden="true"
    >
      <circle className="progress-ring-track" cx="9" cy="9" r={r} />
      <circle
        className="progress-ring-fill"
        cx="9"
        cy="9"
        r={r}
        strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
      />
    </svg>
  );
}
