import { useEffect, useState } from "react";
import { I } from "../icons.jsx";
import { FretStrip } from "../components/index.jsx";
import ProgressRing from "../components/ProgressRing.jsx";
import { FRET_COLORS } from "../data/notePalette.js";
import { formatSize, generationDownloadSize } from "../data/generationCatalog.js";
import { friendlyTarget } from "../data/hardwareModes.js";
import { chooseModelsFolder, getAppSettings, markSetupComplete } from "../services/appSettings.js";
import { installAssets, scanModelSetup, subscribeModelInstallEvents } from "../services/modelSetup.js";
import { SongFeed, StartHighway } from "./Start.jsx";

// The first thing a new install shows: what Autochart does, the one model it
// needs, and a button to get it. The wait is when the rest gets introduced.
// When the download finishes, the app opens on Generate. Everything else
// (other models, other folders, hardware) is in Settings.

const FEATURES = [
  { icon: I.music, title: "Generate", text: "Drop in a song and get a full chart." },
  { icon: I.spark, title: "Inpaint", text: "Pick some bars and generate just those again." },
  { icon: I.pencil, title: "Edit and play", text: "Move notes by hand, then play it in Clone Hero or YARG." },
];

function failureFrom(error) {
  const detail = String(error?.message || error || "").replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  const text = /ENOSPC|no space left/i.test(detail)
    ? "This drive ran out of space. Free some up or change the location, then try again."
    : "The download stopped. Check your connection and try again. Finished files are kept.";
  return { text, detail };
}

function DownloadProgress({ progress, modelName, size }) {
  const percent = Number.isFinite(progress?.percent) ? progress.percent : null;
  const label = percent == null ? "Getting ready" : percent >= 100 ? "Finishing up" : `Downloading ${modelName}`;
  return (
    <div
      className="setup-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={percent ?? undefined}
    >
      <ProgressRing value={percent} />
      <div>
        <b>{label}</b>
        <span>{percent == null ? " " : `${percent}% of ${size}`}</span>
      </div>
    </div>
  );
}

