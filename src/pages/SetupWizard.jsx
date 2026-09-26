import { useEffect, useState } from "react";
import { I } from "../icons.jsx";
import { FretStrip } from "../components/index.jsx";
import InstallProgress from "../components/InstallProgress.jsx";
import GenerationPipeline, { generationDownloadSize } from "../components/GenerationPipeline.jsx";
import { friendlyTarget } from "../data/hardwareModes.js";
import {
  chooseCacheFolder,
  chooseCloneHeroLibraryFolder,
  chooseModelsFolder,
  chooseProjectsFolder,
  getAppSettings,
  markSetupComplete,
  resetSettingsPath,
  updateAppSettings,
} from "../services/appSettings.js";
import { installAssets, scanModelSetup, subscribeModelInstallEvents } from "../services/modelSetup.js";

const STEPS = ["Welcome", "Storage", "Chart Setup", "Finish"];

const PATH_ROWS = [
  { key: "projectsFolder", label: "Projects", choose: chooseProjectsFolder },
  { key: "modelsFolder", label: "Chart generation files folder", choose: chooseModelsFolder },
  { key: "cacheFolder", label: "Cache", choose: chooseCacheFolder },
  { key: "cloneHeroLibraryFolder", label: "Clone Hero / YARG library", choose: chooseCloneHeroLibraryFolder },
];

function InstallState({ status }) {
  if (status === "ready") {
    return <span className="setup-choice-state ready"><I.check /> Installed</span>;
  }
  if (status === "unsupported") {
    return <span className="setup-choice-state warn">Unsupported</span>;
  }
  if (status === "partial" || status === "corrupt") {
    return <span className="setup-choice-state partial">Needs repair</span>;
  }
  if (status === "checking") {
    return <span className="setup-choice-state none">Checking</span>;
  }
  return <span className="setup-choice-state none">Not installed</span>;
}


