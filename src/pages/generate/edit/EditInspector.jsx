import { useState } from "react";
import { I } from "../../../icons.jsx";
import { barNumberLabel } from "./editRegions.js";

// Right-hand panel of the edit screen. It follows the selection: picked bars
// get the Redo controls, picked notes get note actions, nothing picked gets
// the how-to. Past redos stay listed underneath so any of them can be put back.

const KNOBS = [
  { key: "density", name: "Notes", options: ["less", "auto", "more"], labels: ["Fewer", "Auto", "More"] },
  { key: "chords", name: "Chords", options: ["less", "auto", "more"], labels: ["Fewer", "Auto", "More"] },
  { key: "movement", name: "Movement", options: ["less", "auto", "more"], labels: ["Less", "Auto", "More"] },
];

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Kbd({ children }) {
  return <kbd className="edit-kbd">{children}</kbd>;
}

export default function EditInspector({
  doc,
  bars,
  regions,
  selectionName,
  pending,
  knobs,
  onKnob,
  onRedo,
  onRedoToEnd,
  onCancelRedo,
  onClearRegions,
  onRemoveRegion,
  selectedNoteIds,
  onNoteAction,
  onFocusRedo,
  onPickRedo,
}) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  const tempo = doc?.tempoMap;
  const spanTime = (region) => `${fmtTime(tempo?.tickToSeconds(region.startTick))}–${fmtTime(tempo?.tickToSeconds(region.endTick))}`;
  const knobsSet = KNOBS.some((knob) => knobs[knob.key] !== "auto");
  const selectedIds = new Set(selectedNoteIds);
  const selectedNotes = doc?.notes.filter((note) => selectedIds.has(note.id)) || [];
  const chordCount = selectedNotes.filter((note) => !note.open && note.lanes.length > 1).length;
  const redos = doc?.redos || [];

  return (
    <aside className="edit-inspector">
      {pending ? (
        <section className="insp-card insp-running">
          <div className="insp-eyebrow">REDOING</div>
          <div className="insp-title">{pending.label}</div>
          <div className="insp-progress" style={{ "--p": pending.total ? pending.done / pending.total : 0 }}>
            <span />
          </div>
          <div className="insp-sub">Bar {Math.min(pending.done + 1, pending.total)} of {pending.total}</div>
          <button className="settings-secondary" onClick={onCancelRedo}>Cancel</button>
        </section>
      ) : regions.length ? (
        <section className="insp-card">
          <div className="insp-eyebrow-row">
            <div className="insp-eyebrow">REDO</div>
            <button className="insp-link" onClick={onClearRegions}>Clear</button>
          </div>
          <div className="insp-title">{selectionName}</div>
          <ul className="insp-regions">
            {regions.map((region) => (
              <li key={region.startTick}>
                <span>{barNumberLabel(bars, region)}</span>
                <span className="insp-mono">{spanTime(region)}</span>
                {regions.length > 1 && (
                  <button onClick={() => onRemoveRegion(region)} aria-label="Remove this spot"><I.minus /></button>
                )}
              </li>
            ))}
          </ul>
          <button className="btn-primary insp-redo" onClick={onRedo}>
            <I.spark /> Redo {selectionName}
          </button>
          <button className="settings-secondary" onClick={onRedoToEnd} title="Keep everything before this point and redo the rest of the song">
            Redo from here to the end
          </button>
          <button className={"insp-adjust" + (adjustOpen ? " open" : "")} onClick={() => setAdjustOpen((v) => !v)} aria-expanded={adjustOpen}>
            Adjust{knobsSet ? " ·" : ""} <I.chev />
          </button>
          {adjustOpen && (
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
          )}
          <p className="insp-hint">Start where the problem starts.</p>
        </section>
      ) : null}

      {selectedNotes.length > 0 && (
        <section className="insp-card">
          <div className="insp-eyebrow">{selectedNotes.length} NOTE{selectedNotes.length === 1 ? "" : "S"}</div>
          <div className="insp-actions">
            <button onClick={() => onNoteAction("tap")} data-tone="tap"><I.bolt /> Tap <Kbd>T</Kbd></button>
            <button onClick={() => onNoteAction("force")} data-tone="force"><I.chevsRight /> HOPO <Kbd>H</Kbd></button>
            <button onClick={() => onNoteAction("starPower")} data-tone="sp"><I.starOutline /> Star power <Kbd>S</Kbd></button>
            <button onClick={() => onNoteAction("solo")} data-tone="solo"><I.spark /> Solo</button>
            <button onClick={() => onNoteAction("quantize")}><I.grid /> Snap to grid <Kbd>Q</Kbd></button>
            <button onClick={() => onNoteAction("split")} disabled={!chordCount}><I.cut /> Split chord</button>
            <button onClick={() => onNoteAction("delete")} data-tone="danger"><I.trash /> Delete <Kbd>Del</Kbd></button>
          </div>
        </section>
      )}

      {!pending && !regions.length && !selectedNotes.length && (
        <section className="insp-card insp-idle">
          <div className="insp-eyebrow">REDO A PART</div>
          <p className="insp-lead">Drag across the bar numbers, or click a section name.</p>
          <p className="insp-sub">Shift adds another spot.</p>
          <div className="insp-eyebrow insp-gap">KEYS</div>
          <dl className="insp-keys">
            <dt><Kbd>V</Kbd><Kbd>D</Kbd><Kbd>E</Kbd></dt><dd>Select, draw, erase</dd>
            <dt><Kbd>Space</Kbd></dt><dd>Play / pause</dd>
            <dt><Kbd>L</Kbd></dt><dd>Loop</dd>
            <dt><Kbd>R</Kbd></dt><dd>Redo picked bars</dd>
            <dt><Kbd>Ctrl</Kbd><Kbd>Z</Kbd></dt><dd>Undo</dd>
            <dt><Kbd>Ctrl</Kbd>+wheel</dt><dd>Zoom</dd>
          </dl>
        </section>
      )}

      {redos.length > 0 && (
        <section className="insp-card insp-history">
          <div className="insp-eyebrow">REDOS</div>
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
        </section>
      )}
    </aside>
  );
}
