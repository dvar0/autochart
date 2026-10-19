import { I } from "../../../icons.jsx";
import { barNumberLabel } from "./editRegions.js";

// Panel beside the preview. Its layout never changes: Redo, Notes and Redos
// are always there, and controls turn on and off with the selection instead
// of appearing and disappearing. A running redo shows its progress in place
// of the Redo button.

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
  selectedNotes,
  pending,
  knobs,
  onKnob,
  onRedo,
  onRedoToEnd,
  onCancelRedo,
  onNoteAction,
  onFocusRedo,
  onPickRedo,
}) {
  const tempo = doc?.tempoMap;
  const redos = doc?.redos || [];
  const hasSelection = regions.length > 0;
  const hasChord = selectedNotes.some((note) => !note.open && note.lanes.length > 1);
  const where = hasSelection
    ? regions.length === 1
      ? `${barNumberLabel(bars, regions[0])} · ${fmtTime(tempo?.tickToSeconds(regions[0].startTick))}–${fmtTime(tempo?.tickToSeconds(regions[0].endTick))}`
      : regions.map((region) => barNumberLabel(bars, region).replace("Bars ", "").replace("Bar ", "")).join(", ")
    : "";

  return (
    <aside className="edit-inspector">
      <section className="insp-card">
        <div className="insp-eyebrow">REDO</div>
        <div className={"insp-target" + (hasSelection ? "" : " empty")}>
          <b>{hasSelection ? selectionName : "Nothing selected"}</b>
          <span>{hasSelection ? where : "Select notes or a section. Shift adds more."}</span>
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
            <button className="btn-primary insp-redo" onClick={onRedo} disabled={!hasSelection} title="Redo (R)">
              <I.spark /> Redo
            </button>
            <button className="settings-secondary" onClick={onRedoToEnd} title="Keep everything before this point and redo the rest of the song">
              Redo to the end
            </button>
          </div>
        )}
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
                onClick={() => onNoteAction(action.id)}
                disabled={!selectedNotes.length || (action.needsChord && !hasChord)}
                title={action.key ? `${action.label} (${action.key})` : action.label}
              >
                <Icon /> {action.label}
              </button>
            );
          })}
          <button
            className="insp-note-delete"
            data-tone="danger"
            onClick={() => onNoteAction("delete")}
            disabled={!selectedNotes.length}
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
                <button className="insp-history-name" onClick={() => onFocusRedo(redo)} title="Show it">
                  <b>{redo.label}</b>
                  <span>{redo.active < 0 ? "Original" : `Take ${redo.active + 1} of ${redo.takes.length}`}</span>
                </button>
                <button
                  className={"insp-history-undo" + (redo.active < 0 ? " on" : "")}
                  onClick={() => onPickRedo(redo, redo.active < 0 ? redo.takes.length - 1 : -1)}
                  title={redo.active < 0 ? "Bring the redo back" : "Put the original notes back"}
                >
                  {redo.active < 0 ? <I.redo /> : <I.undo />}
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