export default function Setup({ onDone }) {
  const [settings, setSettings] = useState(null);
  const [setup, setSetup] = useState(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState("");
  const [failure, setFailure] = useState(null);
  const [progress, setProgress] = useState(null);
  const [started, setStarted] = useState(false);
  const [clockStart] = useState(() => performance.now());

  const load = async () => {
    setChecking(true);
    setFailure(null);
    try {
      const [nextSettings, nextSetup] = await Promise.all([getAppSettings(), scanModelSetup()]);
      setSettings(nextSettings);
      setSetup(nextSetup);
    } catch (error) {
      setFailure({ text: "Autochart couldn't check its files. Try again.", detail: String(error?.message || error) });
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => subscribeModelInstallEvents(setProgress), []);

  const finish = async () => {
    setBusy("finish");
    setFailure(null);
    try {
      await markSetupComplete();
      onDone?.();
    } catch (error) {
      setFailure({ text: "Autochart couldn't finish setting up. Try again.", detail: String(error?.message || error) });
    } finally {
      setBusy("");
    }
  };

  const download = async () => {
    setBusy("downloading");
    setStarted(true);
    setFailure(null);
    setProgress({ phase: "starting", percent: null });
    try {
      const result = await installAssets();
      if (result?.settings) setSettings(result.settings);
      const nextSetup = result?.setup || await scanModelSetup();
      setSetup(nextSetup);
      if (!nextSetup?.generationReady) throw new Error("The downloaded files didn't pass their check.");
      await markSetupComplete();
      onDone?.();
    } catch (error) {
      setFailure(failureFrom(error));
      setSetup(await scanModelSetup().catch(() => null) || setup);
    } finally {
      setBusy("");
    }
  };

  const changeLocation = async () => {
    setBusy("folder");
    setFailure(null);
    try {
      const result = await chooseModelsFolder();
      if (result?.settings) setSettings(result.settings);
      else if (result) setSettings(result);
      setSetup(await scanModelSetup());
    } catch (error) {
      setFailure({ text: "That folder can't be used. Pick another one.", detail: String(error?.message || error) });
    } finally {
      setBusy("");
    }
  };

  const pack = setup?.standardPack;
  const modelName = pack?.label || "Fretformer 2";
  const size = generationDownloadSize(pack);
  const downloading = busy === "downloading";
  const browserOnly = Boolean(setup?.browserOnly);
  const unsupported = !browserOnly && (setup?.combinedStatus === "unsupported" || setup?.supportedPlatform === false);
  const ready = Boolean(setup?.generationReady);
  const damaged = ["partial", "corrupt"].includes(setup?.combinedStatus);

  // Bytes on disk, which beats the download size: models sharing a file each
  // keep their own copy. A repair only needs what's missing, so it isn't held back.
  const freeBytes = setup?.modelsFolderFreeBytes;
  const neededBytes = pack?.installBytes || pack?.downloadBytes || 0;
  const outOfRoom = !ready && !damaged && Number.isFinite(freeBytes) && freeBytes < neededBytes;
  const facts = !setup || unsupported || browserOnly
    ? ""
    : [`${size} download`, Number.isFinite(freeBytes) ? `${formatSize(freeBytes)} free` : ""].filter(Boolean).join(" · ");

  const action = (() => {
    if (!setup) return failure ? { label: "Try again", run: load } : { label: "Checking…", disabled: true };
    if (browserOnly) return { label: "Open Browser Preview", run: finish };
    if (unsupported) return { label: "Not available here", disabled: true };
    if (ready) return { label: "Start charting", icon: I.music, run: finish };
    if (outOfRoom) return { label: `Download ${modelName}`, icon: I.download, disabled: true };
    if (failure) return { label: "Try again", run: download };
    if (damaged) return { label: setup.combinedStatus === "corrupt" ? "Repair download" : "Finish download", icon: I.download, run: download };
    return { label: `Download ${modelName}`, icon: I.download, run: download };
  })();

  const hint = (() => {
    if (failure || downloading) return null;
    if (browserOnly) return "This preview can't download models or make charts.";
    if (unsupported) return setup?.message || `${friendlyTarget(setup)} isn't supported.`;
    if (outOfRoom) return `Needs ${formatSize(neededBytes)} free. This drive has ${formatSize(freeBytes)}.`;
    if (damaged) return setup.combinedStatus === "corrupt"
      ? "Some files are damaged. Only those get downloaded again."
      : "Part of it is already here. Only the rest gets downloaded.";
    return null;
  })();
  const warned = Boolean(failure) || unsupported || outOfRoom;

  const ActionIcon = action.icon;

  return (
    <div className="start-page setup-page">
      <div className="start-head">
        <div className="setup-wordmark">
          <span className="logo-star"><I.star /></span>
          <span className="wordmark">AUTOCHART</span>
          <FretStrip className="setup-wordmark-strip" />
        </div>
        <h1 className="start-title">Chart any song</h1>
        <p className="start-sub">Get a five-fret guitar chart for Clone Hero and YARG, right on this computer.</p>
        <div className="start-feed-wrap">
          <SongFeed startAt={clockStart} />
          <StartHighway startAt={clockStart} />
        </div>

        <section className="setup-model" aria-label="Model">
          <div className="setup-model-head">
            <b>{modelName}</b>
            {ready
              ? <span className="setup-model-ready"><I.check /> Ready</span>
              : <span className="setup-model-facts">{facts}</span>}
          </div>
          <p>The model that writes your charts.</p>
          {!browserOnly && (
            <div className="setup-model-where">
              <span title={settings?.modelsFolder || ""}>{settings?.modelsFolder || " "}</span>
              <button type="button" className="start-link" onClick={changeLocation} disabled={Boolean(busy) || checking || unsupported}>
                <I.folder /> Change location
              </button>
            </div>
          )}
        </section>

        <div className="setup-action">
          {downloading ? (
            <DownloadProgress progress={progress} modelName={modelName} size={size} />
          ) : (
            <button
              type="button"
              className="btn-primary start-cta"
              onClick={action.run}
              disabled={Boolean(action.disabled) || Boolean(busy)}
              aria-describedby="setup-action-reason"
            >
              {ActionIcon && <ActionIcon />} {action.label}
            </button>
          )}
        </div>

        <div
          id="setup-action-reason"
          className={"start-hint" + (warned ? " is-error" : "")}
          role={warned ? "alert" : "status"}
          aria-live={warned ? "assertive" : "polite"}
        >
          {failure?.text || hint}
        </div>
        <div className="setup-failure-slot">
          {failure?.detail && (
            <details className="setup-failure">
              <summary>Details</summary>
              <p>{failure.detail}</p>
            </details>
          )}
        </div>

        <ul className={"setup-features" + (started ? " is-shown" : "")} aria-hidden={!started}>
          {FEATURES.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <li key={feature.title} className="release-feature">
                <span className="release-feature-icon" style={{ "--gem": FRET_COLORS[index] }} aria-hidden="true"><Icon /></span>
                <span className="release-feature-copy">
                  <b>{feature.title}</b>
                  <span>{feature.text}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
