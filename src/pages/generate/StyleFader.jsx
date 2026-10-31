import { useRef, useState } from "react";
import { DESCRIPTOR_KNOB_MAX } from "../../data/generationSettings.js";
import { t } from "../../i18n/index.js";

// Fret colors, one per style knob, in lane order.
export const KNOB_COLORS = ["var(--fret-g)", "var(--fret-r)", "var(--fret-y)", "var(--fret-b)", "var(--fret-o)"];

// Stops from the bottom: 0 is "auto" (its own bay, not a magnitude), then the
// model's bins 0..6 stacked above it.
const STOPS = DESCRIPTOR_KNOB_MAX + 2;

function knobStop(raw) {
  return raw === "auto" || raw == null ? 0 : Number(raw) + 1;
}

function stopValue(stop) {
  return stop <= 0 ? "auto" : String(Math.min(DESCRIPTOR_KNOB_MAX, stop - 1));
}

// One vertical mini fader. Click a segment to set the level (or drag along
// the column); the bottom bay is auto. Hovering previews where a click lands.
// Arrow keys step it.
export default function StyleFader({ knob, color, raw, disabled, onChange }) {
  const trackRef = useRef(null);
  const [hoverStop, setHoverStop] = useState(null);
  const stop = knobStop(raw);
  const isAuto = stop === 0;
  const previewing = hoverStop != null && !disabled;

  // The stop whose segment (or the bay) sits nearest the pointer.
  const stopAt = (clientY) => {
    let best = 0;
    let bestDistance = Infinity;
    for (const el of trackRef.current.querySelectorAll("[data-stop]")) {
      const rect = el.getBoundingClientRect();
      const distance = Math.abs(clientY - (rect.top + rect.height / 2));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = Number(el.dataset.stop);
      }
    }
    return best;
  };
  const set = (next) => {
    const value = stopValue(next);
    if (value !== (raw ?? "auto")) onChange(value);
  };

  return (
    <div
      className={"style-fader" + (isAuto ? " is-auto" : "")}
      style={{ "--knob-color": color }}
      title={t("{name}: {hint} ({low} → {high}). Auto lets the model choose.", { name: t(knob.name), hint: t(knob.hint), low: t(knob.ends[0]), high: t(knob.ends[1]) })}
    >
      <span className="style-fader-value">{isAuto ? "" : raw}</span>
      <div
        ref={trackRef}
        className="style-fader-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={t(knob.name)}
        aria-valuemin={0}
        aria-valuemax={STOPS - 1}
        aria-valuenow={stop}
        aria-valuetext={isAuto ? t("auto") : String(raw)}
        aria-disabled={disabled}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          set(stopAt(e.clientY));
        }}
        onPointerMove={(e) => {
          if (disabled) return;
          const next = stopAt(e.clientY);
          setHoverStop(next);
          if (e.currentTarget.hasPointerCapture(e.pointerId)) set(next);
        }}
        onPointerLeave={() => setHoverStop(null)}
        onKeyDown={(e) => {
          if (disabled) return;
          const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
          if (e.key === "Home") set(0);
          else if (e.key === "End") set(STOPS - 1);
          else if (step) set(Math.max(0, Math.min(STOPS - 1, stop + step)));
          else return;
          e.preventDefault();
        }}
      >
        <div className={"style-seg-stack" + (isAuto ? " is-auto" : "") + (previewing ? " is-previewing" : "")}>
          {Array.from({ length: STOPS - 1 }, (_, bin) => {
            const on = bin < stop;
            const willBeOn = previewing && bin < hoverStop;
            return (
              <span
                key={bin}
                data-stop={bin + 1}
                className={
                  "style-seg" +
                  (on ? " on" : "") +
                  (previewing && !on && willBeOn ? " is-preview-on" : "") +
                  (previewing && on && !willBeOn ? " is-preview-off" : "")
                }
                aria-hidden="true"
              />
            );
          }).reverse()}
        </div>
        <span data-stop={0} className={"style-bay" + (isAuto ? " on" : "") + (previewing && hoverStop === 0 && !isAuto ? " is-preview" : "")} aria-hidden="true">{t("auto")}</span>
      </div>
      <FaderName text={t(knob.short || knob.name)} />
    </div>
  );
}

// Some languages run longer than the fader is wide; those names get a size
// smaller instead of an ellipsis.
function FaderName({ text }) {
  return <span className={"style-fader-name" + (text.length > 9 ? " is-long" : "")}>{text}</span>;
}
