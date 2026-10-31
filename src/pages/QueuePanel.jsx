import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AlbumArt } from "../components/index.jsx";
import ProgressRing from "../components/ProgressRing.jsx";
import SongCover from "../components/SongCover.jsx";
import { DIFF } from "../data/difficultyMetadata.js";
import { GAME_LIBRARY_NAME, GAME_LIBRARY_SAVE_LABEL, GAME_LIBRARY_SAVED_LABEL } from "../data/gameLibrary.js";
import { generationDownloadSize } from "../data/generationCatalog.js";
import { GENERATION_DIFFICULTIES, GENERATION_PRESETS } from "../data/generationSettings.js";
import { MODEL_FAMILIES, defaultGeneratorIdFrom, isBetaGenerator, selectableGeneratorsFrom } from "../data/modelFamilies.js";
import { isMissingLibraryFolderError } from "../hooks/useLibraryFolderGate.js";
import { I } from "../icons.jsx";
import { listGenerators } from "../services/generation.js";
import {
  clearQueue,
  exportQueue,
  getQueue,
  itemPercent,
  queueSummary,
  removeFromQueue,
  retryQueueItem,
  saveQueueToGame,
  setQueueGenerator,
  setQueueOpen,
  setQueueSettings,
  startQueue,
  stopQueue,
  subscribeQueue,
} from "../services/generationQueue.js";
import { activeModelInstalls, installAssets, subscribeModelInstallEvents, subscribeModelInstalls } from "../services/modelSetup.js";
import { generatorDifficultyIds } from "../services/projectRun.js";

function charts(count) {
  return `${count} ${count === 1 ? "chart" : "charts"}`;
}

function rowDetail(item) {
  const running = item.runs.find((run) => run.status === "running");
  if (running) {
    const several = item.runs.length > 1 ? ` ${DIFF[running.difficulty]?.name || running.difficulty}` : "";
    const stage = item.stage === "Charting" ? `Charting${several}` : item.stage;
    return item.onCpu ? `${stage} on CPU` : stage;
  }
  if (item.saved) return "Saved";
  return item.artist;
}

