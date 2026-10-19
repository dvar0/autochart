import { useState } from "react";
import { I } from "../../../icons.jsx";
import { barNumberLabel } from "./editRegions.js";

// Panel beside the preview. Its layout never changes: Redo, Notes and Redos
// are always there, and its buttons keep their colors whether or not anything
// is selected. Pressing one with nothing to act on shakes the selection box
// instead. A running redo shows its progress in place of the Redo button.

const KNOBS = [
  { key: "density", name: "Notes", options: ["less", "auto", "more"], labels: ["Fewer", "Auto", "More"] },
  { key: "chords", name: "Chords", options: ["less", "auto", "more"], labels: ["Fewer", "Auto", "More"] },
  { key: "movement", name: "Movement", options: ["less", "auto", "more"], labels: ["Less", "Auto", "More"] },
];

const NOTE_ACTIONS = [
  { id: "tap", label: "Tap", key: "T", icon: I.bolt, tone: "tap" },
  { id: "force", label: "HOPO", key: "H", icon: I.chevsRight, tone: "force" },
  { id: "starPower", label: "Star power", key: "S", icon: I.starOutline, tone: "sp" },
  { id: "solo", label: "Solo", icon: I.spark, tone: "solo" },
  { id: "quantize", label: "Snap to grid", key: "Q", icon: I.grid },
  { id: "split", label: "Split chord", icon: I.cut, needsChord: true },
];

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function EditInspector({
  doc,
  bars,
  regions,
  selectionName,
  selectedRedo,
  selectedNotes,
  pending,
  knobs,
  onKnob,
  onRedo,
  onRedoToEnd,
  onCancelRedo,
  onNoteAction,
  onFocusRedo,
  onFocusRegion,
  onPickRedo,
}) {
  const tempo = doc?.tempoMap;
  const redos = doc?.redos || [];
  const hasSelection = regions.length > 0;
  const hasChord = selectedNotes.some((note) => !note.open && note.lanes.length > 1);
  const [nudge, setNudge] = useState(0);
  const needsSelection = (ready, run) => () => (ready ? run() : setNudge((n) => n + 1));
  const spotLabel = (region) =>
    regions.length === 1
      ? `${barNumberLabel(bars, region)} · ${fmtTime(tempo?.tickToSeconds(region.startTick))}–${fmtTime(tempo?.tickToSeconds(region.endTick))}`
      : barNumberLabel(bars, region);

  return (
    <aside className="edit-inspector">
      <section className="insp-card">
        <div className="insp-eyebrow">REDO</div>
        <div key={nudge} className={"insp-target" + (hasSelection ? "" : " empty") + (nudge ? " nudge" : "")}>
          <b>{hasSelection ? selectionName : "Nothing selected"}</b>
          {hasSelection ? (
            <div className="insp-spots">
              {regions.map((region) => (
                <button key={region.startTick} onClick={() => onFocusRegion(region)} title="Show it">
                  {spotLabel(region)}
                </button>
              ))}
            </div>
          ) : (
            <span>Drag across the roll or click a section.</span>
          )}
        </div>
        {pending ? (
          <div className="insp-running">
            <div className="insp-progress" style={{ "--p": pending.total ? pending.done / pending.total : 0 }}>
              <span />
            </div>
            <div className="insp-running-row">
              <span>Bar {Math.min(pending.done + 1, pending.total)} of {pending.total}</span>
              <button className="insp-link" onClick={onCancelRedo}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="insp-redo-buttons">
            <button className="btn-primary insp-redo" onClick={needsSelection(hasSelection, onRedo)} title="Redo (R)">
              <I.spark /> Redo
            </button>
          </div>
        )}
        <div className="insp-redo-row">
          <div className="insp-takes" data-on={selectedRedo ? "" : undefined}>
            <button
              onClick={() => onPickRedo(selectedRedo, selectedRedo.active - 1)}
              disabled={!selectedRedo || selectedRedo.active < 0}
              title="Previous take"
            >
              <I.chevLeft />
            </button>
            <span>{!selectedRedo || selectedRedo.active < 0 ? "Original" : `Take ${selectedRedo.active + 1} of ${selectedRedo.takes.length}`}</span>
            <button
              onClick={() => onPickRedo(selectedRedo, selectedRedo.active + 1)}
              disabled={!selectedRedo || selectedRedo.active >= selectedRedo.takes.length - 1}
              title="Next take"
            >
              <I.chevRight />
            </button>
          </div>
          <button className="settings-secondary" onClick={onRedoToEnd} title="Keep everything before this point and redo the rest of the song">
            Redo to the end
          </button>
        </div>
        <div className="insp-knobs">
          {KNOBS.map((knob) => (
            <div className="insp-knob" key={knob.key}>
              <span>{knob.name}</span>
              <div className="insp-seg" role="radiogroup" aria-label={knob.name}>
                {knob.options.map((option, index) => (
                  <button
                    key={option}
                    className={knobs[knob.key] === option ? "active" : ""}
                    onClick={() => onKnob(knob.key, option)}
                    role="radio"
                    aria-checked={knobs[knob.key] === option}
                  >
                    {knob.labels[index]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="insp-card">
        <div className="insp-eyebrow">
          NOTES{selectedNotes.length ? <span className="insp-count">{selectedNotes.length} selected</span> : null}
        </div>
        <div className="insp-note-grid">
          {NOTE_ACTIONS.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.id}
                data-tone={action.tone}
                onClick={needsSelection(selectedNotes.length && (!action.needsChord || hasChord), () => onNoteAction(action.id))}
                title={action.key ? `${action.label} (${action.key})` : action.label}
              >
                <Icon /> {action.label}
              </button>
            );
          })}
          <button
            className="insp-note-delete"
            data-tone="danger"
            onClick={needsSelection(selectedNotes.length, () => onNoteAction("delete"))}
            title="Delete (Del)"
          >
            <I.trash /> Delete
          </button>
        </div>
      </section>

      <section className="insp-card insp-history">
        <div className="insp-eyebrow">REDOS</div>
        {redos.length ? (
          <ul>
            {[...redos].reverse().map((redo) => (
              <li key={redo.id}>
                <button
                  className={"insp-history-name" + (redo === selectedRedo ? " active" : "")}
                  onClick={() => onFocusRedo(redo)}
                  title="Select it"
                >
                  <b>{redo.label}</b>
                  <span>{redo.active < 0 ? "Original" : `Take ${redo.active + 1} of ${redo.takes.length}`}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="insp-sub">Nothing redone yet.</p>
        )}
      </section>
    </aside>
  );
}
