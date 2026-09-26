import { useEffect, useRef, useState } from "react";
import HighwayPreview from "../../highway/HighwayPreview.jsx";
import LiveNoteStrip from "./LiveNoteStrip.jsx";
import { StageSignal } from "./StageAnimations.jsx";
import { describeRunStage, runProgressPercent, runIsStreaming, runIsSeparating } from "./GenerationProgress.jsx";
import { I } from "../../icons.jsx";

// The live stage and take-card both share runProgressPercent as the single
// canonical percent source. They MUST NOT read the raw live.percent — that
// number is a 0..100 fraction of committedBeats which starts near zero when
// streaming begins and would make the bar plummet. runProgressPercent already
// maps that fraction INTO the transcription stage's own range.
function livePercent(project) {
  return runProgressPercent(project.genRun);
}

function beatLabel(live) {
  if (!live?.totalBeats) return "";
  return `${Math.round(live.committedBeats || 0)} / ${Math.round(live.totalBeats)} beats`;
}

function statusLabel(project) {
  return describeRunStage(project.genRun) || "Starting engine…";
}

// Until a model stage reports in, the engine is still reading the audio.
function runIsPreparing(run) {
  return !runIsStreaming(run) && !["demucs", "timing", "smoothing", "transcription"].some((id) => run?.stages?.[id]);
}

// What the board should show while a first-time generation runs: reading the
// audio, Demucs separation, then timing and transcription warm-up. As soon as
// transcription streams a partial chart, the live highway takes over.
function liveBoardPhase(project) {
  if (runIsStreaming(project.genRun)) return "notes";
  if (runIsSeparating(project.genRun)) return "separating";
  if (runIsPreparing(project.genRun)) return "preparing";
  return "warming";
}

function signalMode(phase) {
  return phase === "separating" ? "split" : phase === "preparing" ? "prep" : "beat";
}

function liveFollowTime(live) {
  const committed = Number(live?.committedSeconds) || 0;
  return Math.max(0, committed - 1.35);
}

// The in-flight chart is built in the run's PADDED timeline (it starts with the
// lead-in silence, so notes' `time` are padded seconds). Compare mode reuses
// the same offset mechanism (HighwayPreview compareOffset / engine.chartTimeOffset):
// chartDisplayTime = audioTime - compareOffset. When the board plays the run's
// own analysis audio (the normal case — see liveAudioBuffer below) the audio
// lead-in equals the run lead-in and the offset is 0. On the unpadded-source
// fallback the audio lead is 0 and the offset goes negative — the chart renders
// AHEAD of the audio clock by the lead-in (GameEngine accepts negative offsets).
function liveCompareOffset(project, liveAudioLead) {
  const runLeadInSeconds = Number(project.genRun?.leadInSeconds) || 0;
  return liveAudioLead - runLeadInSeconds;
}