function QueueRow({ item, song, locked, onOpen }) {
  const statuses = item.runs.map((run) => run.status);
  const failed = item.runs.filter((run) => run.status === "failed");
  const running = statuses.includes("running");
  const finished = statuses.length > 0 && statuses.every((status) => status === "done");
  const percent = itemPercent(item);
  const error = failed[0]?.error || item.saveError;
  return (
    <li className={"queue-row" + (running ? " is-running" : "") + (error ? " has-error" : "")}>
      <div className="queue-row-main">
        <button type="button" className="queue-row-open" onClick={() => onOpen(item.songId)} title={`Open ${item.title}`}>
          <span className="queue-thumb">
            {song ? <SongCover song={song} /> : <AlbumArt seed={item.title} label={item.artist} />}
          </span>
          <span className="queue-row-copy">
            <span className="queue-row-title">{item.title}</span>
            <span className="queue-row-sub">{rowDetail(item)}</span>
          </span>
        </button>
        <span className="queue-row-mark" aria-hidden={!running}>
          {running ? (
            <span className="queue-row-percent">{percent}%</span>
          ) : finished ? (
            <span className="queue-badge is-done queue-row-done"><I.tick /></span>
          ) : null}
        </span>
        <button
          type="button"
          className="queue-row-remove"
          onClick={() => removeFromQueue([item.songId])}
          disabled={running || locked}
          aria-label={`Remove ${item.title} from the queue`}
          title="Remove from the queue"
        >
          <I.close />
        </button>
      </div>
      {error && (
        <div className="queue-row-error">
          <span role="alert" title={error}>{error}</span>
          {failed.length > 0 && (
            <span className="queue-row-retry">
              <button type="button" className="field-link" onClick={() => retryQueueItem(item.songId)}>Retry</button>
              {failed.some((run) => run.canUseCpu) && (
                <button type="button" className="field-link" onClick={() => retryQueueItem(item.songId, { cpu: true })}>Retry using CPU</button>
              )}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

export default function QueuePanel({ songs, folderGate, onOpen, onAddAll, canAddAll }) {
  const queue = useSyncExternalStore(subscribeQueue, getQueue);
  const summary = queueSummary(queue);
  const { running, stopping, saving, settings, items } = queue;
  const [manifest, setManifest] = useState(null);
  const [installing, setInstalling] = useState(() => activeModelInstalls());
  const [downloadPercent, setDownloadPercent] = useState(null);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    let alive = true;
    const refresh = () => listGenerators().then((next) => {
      if (alive) setManifest(next);
    }).catch((error) => {
      if (alive) setProblem(error?.message || "The engine didn't respond.");
    });
    refresh();
    const stopInstalls = subscribeModelInstalls(() => {
      setInstalling(activeModelInstalls());
      refresh();
    });
    const stopEvents = subscribeModelInstallEvents((event) => {
      if (Number.isFinite(event?.percent)) setDownloadPercent(Math.round(event.percent));
    });
    return () => {
      alive = false;
      stopInstalls();
      stopEvents();
    };
  }, []);

  const choices = useMemo(
    () => selectableGeneratorsFrom(manifest?.generators || [], manifest?.preferences || {}),
    [manifest]
  );
  const generator = choices.find((choice) => choice.id === settings.generatorId)
    || choices.find((choice) => choice.id === defaultGeneratorIdFrom(manifest?.generators || [], manifest?.preferences || {}))
    || choices[0]
    || null;

  useEffect(() => {
    if (generator) setQueueGenerator(generator);
  }, [generator]);

  const setup = generator?.setup || null;
  const family = setup && !setup.ready && setup.status !== "unsupported"
    ? MODEL_FAMILIES.find((item) => item.generatorId === generator.id || item.inpaintGeneratorId === generator.id)
    : null;
  const familyInstalling = Boolean(family && installing.includes(family.packId));
  const pack = family && manifest?.setup?.scan?.packs?.find((item) => item.id === family.packId);
  const downloadLabel = family && (setup.status === "corrupt"
    ? `Repair ${family.label}`
    : setup.status === "partial"
      ? `Finish downloading ${family.label}`
      : `Download ${family.label}`);

  const supported = generator ? generatorDifficultyIds(generator) : [];
  const difficulties = GENERATION_DIFFICULTIES.filter((option) => supported.includes(option.id));
  const toggleDifficulty = (id) => {
    const on = settings.difficulties.includes(id);
    if (on && settings.difficulties.length === 1) return;
    setQueueSettings({ difficulties: on ? settings.difficulties.filter((value) => value !== id) : [...settings.difficulties, id] });
  };

  const download = async () => {
    setProblem("");
    setDownloadPercent(null);
    try {
      await installAssets(family.packId);
    } catch (error) {
      setProblem(error?.message || "The download didn't finish.");
    }
  };

  // Every save goes through the songs-folder prompt when no folder is set.
  const saveFinished = (trigger) => {
    setProblem("");
    const save = () => saveQueueToGame().catch((error) => {
      if (isMissingLibraryFolderError(error)) folderGate.request(save);
      else setProblem(error?.message || `Could not save to ${GAME_LIBRARY_NAME}.`);
    });
    return folderGate.run(save, trigger);
  };

  const exportFinished = () => {
    setProblem("");
    exportQueue().catch((error) => setProblem(error?.message || "The export didn't finish."));
  };

  const toggleSaveWhenDone = (trigger) => {
    if (settings.saveWhenDone) setQueueSettings({ saveWhenDone: false });
    else folderGate.run(() => setQueueSettings({ saveWhenDone: true }), trigger);
  };

  // Mid-run, the song being charted stays and the rest come off.
  const clearAll = () => (running ? removeFromQueue(items.map((item) => item.songId)) : clearQueue());

  const anyDone = summary.done > 0;
  const savingLabel = saving ? `${saving.kind === "save" ? "Saving" : "Exporting"} ${Math.min(saving.done + 1, saving.total)} of ${saving.total}…` : "";
  const partDone = summary.waiting > 0 || summary.running > 0;

  let cta;
  if (running) {
    cta = stopping
      ? { label: <><span className="cta-spinner" aria-hidden="true" /> Stopping…</>, busy: true, disabled: true }
      : { label: "Stop", onClick: stopQueue };
  } else if (saving?.kind === "save" && !summary.waiting) {
    cta = { label: <><span className="cta-spinner" aria-hidden="true" /> {savingLabel}</>, busy: true, disabled: true };
  } else if (familyInstalling) {
    cta = { label: <><ProgressRing value={downloadPercent} /> Downloading{downloadPercent != null ? ` ${downloadPercent}%` : "…"}</>, disabled: true };
  } else if (family && (summary.waiting > 0 || !anyDone)) {
    cta = {
      label: <><I.download /> {downloadLabel}{setup.status === "missing" && pack ? ` · ${generationDownloadSize(pack)}` : ""}</>,
      onClick: download,
      disabled: installing.length > 0,
    };
  } else if (summary.waiting > 0) {
    cta = { label: <>Generate {charts(summary.waiting)} <I.boltFill /></>, onClick: startQueue, disabled: !generator || setup?.ready === false };
  } else if (summary.toSave > 0) {
    cta = { label: GAME_LIBRARY_SAVE_LABEL, onClick: (event) => saveFinished(event.currentTarget), disabled: Boolean(saving) };
  } else if (anyDone) {
    cta = { label: GAME_LIBRARY_SAVED_LABEL, disabled: true };
  } else {
    cta = { label: "Pick songs to start", disabled: true, quiet: true };
  }

  const note = problem || queue.note || (family && !familyInstalling ? `${family.label} isn't ready yet.` : "");
  const showSaveFinished = anyDone && summary.toSave > 0 && partDone;

  return (
    <div className="detail queue-panel" aria-label="Queue">
      <div className="queue-head">
        <div className="queue-title-line">
          <h2 className="queue-title">Queue</h2>
          <button
            type="button"
            className="queue-close"
            onClick={() => setQueueOpen(false)}
            aria-label="Close queue"
            title="Back to the library. The queue keeps its songs and keeps running."
          >
            <I.close />
          </button>
        </div>
        <div className="queue-head-line">
          <div className="queue-count">{summary.charts ? `${summary.done} of ${charts(summary.charts)}` : "No songs yet"}</div>
          <div className="queue-percent" role="status" aria-label={`${summary.percent} percent`}>{summary.percent}%</div>
        </div>
        <div className="gen-progressbar queue-bar">
          <i style={{ width: `${summary.percent}%` }} />
        </div>
        <div className="queue-action-row">
          <button type="button" className="act slim purple" onClick={onAddAll} disabled={!canAddAll}>
            <I.plus /> <span>Add all</span>
          </button>
          <button
            type="button"
            className="act slim ghost"
            onClick={clearAll}
            disabled={!items.length || Boolean(saving) || (running && items.length === 1)}
          >
            <I.close /> <span>Clear</span>
          </button>
        </div>
      </div>

      {items.length ? (
        <ul className="queue-list">
          {items.map((item) => (
            <QueueRow key={item.songId} item={item} song={songs.get(item.songId)} locked={Boolean(saving)} onOpen={onOpen} />
          ))}
        </ul>
      ) : (
        <div className="queue-list queue-empty">
          <div className="queue-empty-title">Click songs to add them</div>
          <div className="queue-empty-sub">Shift-click adds a range</div>
        </div>
      )}

      <div className="queue-settings">
        <div className="model-plate queue-model">
          <div className="model-plate-top">
            {choices.length > 1 ? (
              <label className="model-plate-picker">
                <select
                  className="model-plate-name"
                  value={generator?.id || ""}
                  onChange={(event) => setQueueGenerator(choices.find((choice) => choice.id === event.target.value))}
                  disabled={running}
                  aria-label="Chart model"
                >
                  {choices.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}{isBetaGenerator(choice.id) ? " · Beta" : ""}
                    </option>
                  ))}
                </select>
                <I.chev />
              </label>
            ) : (
              <div className="model-plate-name">{generator?.label || "Fretformer"}</div>
            )}
          </div>
        </div>
        <div className="difficulty-segments" role="group" aria-label="Difficulties to chart">
          {difficulties.map((option) => {
            const on = settings.difficulties.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                className={`diff-seg tone-${option.tone}` + (on ? " active" : "")}
                onClick={() => toggleDifficulty(option.id)}
                disabled={running}
                aria-pressed={on}
              >
                {option.name}
              </button>
            );
          })}
        </div>
        <div className="preset-grid" role="group" aria-label="Sampling">
          {GENERATION_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={settings.presetId === preset.id ? "active" : ""}
              onClick={() => setQueueSettings({ presetId: preset.id })}
              disabled={running}
              aria-pressed={settings.presetId === preset.id}
              title={preset.summary}
            >
              <b>{preset.name}</b>
            </button>
          ))}
        </div>
        <div className="queue-toggle">
          <span id="queue-save-when-done">Save each to {GAME_LIBRARY_NAME}</span>
          <button
            type="button"
            role="switch"
            aria-checked={settings.saveWhenDone}
            aria-labelledby="queue-save-when-done"
            className={"model-switch" + (settings.saveWhenDone ? " on" : "")}
            onClick={(event) => toggleSaveWhenDone(event.currentTarget)}
          >
            <span className="model-switch-knob" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="detail-actions queue-actions">
        <button
          type="button"
          className={"gen-cta" + (cta.busy ? " is-busy" : "") + (cta.quiet ? " needs-input" : "")}
          onClick={cta.onClick}
          disabled={cta.disabled}
        >
          {cta.label}
        </button>
        <div className={"queue-action-row" + (showSaveFinished ? "" : " is-single")}>
          <button type="button" className="act slim ghost" onClick={exportFinished} disabled={!anyDone || Boolean(saving)}>
            <I.upload />
            <span>{saving?.kind === "export" ? savingLabel : anyDone && partDone ? "Export finished" : "Export all"}</span>
          </button>
          {showSaveFinished && (
            <button
              type="button"
              className="act slim ghost"
              onClick={(event) => saveFinished(event.currentTarget)}
              disabled={Boolean(saving)}
              title={`Save the finished songs to ${GAME_LIBRARY_NAME}`}
            >
              <I.check /> <span>{saving?.kind === "save" ? savingLabel : "Save finished"}</span>
            </button>
          )}
        </div>
        <div className="queue-note" role="status" title={note}>{note}</div>
      </div>
    </div>
  );
}
