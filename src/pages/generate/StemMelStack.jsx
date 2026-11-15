import { t } from "../../i18n/index.js";
import { stemCombo, stemParts } from "./stemSets.js";

// The Separation stage with every stem on screen: the mix and each stem as a
// row of its mel graph, the one being heard grown to fill most of the stage.
// Clicking another row plays it from the same moment; clicking a heard row
// seeks. Shift-click adds a stem to the ones playing, or takes it out.
export default function StemMelStack({ graphs, rows, heard, loading, progress, onPick, onSeek }) {
  const heardIds = heard === "mix" ? ["mix"] : stemParts(heard);
  // The stems being made ready; a spinner on each one not heard yet.
  const loadingIds = stemParts(loading).filter((id) => !heardIds.includes(id));
  const stemRows = rows.filter((row) => row.id !== "mix");
  const toggle = (row) => {
    const ids = heardIds.includes(row.id) ? heardIds.filter((id) => id !== row.id) : [...heardIds, row.id];
    if (ids.length) onPick(stemCombo(ids, stemRows));
  };
  const pick = (row) => (e) => {
    if (row.disabled) return;
    if (e.shiftKey && row.id !== "mix" && heardIds.length && heard !== "mix") {
      toggle(row);
    } else if (heardIds.includes(row.id)) {
      const rect = e.currentTarget.getBoundingClientRect();
      onSeek(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
    } else {
      onPick(row.id);
    }
  };
  return (
    <div className="stem-stack-panel">
      <div className="stem-stack-hint" aria-hidden={Boolean(heard)}>
        {heard ? "" : t("Click a stem to listen")}
      </div>
      <div className={"stem-stack" + (heardIds.length > 1 ? " is-layered" : "")} role="group" aria-label={t("Stems from the selected separation")}>
        {rows.map((row) => {
          const image = graphs?.images?.[row.graph || row.id];
          const on = heardIds.includes(row.id);
          return (
            <button
              key={row.id}
              type="button"
              className={"stem-row" + (on ? " on" : "") + (row.disabled ? " is-off" : "")}
              style={{ "--stem": row.color }}
              onPointerDown={(e) => {
                if (e.button === 0) pick(row)(e);
              }}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && !row.disabled) {
                  e.preventDefault();
                  if (e.shiftKey && row.id !== "mix" && heardIds.length && heard !== "mix") toggle(row);
                  else if (!on) onPick(row.id);
                }
              }}
              aria-pressed={on}
              title={
                row.disabled
                  ? row.title
                  : on
                    ? t("Click to jump there")
                    : row.id === "mix"
                      ? t("Listen to {stem}", { stem: row.label })
                      : t("Listen to {stem}. Shift-click to add it to what's playing.", { stem: row.label })
              }
            >
              {image && <img src={image} alt="" draggable={false} />}
              <span className="stem-row-tag">
                {loadingIds.includes(row.id) ? <span className="cta-spinner" aria-hidden="true" /> : <span className="stem-row-swatch" />}
                {row.label}
              </span>
            </button>
          );
        })}
        <div className="stem-stack-playhead" style={{ "--at": Math.max(0, Math.min(1, progress || 0)) }} aria-hidden="true" />
      </div>
    </div>
  );
}
