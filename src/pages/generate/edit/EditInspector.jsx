import { useEffect, useState } from "react";
import { I } from "../../../icons.jsx";
import WorkTabs from "../WorkTabs.jsx";
import { barNumberLabel } from "./editRegions.js";

// The right rail on the Regenerate (pick bars, make new takes of them) and
// Edit (change single notes) tabs. The tab also sets what the piano roll
// does. Inside a tab the layout never changes, and its buttons keep their
// colors whether or not anything is selected: pressing one with nothing to
// act on shakes the selection box instead. A running regenerate shows its
// progress in place of its button.

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

const SNAP_OPTIONS = ["off", "1/4", "1/8", "1/12", "1/16", "1/24", "1/32"];

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function EditInspector({ project, ws }) {
  const { editor, setEditorSnap, statusMsg, busyAction } = project;
  // statusMsg stays put on the Generate rail; here it clears itself.
  const [toast, setToast] = useState("");
  useEffect(() => {
    setToast(statusMsg || "");
    if (!statusMsg) return undefined;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [statusMsg]);
  return (
    <aside className="console-rail edit-inspector">
      <WorkTabs project={project} />
      {ws.tab === "regen" ? (
        <RegenTab
          doc={ws.doc}
          bars={ws.bars}
          regions={ws.regions}
          selectionName={ws.selectionName}
          selectedRedo={ws.selectedRedo}
          pending={ws.pending}
          blockedReason={ws.regenBlockedReason}
          knobs={ws.knobs}
          confirm={ws.confirm}
          onConfirm={ws.confirmOverwrite}
          onCancelConfirm={ws.cancelOverwrite}
          onKnob={ws.setKnob}
          onRedo={ws.redoSelection}
          onRemoveArea={ws.removeArea}
          onClearAreas={() => ws.setRegions([])}
          onCancelRedo={ws.cancelRedo}
          onFocusRedo={ws.focusRedo}
          onFocusRegion={(region) => ws.focusTick(region.startTick)}
          onPickRedo={ws.pickRedoTake}
        />
      ) : (
        <NotesTab
          bars={ws.bars}
          selectedNotes={ws.selectedNotes}
          snap={editor.snap}
          onSnap={setEditorSnap}
          onNoteAction={ws.noteAction}
        />
      )}
      {toast && busyAction !== "generating" && <div className="rail-toast">{toast}</div>}
    </aside>
  );
}

// Asks before a regenerate or a take switch writes over notes changed by
// hand. It sits over the Regenerate card's buttons, so nothing moves.
function OverwriteConfirm({ confirm, bars, onConfirm, onCancel }) {
  const where = confirm.regions.map((region) => barNumberLabel(bars, region).toLowerCase()).join(", ");
  return (
    <div className="insp-confirm" role="alertdialog" aria-labelledby="insp-confirm-title" aria-describedby="insp-confirm-body">
      <b id="insp-confirm-title">Replace your edits?</b>
      <p id="insp-confirm-body">You changed notes in {where}.</p>
      <div className="insp-confirm-actions">
        <button className="settings-secondary" onClick={onCancel} title="Esc">Cancel</button>
        <button className="btn-primary" onClick={onConfirm} title="Enter" autoFocus>
          {confirm.kind === "take" ? "Switch take" : <><I.spark /> Regenerate</>}
        </button>
      </div>
    </div>
  );
}

function useNudge() {
  const [nudge, setNudge] = useState(0);
  const needs = (ready, run) => () => (ready ? run() : setNudge((n) => n + 1));
  return [nudge, needs];
}

function RegenTab({
  doc,
  bars,
  regions,
  selectionName,
  selectedRedo,
  pending,
  blockedReason,
  knobs,
  confirm,
  onConfirm,
  onCancelConfirm,
  onKnob,
  onRedo,
  onRemoveArea,
  onClearAreas,
  onCancelRedo,
  onFocusRedo,
  onFocusRegion,
  onPickRedo,
}) {
  const tempo = doc?.tempoMap;
  const redos = doc?.redos || [];
  const hasSelection = regions.length > 0;
  const [nudge, needsSelection] = useNudge();
  const spotLabel = (region) =>
    regions.length === 1
      ? `${barNumberLabel(bars, region)} · ${fmtTime(tempo?.tickToSeconds(region.startTick))}–${fmtTime(tempo?.tickToSeconds(region.endTick))}`
      : barNumberLabel(bars, region);

  return (
    <>
      <section className="insp-card insp-regen-card">
        {confirm && <OverwriteConfirm confirm={confirm} bars={bars} onConfirm={onConfirm} onCancel={onCancelConfirm} />}
        <div key={nudge} className={"insp-target" + (hasSelection ? "" : " empty") + (nudge ? " nudge" : "")}>
          <div className="insp-target-head">
            <b>{hasSelection ? selectionName : "Nothing selected"}</b>
            <button className="insp-link" onClick={onClearAreas} disabled={!hasSelection}>Clear</button>
          </div>
          {/* One fixed-height row holds the hint or the area chips, so the box
              keeps its size; extra chips scroll sideways instead of wrapping. */}
          {hasSelection ? (
            <div className="insp-target-row insp-spots">
              {regions.map((region) => (
                <span className="insp-spot" key={region.startTick}>
                  <button onClick={() => onFocusRegion(region)} title="Show it">
                    {spotLabel(region)}
                  </button>
                  <button className="insp-spot-x" onClick={() => onRemoveArea(region)} title="Remove" aria-label="Remove">
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <div className="insp-target-row"><span>Drag across the roll or click a section.</span></div>
          )}
        </div>
        {pending ? (
          <div className="insp-running">
            <div className="insp-progress" style={{ "--p": pending.total ? pending.done / pending.total : 0 }}>
              <span />
            </div>
            <div className="insp-running-row">
              <span>{pending.done ? `${Math.round((100 * pending.done) / pending.total)}%` : "Loading the song"}</span>
              <button className="insp-link" onClick={onCancelRedo}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="insp-redo-buttons">
            <button
              className="btn-primary insp-redo"
              onClick={needsSelection(hasSelection, onRedo)}
              disabled={Boolean(blockedReason)}
              title={blockedReason || "Regenerate (R)"}
            >
              <I.spark /> Regenerate
            </button>
          </div>
        )}
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
      </section>

      <section className="insp-card">
        <div className="insp-eyebrow">STYLE</div>
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

      <section className="insp-card insp-history">
        <div className="insp-eyebrow">HISTORY</div>
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
          <p className="insp-sub">Nothing regenerated yet.</p>
        )}
      </section>
    </>
  );
}

function NotesTab({ bars, selectedNotes, snap, onSnap, onNoteAction }) {
  const [nudge, needsSelection] = useNudge();
  const count = selectedNotes.length;
  const hasChord = selectedNotes.some((note) => !note.open && note.lanes.length > 1);
  const span = count
    ? barNumberLabel(bars, {
      startTick: Math.min(...selectedNotes.map((note) => note.tick)),
      endTick: Math.max(...selectedNotes.map((note) => note.tick)) + 1,
    })
    : "";

  return (
    <section className="insp-card">
      <div key={nudge} className={"insp-target" + (count ? "" : " empty") + (nudge ? " nudge" : "")}>
        <b>{count ? `${count} note${count === 1 ? "" : "s"}` : "Nothing selected"}</b>
        <span>{count ? span : "Click to add a note, drag to select."}</span>
      </div>
      <div className="insp-note-grid">
        {NOTE_ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.id}
              data-tone={action.tone}
              onClick={needsSelection(count && (!action.needsChord || hasChord), () => onNoteAction(action.id))}
              title={action.key ? `${action.label} (${action.key})` : action.label}
            >
              <Icon /> {action.label}
            </button>
          );
        })}
        <button
          className="insp-note-delete"
          data-tone="danger"
          onClick={needsSelection(count, () => onNoteAction("delete"))}
          title="Delete (Del)"
        >
          <I.trash /> Delete
        </button>
      </div>
      <div className="insp-knob">
        <span>Grid</span>
        <label className="edit-snap" title="New and moved notes snap to this grid">
          <I.grid />
          <select value={snap} onChange={(e) => onSnap(e.target.value)} aria-label="Grid">
            {SNAP_OPTIONS.map((option) => (
              <option key={option} value={option}>{option === "off" ? "Free" : option}</option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