// Live and saved charts share one mounted transport, including fullscreen ownership.
export function GenerationPreviewStage({ project }) {
  const isLive = project.showingLiveStage;
  const live = project.liveGeneration;
  const phase = liveBoardPhase(project);
  const pct = livePercent(project);
  const title = project.details?.title || "Live transcription";
  const separating = phase === "separating";
  const hasSelectedTrack = Boolean(project.track);
  const setLiveStageFocused = project.setLiveStageFocused;

  // Interactive playback mode: the explicit "Play" click both switches the
  // board out of chase-cam AND starts audio from the top (the click IS the
  // user gesture — the no-autoplay rule is about starting without one). While
  // true the board behaves like the normal single-take preview: transport
  // visible, partial chart updates preserve the playhead. The "Live" button
  // drops back into chase-cam follow mode without forcing a stop on pause.
  const [livePlaying, setLivePlaying] = useState(false);
  const highwayRef = useRef(null);

  // The board plays the run's own analysis audio when it's available. For a
  // lead-in run that is the PADDED source, so live playback shares the final
  // take's timeline: 0:00 includes the lead-in silence, and note times match
  // the finished chart's exactly. For a first-time generation (no lead-in, no
  // importedSong yet) it's the unpadded analysis audio — same timeline as the
  // source, just decoded from the run's cache instead of from an in-memory
  // buffer that doesn't exist yet. Before it loads (or if the cache read
  // failed) fall back to whatever the preview is holding — usually the
  // unpadded original — and compensate via a negative compareOffset instead.
  const runAnalysisAudio = project.liveAnalysisAudioBuffer || null;
  const liveAudioBuffer = runAnalysisAudio || project.audioBuffer;

  const liveAudioLead = runAnalysisAudio
    ? Number(project.genRun?.leadInSeconds) || 0
    : Number(project.audioLeadInSeconds) || 0;
  const handlePlayingChange = (playing) => {
    project.reportPreviewPlaying?.(!isLive && playing);
  };

  useEffect(() => {
    project.reportPreviewPlaying?.(!isLive && !project.previewAudioError && Boolean(highwayRef.current?.isPlaying()));
  }, [isLive, project.previewAudioError, project.reportPreviewPlaying]);

  useEffect(() => {
    if (isLive) {
      highwayRef.current?.pause?.();
      setLivePlaying(false);
    } else {
      // Chase-cam watching does not carry its near-the-end position into a take.
      if (!livePlaying) highwayRef.current?.seek?.(0);
      setLivePlaying(false);
    }
  }, [isLive]);

  const enterInteractive = () => {
    setLivePlaying(true);
  };
  const exitInteractive = () => {
    // Leaving interactive mode = the user stopped listening to the in-flight
    // take; there should be no handoff when the final chart appears.
    highwayRef.current?.pause?.();
    setLivePlaying(false);
  };
  // Dismissing the live board is a deliberate stop.
  const dismissToChart = () => {
    highwayRef.current?.pause?.();
    setLivePlaying(false);
    setLiveStageFocused?.(false);
  };
  // Entering interactive playback starts the audio from the top immediately.
  // Runs AFTER the re-render so the compareOffset sign flip / track re-apply
  // settle first and the seek isn't undone by the chase-cam follow RAF. If
  // audio is still decoding, playOnReady honors the same explicit Play click.
  useEffect(() => {
    if (!isLive || !livePlaying) return;
    const h = highwayRef.current;
    if (h && !h.isPlaying?.()) {
      h.seek?.(0);
      h.play?.();
    }
  }, [livePlaying, isLive]);

  // Retain the transport while replacement audio loads, but stop it once the
  // cache read fails: the previous buffer may belong to a different timeline.
  if (!isLive && project.previewAudioError) {
    return (
      <div className="single-chart-shell">
        <div className="preview-audio-error">{project.previewAudioError}</div>
      </div>
    );
  }

  return (
    <div className={isLive ? "live-gen-stage" : "single-chart-shell"}>
      <div className={isLive ? "live-stage-board" : "single-chart-shell"}>
        {!isLive || phase === "notes" ? (
          <>
            <HighwayPreview
              ref={highwayRef}
              track={isLive ? live.track : project.track}
              audioBuffer={isLive ? liveAudioBuffer : project.audioBuffer}
              audioLeadInSeconds={isLive ? liveAudioLead : project.audioLeadInSeconds}
              videoOffset={isLive ? liveAudioLead : project.activeVideoOffset}
              background={project.background}
              className={isLive ? "live-stage-highway" : "single-preview"}
              initialTime={0}
              playOnReady={isLive && livePlaying}
              followTime={isLive && !livePlaying ? liveFollowTime(live) : null}
              // compareOffset only applies once the user enters interactive
              // playback; chase-cam follow stays in the chart's own padded
              // timeline (offset 0) so the streamed notes line up with the
              // committed-seconds chase position exactly as before.
              compareOffset={isLive && livePlaying ? liveCompareOffset(project, liveAudioLead) : 0}
              onPlayingChange={handlePlayingChange}
              hideTransport={isLive && !livePlaying}
              hideControls={isLive}
              visualOnly={isLive && !livePlaying}
            />
            {isLive && (!livePlaying ? (
              <button
                type="button"
                className="live-play-affordance"
                onClick={enterInteractive}
                title="Switch the live board to interactive playback"
              >
                <I.play /> Play
              </button>
            ) : (
              <button
                type="button"
                className="live-play-affordance live-back-affordance"
                onClick={exitInteractive}
                title="Back to live follow mode"
              >
                ● Live
              </button>
            ))}
            {isLive && hasSelectedTrack && (
              <button
                type="button"
                className="live-play-affordance live-chart-affordance"
                onClick={dismissToChart}
                title="Back to the selected chart"
              >
                ✕ Chart
              </button>
            )}
          </>
        ) : (
          // One mounted signal for every wait, so each stage eases into the next.
          <StageSignal mode={signalMode(phase)} />
        )}
      </div>
      {isLive && <div className="live-stage-status">
        <div className="live-stage-status-row">
          <span className="live-rec"><i aria-hidden="true" />{separating ? "SPLIT" : "REC"}</span>
          <div className="live-stage-status-main">
            <b>{title}</b>
            <small>
              {separating
                ? "Separating stems"
                : [statusLabel(project), beatLabel(live)].filter(Boolean).join(" · ")}
            </small>
          </div>
          {!separating && <span className="live-stage-notes">{live?.noteCount || 0} notes</span>}
          {!separating && <span className="live-stage-pct">{Math.round(pct)}%</span>}
        </div>
        <div className="gen-progressbar sm" aria-hidden="true">
          {separating ? <i className="indeterminate" /> : <i style={{ width: `${pct}%` }} />}
        </div>
      </div>}
    </div>
  );
}

