// Mouse and key reference for the open tab, opened from the ? in the stage head
// so the screen itself stays free of instructions.
export default function EditHelp({ tab }) {
  const Kbd = ({ children }) => <kbd className="edit-kbd">{children}</kbd>;
  return (
    <div className="edit-menu edit-help">
      <div className="insp-eyebrow">MOUSE</div>
      {tab === "regen" ? (
        <dl className="insp-keys">
          <dt>Click a section or bar</dt><dd>Pick it, or unpick it</dd>
          <dt>Click or drag the timeline</dt><dd>Move the playhead</dd>
          <dt>[ ] on the timeline</dt><dd>What the roll shows</dd>
          <dt><Kbd>Alt</Kbd> + drag the timeline</dt><dd>Don't snap to sections</dd>
          <dt>Drag across the roll</dt><dd>Pick bars</dd>
          <dt>Drag over picked bars</dt><dd>Unpick them</dd>
          <dt>Right-drag</dt><dd>Unpick bars</dd>
          <dt>Drag a bar-row block</dt><dd>Move that area</dd>
          <dt>Drag its grips</dt><dd>Stretch it</dd>
          <dt>Click its arrow</dt><dd>Stretch it to the end</dd>
          <dt>Wheel</dt><dd>Scroll the roll</dd>
          <dt><Kbd>Ctrl</Kbd> + wheel</dt><dd>Zoom</dd>
        </dl>
      ) : (
        <dl className="insp-keys">
          <dt>Click a section</dt><dd>Jump to it</dd>
          <dt>Click or drag the timeline</dt><dd>Move the playhead</dd>
          <dt>[ ] on the timeline</dt><dd>What the roll shows</dd>
          <dt><Kbd>Alt</Kbd> + drag the timeline</dt><dd>Don't snap to sections</dd>
          <dt>Click empty space</dt><dd>Add a note</dd>
          <dt>Drag</dt><dd>Select notes</dd>
          <dt><Kbd>Shift</Kbd> + click</dt><dd>Add to the selection</dd>
          <dt>Drag a note</dt><dd>Move it</dd>
          <dt>Drag a note's end</dt><dd>Sustain</dd>
          <dt>Right-click</dt><dd>Delete</dd>
          <dt>Wheel</dt><dd>Scroll the roll</dd>
          <dt><Kbd>Ctrl</Kbd> + wheel</dt><dd>Zoom</dd>
        </dl>
      )}
      <div className="insp-eyebrow">KEYS</div>
      <dl className="insp-keys">
        <dt><Kbd>Tab</Kbd></dt><dd>Regenerate / Edit</dd>
        <dt><Kbd>Space</Kbd></dt><dd>Play / pause</dd>
        <dt><Kbd>[</Kbd> <Kbd>]</Kbd></dt><dd>Previous / next section</dd>
        <dt><Kbd>L</Kbd></dt><dd>Loop</dd>
        {tab === "regen" ? (
          <><dt><Kbd>R</Kbd></dt><dd>Regenerate the selection</dd></>
        ) : (
          <>
            <dt><Kbd>T</Kbd> <Kbd>H</Kbd> <Kbd>S</Kbd> <Kbd>Q</Kbd></dt><dd>Tap, HOPO, star power, snap</dd>
            <dt><Kbd>Del</Kbd></dt><dd>Delete notes</dd>
          </>
        )}
        <dt><Kbd>Ctrl</Kbd> <Kbd>Z</Kbd></dt><dd>Undo</dd>
        <dt><Kbd>Esc</Kbd></dt><dd>Clear the selection</dd>
      </dl>
    </div>
  );
}
