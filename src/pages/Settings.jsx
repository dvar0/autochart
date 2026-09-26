import { useEffect, useState } from "react";
import { I } from "../icons.jsx";
import { GAME_LIBRARY_NAME } from "../data/gameLibrary.js";
import GenerationPipeline, { generationDownloadSize } from "../components/GenerationPipeline.jsx";
import InstallProgress from "../components/InstallProgress.jsx";
import {
  friendlyTarget,
  hardwareModeCaveat,
  hardwareModeForPlatform,
  hardwareModesForPlatform,
  humanizeStatus,
  humanizeRuntime,
  humanizeSupportLabel,
  normalizeHardwareMode,
} from "../data/hardwareModes.js";
import { SUPPORTED_TARGETS } from "../data/supportedTargets.js";
import {
  chooseCacheFolder,
  chooseCloneHeroLibraryFolder,
  chooseModelsFolder,
  chooseProjectsFolder,
  clearCacheFolder,
  clearCloneHeroLibraryFolder,
  dismissSettingsRecoveryNotice,
  getAppSettings,
  openSettingsPath,
  resetSettingsPath,
  updateAppSettings,
} from "../services/appSettings.js";
import { installAssets, probeHardware, scanModelSetup, subscribeModelInstallEvents } from "../services/modelSetup.js";
import { NOTICE_LINKS, openNotice } from "../services/notices.js";
import { electronPlatform } from "../services/runtimeBridge.js";

const EMPTY_SETTINGS = {
  setupComplete: false,
  cloneHeroLibraryFolder: "",
  projectsFolder: "",
  modelsFolder: "",
  cacheParentFolder: "",
  cacheFolder: "",
  hardwareMode: "auto",
  updateChannel: "stable",
  assetBaseUrl: "",
  defaults: {},
  settingsRecovery: null,
};

const STORAGE_ROWS = [
  {
    key: "projectsFolder",
    title: "Projects",
    copy: "Your projects and generated chart takes.",
    empty: "No projects folder selected",
    choose: chooseProjectsFolder,
  },
  {
    key: "modelsFolder",
    title: "Chart generation files folder",
    copy: "Downloaded Demucs, Beat This, and Fretformer files plus their license notices.",
    empty: "No chart generation files folder selected",
    choose: chooseModelsFolder,
  },
  {
    key: "cacheFolder",
    title: "Cache",
    copy: "Reusable audio analysis and separated stems in an app-owned cache directory.",
    empty: "No cache folder selected",
    choose: chooseCacheFolder,
  },
  {
    key: "cloneHeroLibraryFolder",
    title: "Clone Hero / YARG library",
    copy: `Where Autochart saves playable song copies for ${GAME_LIBRARY_NAME}.`,
    empty: "No library folder selected",
    choose: chooseCloneHeroLibraryFolder,
  },
];

function packComponentIds(pack) {
  return new Set((pack?.components || []).map((component) => component.id || component).filter(Boolean));
}


function PathBox({ value, empty }) {
  return <div className={"settings-path" + (!value ? " empty" : "")}>{value || empty}</div>;
}

function StatusPill({ status }) {
  const value = status || "missing";
  return <span className={`setup-status ${value}`}>{humanizeStatus(value)}</span>;
}

