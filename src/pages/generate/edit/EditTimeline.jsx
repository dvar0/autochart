import { I } from "../../../icons.jsx";
import EditOverview from "./EditOverview.jsx";
import PianoRollEditor from "./PianoRollEditor.jsx";

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The bottom of the Regenerate and Edit tabs, where Generate has its takes
// deck: transport and song map, then the full-width piano roll.
export default function EditTimeline({ project, ws }) {
  const { editor } = project;
  const doc = ws.doc;
  if (!doc) return null;
  const regen = ws.tab === "regen";
  const playheadTick = doc.tempoMap.secondsToTick(editor.playhead.time || 0);

  return (
    <section className="edit-timeline">
      <div className="edit-toolbar">
        <div className="edit-transport">
          <button className={"edit-play" + (editor.playing ? " playing" : "")} onClick={ws.togglePlay} aria-label={editor.playing ? "Pause" : "Play"} title="Play / pause (Space)">
            {editor.playing ? <I.pause /> : <I.play />}
          </button>
          <span className="edit-time">{fmtTime(editor.playhead.time)} <i>/ {fmtTime(editor.playhead.duration || doc.durationSec)}</i></span>
          <button
            className={"edit-loop" + (ws.loop ? " on" : "")}
            onClick={ws.toggleLoop}
            disabled={!ws.canLoop}
            aria-pressed={Boolean(ws.loop)}
            title={ws.canLoop ? "Loop the selection (L)" : "Select something to loop"}
          >
            ⟲ Loop
          </button>
        </div>

        <EditOverview
          doc={doc}
          bars={ws.bars}
          sections={ws.sections}
          regions={regen ? ws.dragPreview?.regions || ws.regions : []}
          lifted={ws.dragPreview?.active || null}
          origin={ws.dragPreview?.origin || null}
          pending={ws.pending}
          view={ws.view}
          playheadTick={playheadTick}
          endTick={ws.songEndTick}
          onScrub={ws.scrub}
          onSection={ws.pickSection}
        />

        <div className="edit-view-controls">
          <div className="edit-zoom">
            <button onClick={() => ws.rollApiRef.current?.zoom(0.8)} aria-label="Zoom out" title="Zoom out (−)"><I.minus /></button>
            <button onClick={() => ws.rollApiRef.current?.zoom(1.25)} aria-label="Zoom in" title="Zoom in (+)"><I.plus /></button>
          </div>
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
          loop={ws.loop}
          apiRef={ws.rollApiRef}
          onViewChange={ws.setView}
        />
      </div>
    </section>
  );
}