export function LiveGenerationTakeCard({ project, selected = false, onClick }) {
  const live = project.liveGeneration;
  const pct = livePercent(project);
  const notes = live?.track?.notes || [];
  // Before the model streams notes the transcriber is still splitting stems
  // (e.g. a fresh lead-in forced a re-separation), so show the stem-split strip
  // instead of an empty piano roll.
  const separating = runIsSeparating(project.genRun);
  const clickable = Boolean(onClick);

  return (
    <div
      className={
        "take-card ghost live-take-card" +
        (selected ? " selected" : "") +
        (separating ? " is-separating" : "") +
        (clickable ? " is-clickable" : "")
      }
      aria-live="polite"
      onClick={onClick}
      onKeyDown={(event) => {
        if (clickable && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onClick();
        }
      }}
      role={clickable ? "button" : undefined}
      aria-pressed={clickable ? selected : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={clickable ? "Show live generation board" : undefined}
      aria-label={clickable ? "Show live generation board" : undefined}
    >
      <div className="take-card-top">
        <span className={"live-rec-badge" + (separating ? " split" : "")}>
          <i />{separating ? "SPLIT" : "REC"}
        </span>
        <span className="take-name">
          {separating ? "Separating stems…" : `Generating take · ${Math.round(pct)}%`}
        </span>
      </div>
      <div className="live-take-viewport">
        {notes.length > 0 && !separating ? (
          <LiveNoteStrip notes={notes} head={live?.committedSeconds || 0} />
        ) : (
          <StageSignal size="strip" mode={signalMode(liveBoardPhase(project))} />
        )}
      </div>
      <div className="gen-progressbar sm live-take-progress" aria-hidden="true">
        {separating ? <i className="indeterminate" /> : <i style={{ width: `${pct}%` }} />}
      </div>
      <div className="take-meta">
        {separating
          ? "Vocals, guitar, bass, drums"
          : [beatLabel(live), `${live?.noteCount || 0} notes`].filter(Boolean).join(" · ")}
      </div>
      {!separating && (
        <div className="take-tags">
          <span className="take-tag primary">live</span>
          <span className="take-tag mod">{statusLabel(project)}</span>
        </div>
      )}
    </div>
  );
}