function ComponentCard({ component }) {
  const files = Array.isArray(component.files) ? component.files : [];
  const difficulties = component.capabilities?.difficulties || [];
  const bestFor = component.capabilities?.bestFor || [];
  return (
    <div className="setup-component">
      <div className="setup-component-main">
        <div>
          <h3>{component.label}</h3>
          <p>{component.message || component.kind}</p>
        </div>
        <StatusPill status={component.status} />
      </div>
      <div className="setup-component-meta">
        <span>{component.kind}</span>
        {component.version && <span>{component.version}</span>}
        {component.license && <span>{component.license}</span>}
        {difficulties.map((difficulty) => (
          <span key={difficulty}>{difficulty}</span>
        ))}
        {bestFor.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      {files.length > 0 && (
        <details className="setup-details">
          <summary>Exact files</summary>
          <div className="setup-file-list">
            {files.map((file, index) => (
              <div key={`${file.path}-${index}`} className="setup-file-row">
                <StatusPill status={file.status} />
                <span>{file.resolvedPath || file.path}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export default function Settings() {
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [setup, setSetup] = useState(null);
  const [hardware, setHardware] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [installProgress, setInstallProgress] = useState(null);

  const loadAll = async () => {
    setBusy("loading");
    setMessage("");
    try {
      const [nextSettings, nextSetup, nextHardware] = await Promise.all([
        getAppSettings(),
        scanModelSetup(),
        probeHardware(),
      ]);
      setSettings({ ...EMPTY_SETTINGS, ...nextSettings });
      setSetup(nextSetup);
      setHardware(nextHardware);
    } catch (err) {
      setMessage({ text: err.message || "Could not load settings.", tone: "error" });
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => subscribeModelInstallEvents(setInstallProgress), []);

  const runAction = async (label, action) => {
    setBusy(label);
    setMessage("");
    try {
      const result = await action();
      if (result?.settings) setSettings({ ...EMPTY_SETTINGS, ...result.settings });
      else if (result && ("projectsFolder" in result || "setupComplete" in result)) {
        setSettings({ ...EMPTY_SETTINGS, ...result });
      }
      if (label !== "opening") {
        const [nextSetup, nextHardware] = await Promise.all([scanModelSetup(), probeHardware()]);
        setSetup(nextSetup);
        setHardware(nextHardware);
      }
      setMessage(
        result?.canceled
          ? ""
          : label === "opening"
            ? "Opened folder."
            : label === "clear-cache"
              ? `Cleared Autochart cache at ${result.path}.`
              : "Settings updated."
      );
    } catch (err) {
      setMessage({ text: err.message || "Settings action failed.", tone: "error" });
    } finally {
      setBusy("");
    }
  };

  const confirmAndClearCache = () => {
    const cachePath = settings.cacheFolder;
    if (!cachePath) return;
    const confirmed = window.confirm(
      `Clear Autochart cache?\n\nThis permanently deletes only Autochart's owned cache directory:\n${cachePath}\n\nThis cannot be undone.`
    );
    if (confirmed) {
      void runAction("clear-cache", () => clearCacheFolder(cachePath));
    }
  };

  const updateHardwareMode = async (mode) => {
    setBusy("hardwareMode");
    setMessage("");
    try {
      const next = await updateAppSettings({ hardwareMode: normalizeHardwareMode(mode) });
      setSettings({ ...EMPTY_SETTINGS, ...next });
      const [nextSetup, nextHardware] = await Promise.all([scanModelSetup(), probeHardware()]);
      setSetup(nextSetup);
      setHardware(nextHardware);
    } catch (err) {
      setMessage({ text: err.message || "Could not update hardware mode.", tone: "error" });
    } finally {
      setBusy("");
    }
  };

  const saveAssetBaseUrl = async () => {
    setBusy("asset-source");
    setMessage("");
    try {
      const next = await updateAppSettings({ assetBaseUrl: settings.assetBaseUrl || "" });
      setSettings({ ...EMPTY_SETTINGS, ...next });
      setMessage("Download source updated.");
    } catch (err) {
      setMessage({ text: err.message || "Could not update download source.", tone: "error" });
    } finally {
      setBusy("");
    }
  };

  const installModels = async () => {
    setBusy("installing-models");
    setMessage(`Downloading the chart generation package (about ${generationDownloadSize(setup?.standardPack)}). This can take a while.`);
    setInstallProgress({ phase: "starting", percent: 0, message: "Preparing download." });
    try {
      const result = await installAssets();
      if (result?.settings) setSettings({ ...EMPTY_SETTINGS, ...result.settings });
      if (result?.setup) setSetup(result.setup);
      else setSetup(await scanModelSetup());
      setInstallProgress((current) => ({ ...(current || {}), phase: "complete", percent: 100 }));
      setMessage(`The chart generation package is installed and verified at ${result?.install?.path || settings.modelsFolder || "the chart generation files folder"}.`);
    } catch (err) {
      setInstallProgress((current) => ({ ...(current || {}), phase: "failed" }));
      setMessage({ text: err.message || "Could not install the chart generation package.", tone: "error" });
    } finally {
      setBusy("");
    }
  };

  const openBundledNotice = async (key) => {
    try {
      const opened = await openNotice(key);
      if (!opened) {
        setMessage({ text: "Bundled notices are available in the desktop app package.", tone: "info" });
      }
    } catch (err) {
      setMessage({ text: err.message || "Could not open the notice.", tone: "error" });
    }
  };
  const components = setup?.components || [];
  const standardPack = setup?.standardPack;
  const standardIds = packComponentIds(standardPack);
  const chartComponents = components.filter((component) => component.kind === "chart-model");
  const runtimeComponents = components.filter((component) => component.kind === "runtime");
  const standardChartComponents = chartComponents.filter((component) => standardIds.has(component.id));
  const standardRuntimeComponents = runtimeComponents.filter((component) => standardIds.has(component.id));
  const optionalRuntimeComponents = runtimeComponents.filter((component) => !standardIds.has(component.id));
  const setupLoading = busy === "loading" && !setup;
  const readyCount = setup?.readyGeneratorIds?.length || 0;
  const chartStatus = setupLoading
    ? "checking"
    : setup?.combinedStatus || standardPack?.status || "missing";
  const unsupported = chartStatus === "unsupported" || hardware?.supportedPlatform === false;
  const installButtonLabel = busy === "installing-models"
    ? "Installing…"
    : unsupported
      ? "Unavailable"
      : chartStatus === "ready"
        ? "Installed"
        : chartStatus === "partial" || chartStatus === "corrupt"
          ? "Repair Package"
          : "Download Package";
  const installDisabled = Boolean(busy) || unsupported || ["ready", "checking"].includes(chartStatus);
  const installDisabledReason = unsupported
    ? setup?.message || `${friendlyTarget(setup || hardware)} is unsupported for chart generation.`
    : busy
      ? "Wait for the current settings operation to finish."
      : chartStatus === "ready"
        ? "The chart generation package is already installed."
        : chartStatus === "checking"
          ? "Wait for the package scan to finish."
          : "";
  const targetPlatform = setup?.platform || hardware?.platform || electronPlatform();
  const hardwareModes = hardwareModesForPlatform(targetPlatform);

  const messageText = typeof message === "string" ? message : message?.text;
  const messageTone = typeof message === "object" ? message.tone : "success";

  return (
    <div className="ac-body settings-page">
      <main className="settings-main">
        <header className="page-head">
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Storage, chart generation, and hardware.</p>
        </header>

        {settings.settingsRecovery && (
          <section className="settings-section" role="status">
            <div className="settings-section-label">SETTINGS RECOVERED</div>
            <div className="settings-row-item">
              <div className="settings-row-copy">
                <h2>Your previous settings file could not be read</h2>
                <p>
                  Autochart restored safe defaults and preserved the original file at
                  {` ${settings.settingsRecovery.backupPath}`}.
                </p>
              </div>
              <div className="settings-row-control">
                <button
                  className="settings-secondary"
                  disabled={Boolean(busy)}
                  onClick={() => runAction("dismiss-recovery", dismissSettingsRecoveryNotice)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="settings-section">
          <div className="settings-section-label">STORAGE</div>
          {STORAGE_ROWS.map((row) => (
            <div className="settings-row-item" key={row.key}>
              <div className="settings-row-copy">
                <h2>{row.title}</h2>
                <p>{row.copy}</p>
              </div>
              <div className="settings-row-control">
                <PathBox value={settings[row.key]} empty={row.empty} />
                <div className="settings-actions">
                  <button
                    className="settings-secondary"
                    onClick={() => runAction(row.key, row.choose)}
                    disabled={Boolean(busy)}
                  >
                    <I.inbox /> Choose Folder
                  </button>
                  <button
                    className="settings-secondary"
                    onClick={() => runAction("opening", () => openSettingsPath(row.key))}
                    disabled={Boolean(busy) || !settings[row.key]}
                  >
                    <I.open /> Open Folder
                  </button>
                  <button
                    className="settings-secondary"
                    onClick={() => runAction(`reset-${row.key}`, () => resetSettingsPath(row.key))}
                    disabled={Boolean(busy)}
                  >
                    Reset
                  </button>
                  {row.key === "cacheFolder" && (
                    <button
                      className="settings-secondary"
                      onClick={confirmAndClearCache}
                      disabled={Boolean(busy) || !settings.cacheFolder}
                    >
                      <I.trash /> Clear Cache
                    </button>
                  )}
                  {row.key === "cloneHeroLibraryFolder" && (
                    <button
                      className="settings-secondary"
                      onClick={() => runAction("clear-clone-hero", clearCloneHeroLibraryFolder)}
                      disabled={Boolean(busy) || !settings.cloneHeroLibraryFolder}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </section>

        <section className="settings-section">
          <div className="settings-section-label">CHART GENERATION</div>
          <div className="setup-summary-row compact">
            <div>
              <h2>Download source</h2>
              <p>Base URL that hosts the pinned Demucs, Beat This, and Fretformer files.</p>
            </div>
            <div className="settings-row-control">
              <input
                className="settings-select"
                value={settings.assetBaseUrl || ""}
                onChange={(e) => setSettings((current) => ({ ...current, assetBaseUrl: e.target.value }))}
                placeholder="https://host/path/to/autochart-assets"
                disabled={Boolean(busy)}
              />
              <div className="settings-actions">
                <button className="settings-secondary" onClick={saveAssetBaseUrl} disabled={Boolean(busy)}>
                  Save Source
                </button>
              </div>
            </div>
          </div>
          <div className="setup-summary-row">
            <div>
              <h2>Chart generation package</h2>
              <p>
                {setupLoading
                  ? "Checking the installed chart generation files…"
                  : chartStatus === "unsupported"
                    ? setup?.message || `${friendlyTarget(setup || hardware)} is unsupported.`
                    : readyCount
                      ? "Every required generation stage is installed and verified."
                      : setup?.message || "The chart generation package is not installed yet."}
              </p>
            </div>
            <div className="settings-actions">
              <StatusPill status={chartStatus} />
              <button
                className="btn-primary"
                onClick={installModels}
                disabled={installDisabled}
                aria-describedby="settings-install-reason"
                title={installDisabledReason || "Install the verified chart generation package"}
              >
                {installButtonLabel}
              </button>
              <span id="settings-install-reason" className="sr-only">{installDisabledReason}</span>
              <button className="settings-secondary" onClick={loadAll} disabled={Boolean(busy)} title={busy ? "Wait for the current settings operation to finish." : "Scan installed chart generation files again"}>
                <I.spark /> Scan Again
              </button>
            </div>
          </div>
          <p className="settings-note">
            The package is about {generationDownloadSize(standardPack)}. Autochart verifies every downloaded file before using it.
          </p>
          {(busy === "installing-models" || installProgress) && <InstallProgress progress={installProgress} />}
          <details className="setup-package-details">
            <summary>What’s included?</summary>
            <div className="setup-package-details-body">
              <GenerationPipeline pack={standardPack} />
            </div>
          </details>
          {!setupLoading && !unsupported && standardChartComponents.length === 0 && (
            <p className="settings-note">No chart generation files found. Choose a chart generation files folder above, then scan again.</p>
          )}
          {standardChartComponents.length > 0 && (
            <details className="setup-details">
              <summary>Exact file verification</summary>
              <div className="setup-component-grid">
                {standardChartComponents.map((component) => (
                  <ComponentCard key={component.id} component={component} />
                ))}
              </div>
            </details>
          )}
          {setup?.sourceRoots?.length > 0 && (
            <details className="setup-details setup-roots">
              <summary>Scanned folders</summary>
              <div className="setup-file-list">
                {setup.sourceRoots.map((root) => (
                  <div className="setup-file-row" key={root}>
                    <span>{root}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>

        <section className="settings-section">
          <div className="settings-section-label">RUNTIME AND HARDWARE</div>
          {standardRuntimeComponents.length > 0 && (
            <div className="setup-component-grid runtime-grid">
              {standardRuntimeComponents.map((component) => (
                <ComponentCard key={component.id} component={component} />
              ))}
            </div>
          )}
          {optionalRuntimeComponents.length > 0 && (
            <details className="setup-details optional-components">
              <summary>Optional runtimes</summary>
              <div className="setup-component-grid runtime-grid">
                {optionalRuntimeComponents.map((component) => (
                  <ComponentCard key={component.id} component={component} />
                ))}
              </div>
            </details>
          )}
          <div className="settings-row-item">
            <div className="settings-row-copy">
              <h2>Performance mode</h2>
              <p>
                {setupLoading
                  ? "Checking hardware…"
                  : unsupported
                    ? `${friendlyTarget(hardware || setup)} is unsupported.`
                    : hardware
                      ? `${hardware.selectedModeLabel} selected.`
                      : "Hardware has not been checked."}
              </p>
            </div>
            <div className="settings-row-control">
              <select
                className="settings-select"
                value={hardwareModeForPlatform(settings.hardwareMode, targetPlatform)}
                onChange={(e) => updateHardwareMode(e.target.value)}
                disabled={Boolean(busy) || unsupported}
                aria-label="Performance mode"
              >
                  {hardwareModes.map((mode) => (
                    <option key={mode.value} value={mode.value}>
                      {mode.label}
                  </option>
                ))}
              </select>
              <div className="settings-actions">
                <button className="settings-secondary" onClick={loadAll} disabled={Boolean(busy)}>
                  <I.bolt /> Check Again
                </button>
              </div>
              {hardware && (
                <div className="hardware-details">
                  <div><span>Platform</span><b>{friendlyTarget(hardware)}</b></div>
                  {hardware.supportLabel && <div><span>Support</span><b>{humanizeSupportLabel(hardware.supportLabel)}</b></div>}
                  <div><span>CPU</span><b>{hardware.cpu || "Unknown"}</b></div>
                  <div><span>GPU</span><b>{hardware.nvidia?.detected ? hardware.nvidia.gpus.map((gpu) => gpu.name).join(", ") : "Not detected"}</b></div>
                  <div><span>Runtime</span><b>{humanizeRuntime(hardware.selectedRuntimePack)}</b></div>
                  <div><span>Provider</span><b>{humanizeStatus(hardware.providerStatus)}</b></div>
                  {!unsupported && (
                    <div><span>Provider note</span><b>{hardware.providerCaveat || hardwareModeCaveat(settings.hardwareMode, hardware.platform)}</b></div>
                  )}
                  {hardware.fallbackReason && <div><span>Note</span><b>{hardware.fallbackReason}</b></div>}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-label">LICENSES</div>
          <div className="license-list">
            {["Autochart app", "Autochart chart models", "Beat This", "Demucs", "ONNX Runtime, Node.js, and runtime dependencies"].map((item) => (
              <div className="license-row" key={item}>
                <I.info />
                <span>{item}</span>
              </div>
            ))}
          </div>
          <p className="settings-note">
            Third-party notices are in docs/third-party-notices.md.
          </p>
        </section>

        <section className="settings-section">
          <div className="settings-section-label">RELEASE NOTICES</div>
          <div className="setup-summary-row compact">
            <div>
              <h2>Licenses and release information</h2>
              <p>
                Supported release targets: {SUPPORTED_TARGETS.map((target) => target.label).join(", ")}.
                FFmpeg is bundled for local media decoding and transforms.
              </p>
            </div>
            <div className="settings-actions">
              <button className="settings-secondary" onClick={() => openBundledNotice("thirdParty")} disabled={Boolean(busy)}>
                Open third-party notices
              </button>
              <button className="settings-secondary" onClick={() => openBundledNotice("ffmpegLicense")} disabled={Boolean(busy)}>
                Open FFmpeg LGPL notice
              </button>
              <a className="settings-secondary" href={NOTICE_LINKS.ffmpeg} target="_blank" rel="noreferrer">
                FFmpeg legal information
              </a>
            </div>
          </div>
          <p className="settings-note">
            Each public binary must be accompanied by the exact FFmpeg Corresponding Source archive and checksum
            from the same release page, at no additional charge.
          </p>
          <div className="settings-actions">
            <button className="settings-secondary" onClick={() => openBundledNotice("releaseNotes")} disabled={Boolean(busy)}>
              Open release notes
            </button>
            <button className="settings-secondary" onClick={() => openBundledNotice("privacy")} disabled={Boolean(busy)}>
              Open privacy notice
            </button>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-label">PRIVACY</div>
          <div className="setup-summary-row">
            <div>
              <h2>Local by default</h2>
              <p>Imported audio, generated charts, projects, and analysis caches stay on this computer.</p>
            </div>
          </div>
          <p className="settings-note">
            Autochart does not include telemetry. Network access is used to download the chart generation package from the configured source.
          </p>
        </section>

        {messageText && (
          <div
            className={`${messageTone === "error" ? "play-error" : "play-info"} settings-message`}
            role={messageTone === "error" ? "alert" : "status"}
            aria-live={messageTone === "error" ? "assertive" : "polite"}
          >
            {messageText}
          </div>
        )}
      </main>
    </div>
  );
}
