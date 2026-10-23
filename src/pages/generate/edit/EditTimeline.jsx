import { I } from "../../../icons.jsx";
import EditOverview from "./EditOverview.jsx";
import PianoRollEditor from "./PianoRollEditor.jsx";
import EditHelp from "./EditHelp.jsx";
import { MIN_COMPARE_CHARTS } from "../useGenerateProject.js";

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The bottom of the Inpaint and Edit tabs, where Generate has its takes
// deck: transport and song map, then the full-width piano roll.
export default function EditTimeline({ project, ws }) {
  const { editor, undoEditorChange, redoEditorChange } = project;
  const doc = ws.doc;
  if (!doc) return null;
  const regen = ws.tab === "regen";
  const playheadTick = doc.tempoMap.secondsToTick(editor.playhead.time || 0);

  return (
    <section className="edit-timeline">
      <div className="edit-toolbar">
        {/* Same transport as the Generate tab's, under the stage. */}
        <div className="edit-transport">
          <button className="transport-btn" onClick={ws.togglePlay} title="Play / pause (Space)">
            {editor.playing ? <><I.pause aria-hidden="true" /> Pause</> : <><I.play aria-hidden="true" /> Play</>}
          </button>
          <button
            className={"transport-btn ghost edit-loop" + (ws.loopOn && ws.loops.length ? " on" : "")}
            onClick={ws.toggleLoop}
            disabled={!ws.canLoop}
            aria-pressed={Boolean(ws.loopOn && ws.loops.length)}
            title={ws.canLoop ? "Loop the area the playhead is in (L)" : "Select something to loop"}
          >
            <I.loop aria-hidden="true" /> Loop
          </button>
          <span className="transport-time">{fmtTime(editor.playhead.time)}</span>
        </div>

        <div className="edit-map">
          <EditOverview
            doc={doc}
            bars={ws.bars}
            sections={ws.sections}
            regions={regen ? ws.dragPreview?.regions || ws.regions : []}
            lifted={ws.dragPreview?.active || null}
            origin={ws.dragPreview?.origin || null}
            pending={ws.pending}
            loops={ws.loops}
            activeLoop={ws.activeLoop}
            view={ws.view}
            playheadTick={playheadTick}
            endTick={ws.songEndTick}
            onScrub={ws.scrub}
            onSection={ws.pickSection}
          />
          <span className="transport-time">{fmtTime(editor.playhead.duration || doc.durationSec)}</span>
        </div>

        <div className="edit-view-controls">
          <div className="edit-zoom">
            <button onClick={() => ws.rollApiRef.current?.zoom(0.8)} aria-label="Zoom out" title="Zoom out (−)"><I.minus /></button>
            <button onClick={() => ws.rollApiRef.current?.zoom(1.25)} aria-label="Zoom in" title="Zoom in (+)"><I.plus /></button>
          </div>
          <div className="edit-menu-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <button
              className="edit-icon-btn"
              onClick={() => ws.setHelpOpen((v) => !v)}
              aria-expanded={ws.helpOpen}
              aria-label="Mouse and keys"
              title="Mouse and keys"
            >
              <I.info />
            </button>
            {ws.helpOpen && <EditHelp tab={ws.tab} />}
          </div>
          <div className="edit-history">
            <button onClick={undoEditorChange} disabled={!editor.canUndo} title="Undo (Ctrl+Z)"><I.undo aria-hidden="true" /> Undo</button>
            <button onClick={redoEditorChange} disabled={!editor.canRedo} title="Redo (Ctrl+Shift+Z)"><I.redo aria-hidden="true" /> Redo</button>
          </div>
          {/* Same button, same corner as the takes deck's. */}
          <button
            className={"deck-compare-btn" + (ws.comparing ? " active" : "")}
            onClick={ws.toggleCompare}
            disabled={!ws.comparing && ws.compareMarks.length < MIN_COMPARE_CHARTS}
            title={
              ws.comparing
                ? "Back to single preview"
                : ws.compareMarks.length < MIN_COMPARE_CHARTS
                  ? "Check at least two versions to compare"
                  : undefined
            }
          >
            {ws.comparing ? "✕ Comparing" : `Compare (${ws.compareMarks.length})`}
          </button>
        </div>
      </div>

      <div className="edit-roll">
        <PianoRollEditor
          project={project}
          mode={ws.tab}
          bars={ws.bars}
          sections={ws.sections}
          regions={regen ? ws.regions : []}
          onPickSection={ws.pickSection}
          onBoxSelect={ws.boxSelect}
          onClearSelection={ws.clearSelection}
          onSetSelection={ws.setRegions}
          onPreviewSelection={ws.setDragPreview}
          songEndTick={ws.songEndTick}
          pending={ws.pending}
          loops={ws.loops}
          activeLoop={ws.activeLoop}
          apiRef={ws.rollApiRef}
          onViewChange={ws.setView}
        />
      </div>
    </section>
  );
}
