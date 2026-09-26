// Right-rail palette shown while the deck is in EDIT mode. Replaces the
// generation controls with the note-editing toolbox.

import { I } from "../../../icons.jsx";

const TOOLS = [
  { id: "select", label: "Select", hint: "Move, select, drag sustains", icon: I.open },
  { id: "draw", label: "Draw", hint: "Click to add notes; drag for sustain", icon: I.pencil },
  { id: "erase", label: "Erase", hint: "Drag notes to delete; tails and SP/SOLO ranges to trim", icon: I.trash },
  { id: "tap", label: "Tap", hint: "Toggle tap on a note/chord", icon: I.bolt },
  { id: "force", label: "Hammer On/Off", hint: "Toggle forced hammer-on/pull-off on a note/chord", icon: I.chevsRight },
  { id: "starPower", label: "Star Power", hint: "Drag to paint a SP phrase", icon: I.starOutline },
  { id: "solo", label: "Solo", hint: "Drag to mark a solo section", icon: I.spark },
  { id: "sustainCut", label: "Cut Sustain", hint: "Click a sustain tail to trim it", icon: I.cut },
];

const SNAP_OPTIONS = ["off", "1/8", "1/12", "1/16", "1/24", "1/32"];

function editorWarnings(doc) {
  if (!doc) return ["This take has no chart to edit."];
  const warnings = [];
  const noteTicks = doc.notes.filter((n) => n.open || n.lanes.length).map((n) => n.tick);
  for (const range of doc.ranges) {
    if (range.endTick <= range.startTick) continue;
    if (range.kind === "starPower") {
      const hasNote = noteTicks.some((tick) => tick >= range.startTick && tick < range.endTick);
      if (!hasNote) warnings.push("A star power phrase contains no notes.");
    }
  }
  if (!doc.notes.some((n) => n.open || n.lanes.length)) warnings.push("This difficulty has no notes.");
  return warnings;
}

export default function EditorConsole({ project }) {
  const {
    editor,
    applyEditorChange,
    setEditorTool,
    setEditorSnap,
    saveEditorDraft,
    discardEditorDraft,
    finishEditing,
    undoEditorChange,
    redoEditorChange,
    busyAction,
  } = project;
  const { doc, tool, snap, dirty, canUndo, canRedo, selectedNoteIds, sourceVersion, draftVersion } = editor;
  const saving = busyAction === "saving-edit";
  const warnings = editorWarnings(doc);
  const name = draftVersion?.name || sourceVersion?.name || "Editing take";
  const selectedIds = new Set(selectedNoteIds);
  const selectedChordCount = doc?.notes.filter((note) => selectedIds.has(note.id) && !note.open && note.lanes.length > 1).length || 0;

  return (
    <section className="rail-sec editor-console">
      <div className="rail-sec-head">
        <span className="gen-head">EDIT</span>
      </div>

      <div className="editor-name-plate">
        <small>EDITING</small>
        <b title={name}>{name}</b>
        {sourceVersion && draftVersion && (
          <span className="editor-from">from {sourceVersion.name}</span>
        )}
      </div>

      <div className="editor-tool-grid" role="radiogroup" aria-label="Editor tool">
        {TOOLS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={"editor-tool" + (tool === item.id ? " active" : "")}
              data-tool={item.id}
              onClick={() => setEditorTool(item.id)}
              role="radio"
              aria-checked={tool === item.id}
              title={item.hint}
            >
              <Icon />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      <div className="editor-row">
        <label className="editor-field">
          <span>Snap</span>
          <select value={snap} onChange={(e) => setEditorSnap(e.target.value)}>
            {SNAP_OPTIONS.map((option) => (
              <option key={option} value={option}>{option === "off" ? "Off" : option}</option>
            ))}
          </select>
        </label>
        <div className="editor-undo-row">
          <button onClick={undoEditorChange} disabled={!canUndo} title="Undo (Ctrl+Z)"><I.undo /> Undo</button>
          <button onClick={redoEditorChange} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)"><I.redo /> Redo</button>
        </div>
      </div>

      <button
        className="editor-action ghost"
        onClick={() => applyEditorChange({ type: "quantizeSelection", ids: selectedNoteIds, snap })}
        disabled={snap === "off"}
        title={snap === "off" ? "Choose a snap value first" : "Snap selected notes to the grid"}
      >
        <I.grid />
        Quantize {selectedNoteIds.length ? `${selectedNoteIds.length} selected` : "all"}
      </button>

      <button
        className="editor-action ghost"
        onClick={() => applyEditorChange({ type: "splitChords", ids: selectedNoteIds, snap })}
        disabled={!selectedChordCount}
        title={selectedChordCount ? "Separate selected chord lanes onto consecutive snap positions" : "Select a chord to unlink its lanes"}
      >
        <I.chevsRight />
        Unlink {selectedChordCount > 1 ? `${selectedChordCount} chords` : "chord"}
      </button>

      {warnings.length > 0 && (
        <div className="editor-validation">
          {warnings.map((warning, index) => (
            <div key={index} className="editor-warning">{warning}</div>
          ))}
        </div>
      )}

      <div className="editor-save-actions">
        <button className="editor-action primary" onClick={saveEditorDraft} disabled={saving || !dirty}>
          <I.check />
          {saving ? "Saving…" : "Save Draft"}
        </button>
        <div className="editor-save-secondary">
          <button className="editor-action ghost" onClick={discardEditorDraft} disabled={saving}>
            <I.trash />
            Discard
          </button>
          <button className="editor-action ghost" onClick={finishEditing} disabled={saving}>
            Done
            <I.chevRight />
          </button>
        </div>
      </div>
    </section>
  );
}