export default function SetupWizard({ onDone }) {
  const [step, setStep] = useState(0);
  const [settings, setSettings] = useState(null);
  const [setup, setSetup] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null);
  const [installProgress, setInstallProgress] = useState(null);

  // Messages carry a tone so confirmations ("Installed…") render as a calm
  // notice instead of the red error box.
  const notify = (text, tone = "error") => setMessage(text ? { text, tone } : null);

  const loadAll = async () => {
    setBusy("loading");
    setMessage(null);
    try {
      const [nextSettings, nextSetup] = await Promise.all([
        getAppSettings(),
        scanModelSetup(),
      ]);
      setSettings(nextSettings);
      setSetup(nextSetup);
    } catch (err) {
      notify(err.message || "Setup could not load.");
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => subscribeModelInstallEvents(setInstallProgress), []);

  const runFolderAction = async (label, action) => {
    setBusy(label);
    setMessage(null);
    try {
      const result = await action();
      if (result?.settings) setSettings(result.settings);
      else if (result) setSettings(result);
      setSetup(await scanModelSetup());
    } catch (err) {
      notify(err.message || "Folder action failed.");
    } finally {
      setBusy("");
    }
  };

  const updateAssetBaseUrl = async () => {
    setBusy("asset-source");
    setMessage(null);
    try {
      setSettings(await updateAppSettings({ assetBaseUrl: settings?.assetBaseUrl || "" }));
      notify("Download source updated.", "ok");
    } catch (err) {
      notify(err.message || "Could not update download source.");
    } finally {
      setBusy("");
    }
  };

  const installModels = async () => {
    setBusy("installing");
    notify(
      `Downloading the chart generation package (about ${generationDownloadSize(setup?.standardPack)}). This can take a while.`,
      "ok"
    );
    setInstallProgress({ phase: "starting", percent: 0, message: "Preparing download." });
    try {
      const result = await installAssets();
      if (result?.settings) setSettings(result.settings);
      if (result?.setup) setSetup(result.setup);
      else setSetup(await scanModelSetup());
      setInstallProgress((current) => ({ ...(current || {}), phase: "complete", percent: 100 }));
      notify(
        `The chart generation package is installed and verified at ${result?.install?.path || settings?.modelsFolder || "the chart generation files folder"}.`,
        "ok"
      );
    } catch (err) {
      setInstallProgress((current) => ({ ...(current || {}), phase: "failed" }));
      notify(err.message || "Could not install the chart generation package.");
    } finally {
      setBusy("");
    }
  };

  const finishSetup = async ({ browserPreview = false } = {}) => {
    setBusy("finish");
    setMessage(null);
    try {
      if (browserPreview && !setup?.browserOnly) {
        throw new Error("The no-model preview is available only in browser development mode.");
      }
      if (!browserPreview) {
        const latestSetup = await scanModelSetup();
        setSetup(latestSetup);
        if (!latestSetup?.generationReady) {
          setStep(2);
          throw new Error(
            latestSetup?.combinedStatus === "unsupported"
              ? latestSetup.message
              : "Download and verify the chart generation package before continuing."
          );
        }
      }
      await markSetupComplete();
      onDone?.();
    } catch (err) {
      notify(err.message || "Could not finish setup.");
    } finally {
      setBusy("");
    }
  };

  const back = () => setStep((value) => Math.max(0, value - 1));
  const standardPack = setup?.standardPack;
  const setupReady = Boolean(setup?.generationReady);
  const unsupported = !setup?.browserOnly &&
    (setup?.combinedStatus === "unsupported" || setup?.supportedPlatform === false);
  const canEnterFinish = !unsupported && (setupReady || Boolean(setup?.browserOnly));
  const modelStatus = busy === "loading" && !setup
    ? "checking"
    : setup?.combinedStatus || standardPack?.status || "missing";
  const installing = busy === "installing";
  const downloadSize = generationDownloadSize(standardPack);
  const installButtonLabel = installing
    ? "Installing…"
    : unsupported
      ? "Unavailable"
      : modelStatus === "ready"
        ? "Installed"
        : modelStatus === "partial" || modelStatus === "corrupt"
          ? "Repair Package"
          : "Download Package";
  const modelCopy = modelStatus === "checking"
    ? "Checking the installed chart generation files…"
    : unsupported
      ? setup?.message || `${friendlyTarget(setup)} is unsupported.`
      : modelStatus === "ready"
        ? "Chart generation is installed and ready."
        : modelStatus === "partial" || modelStatus === "corrupt"
          ? "Some chart generation files are missing or damaged. Repair the package before continuing."
          : "Download once to enable chart generation. The files stay on this computer.";
  const installDisabledReason = unsupported
    ? setup?.message || `${friendlyTarget(setup)} is unsupported for chart generation.`
    : busy
      ? "Wait for the current setup operation to finish."
      : modelStatus === "ready"
        ? "The chart generation package is already installed."
        : modelStatus === "checking"
          ? "Wait for the package scan to finish."
          : "";
  const finishDisabledReason = unsupported
    ? setup?.message || `${friendlyTarget(setup)} is unsupported for chart generation.`
    : busy
      ? "Wait for the current setup operation to finish."
      : !setupReady
        ? "Install and verify the chart generation package before starting."
        : "";

  const requireGenerationFiles = () => {
    setStep(2);
    notify(unsupported
      ? setup?.message || `${friendlyTarget(setup)} is unsupported.`
      : "Download the chart generation package before continuing.");
  };
  const goToStep = (index) => {
    if (index === STEPS.length - 1 && !canEnterFinish) {
      requireGenerationFiles();
      return;
    }
    setMessage(null);
    setStep(index);
  };
  const next = () => {
    if (step === 2 && !canEnterFinish) {
      requireGenerationFiles();
      return;
    }
    setMessage(null);
    setStep((value) => Math.min(STEPS.length - 1, value + 1));
  };

  return (
    <div className="ac-body setup-page">
      <div className="setup-shell">
        <header className="setup-topbar">
          <div className="setup-topbar-inner">
            <div className="setup-wordmark">
              <span className="logo-star"><I.star /></span>
              <span className="wordmark">AUTOCHART</span>
              <FretStrip className="setup-wordmark-strip" />
            </div>
            <ol className="setup-steps">
              {STEPS.map((label, index) => (
                <li key={label}>
                  <button
                    className={"setup-step-tab" + (index === step ? " active" : "") + (index < step ? " done" : "")}
                    onClick={() => goToStep(index)}
                    disabled={Boolean(busy)}
                    aria-disabled={index === STEPS.length - 1 && !canEnterFinish}
                  >
                    <span>{index < step ? <I.check /> : index + 1}</span>
                    {label}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </header>

        <section className="setup-scroll">
          <div className="setup-panel">
          {step === 0 && (
            <>
              <header className="page-head">
                <h1 className="page-title">Set Up Autochart</h1>
                <p className="page-sub">
                  Autochart turns songs into playable charts using models that run on your machine.
                </p>
              </header>
              <div className="setup-copy-block">
                <I.bolt />
                <div>
                  <h2>Get ready to generate</h2>
                  <p>Pick storage folders and download the chart generation package. Autochart chooses available hardware automatically. You can change hardware mode later in Settings.</p>
                </div>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <header className="page-head">
                <h1 className="page-title">Storage</h1>
                <p className="page-sub">Where Autochart keeps its files. The defaults work fine.</p>
              </header>
              <div className="setup-path-list">
                {PATH_ROWS.map((row) => (
                  <div className="setup-path-row" key={row.key}>
                    <div>
                      <b>{row.label}</b>
                      <span>{settings?.[row.key] || "Not selected"}</span>
                    </div>
                    <div className="settings-actions">
                      <button className="settings-secondary" onClick={() => runFolderAction(row.key, row.choose)} disabled={Boolean(busy)}>
                        Change
                      </button>
                      <button className="settings-secondary" onClick={() => runFolderAction(`reset-${row.key}`, () => resetSettingsPath(row.key))} disabled={Boolean(busy)}>
                        Reset
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <header className="page-head">
                <h1 className="page-title">Set Up Chart Generation</h1>
                <p className="page-sub">
                  {modelCopy}
                </p>
              </header>
              <div className="setup-model-choices">
                <div className="setup-choice selected">
                  <span className="setup-choice-top">
                    <span className="setup-choice-name">Chart generation package</span>
                    <InstallState status={modelStatus} />
                  </span>
                  <span className="setup-choice-desc">Everything Autochart needs to turn a song into a playable chart.</span>
                  <span className="setup-choice-meta">About {downloadSize}</span>
                </div>
              </div>

              <div className="setup-model-actions">
                <button
                  className="btn-primary setup-model-install"
                  onClick={installModels}
                  disabled={Boolean(busy) || ["ready", "unsupported", "checking"].includes(modelStatus)}
                  aria-describedby="setup-install-reason"
                  title={installDisabledReason || "Install the verified chart generation package"}
                >
                  {installButtonLabel}
                </button>
                <span id="setup-install-reason" className="sr-only">{installDisabledReason}</span>
                <button className="settings-secondary" onClick={loadAll} disabled={Boolean(busy)}>
                  <I.spark /> Scan Again
                </button>
              </div>

              {(busy === "installing" || installProgress) && <InstallProgress progress={installProgress} />}

              <details className="setup-package-details">
                <summary>What’s included?</summary>
                <div className="setup-package-details-body">
                  <p>These parts work together automatically. You do not need to configure them separately.</p>
                  <GenerationPipeline pack={standardPack} />
                </div>
              </details>

              <details className="setup-package-details setup-advanced-details">
                <summary>Advanced: change download source</summary>
                <div className="setup-source-block">
                  <p className="settings-note">Use a different address for the chart generation package.</p>
                  <div className="settings-row-control">
                    <input
                      className="settings-select"
                      value={settings?.assetBaseUrl || ""}
                      onChange={(e) => setSettings((current) => ({ ...(current || {}), assetBaseUrl: e.target.value }))}
                      placeholder="https://host/path/to/autochart-assets"
                      disabled={Boolean(busy)}
                    />
                    <button className="settings-secondary" onClick={updateAssetBaseUrl} disabled={Boolean(busy)}>
                      Save Source
                    </button>
                  </div>
                </div>
              </details>
            </>
          )}

          {step === 3 && (
            <>
              <header className="page-head">
                <h1 className="page-title">{setup?.generationReady ? "Ready to Generate" : "Almost There"}</h1>
                <p className="page-sub">
                  {setupReady
                    ? "Chart generation is installed and ready. Drop a song on the Generate page to make your first chart."
                    : "Browser preview mode does not run chart generation or download the chart generation package."}
                </p>
              </header>
            </>
          )}

            {message && (
              <div
                className={`settings-message ${message.tone === "ok" ? "play-info" : "play-error"}`}
                role={message.tone === "ok" ? "status" : "alert"}
                aria-live={message.tone === "ok" ? "polite" : "assertive"}
              >
                {message.tone === "ok" && <I.check />}
                <span>{message.text}</span>
              </div>
            )}
          </div>
        </section>

        <footer className="setup-footer">
          <div className="setup-footer-inner">
            <button className="settings-secondary" onClick={back} disabled={Boolean(busy) || step === 0}>
              Back
            </button>
            <div className="setup-footer-spacer" />
            {step < STEPS.length - 1 ? (
              <button className="btn-primary" onClick={next} disabled={Boolean(busy)}>
                Continue
              </button>
            ) : (
              <>
                {setup?.browserOnly && !setup?.generationReady && (
                  <button className="settings-secondary" onClick={() => finishSetup({ browserPreview: true })} disabled={Boolean(busy)}>
                    Open Browser Preview (No Generation)
                  </button>
                )}
                <button
                  className="btn-primary"
                  onClick={() => finishSetup()}
                  disabled={Boolean(busy) || !setup?.generationReady}
                  aria-describedby="setup-finish-reason"
                  title={finishDisabledReason || "Start chart generation"}
                >
                  Start Generating
                </button>
                <span id="setup-finish-reason" className="sr-only">{finishDisabledReason}</span>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
