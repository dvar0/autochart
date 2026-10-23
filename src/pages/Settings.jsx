import { useEffect, useState } from "react";
import { I } from "../icons.jsx";
import { generationDownloadSize } from "../components/GenerationPipeline.jsx";
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
import { BETA_MODELS, MODEL_FAMILIES, defaultGeneratorIdFrom, isBetaGenerator } from "../data/modelFamilies.js";
import {
  chooseCacheFolder,
  chooseCloneHeroLibraryFolder,
  chooseModelsFolder,
  chooseProjectsFolder,
  clearCacheFolder,
  dismissSettingsRecoveryNotice,
  getAppSettings,
  openSettingsPath,
  resetSettingsPath,
  updateAppSettings,
} from "../services/appSettings.js";
import { listGenerators } from "../services/generation.js";
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
  defaultGeneratorId: "",
  fillInDrafts: false,
  pathDefaults: null,
  homeFolder: "",
  settingsRecovery: null,
};

const FOLDER_ROWS = [
  { key: "cloneHeroLibraryFolder", title: "Clone Hero / YARG songs", choose: chooseCloneHeroLibraryFolder },
  { key: "projectsFolder", title: "Projects", choose: chooseProjectsFolder },
  { key: "cacheFolder", title: "Cache", choose: chooseCacheFolder },
  { key: "modelsFolder", title: "Model files", choose: chooseModelsFolder },
];

const FILL_IN_DRAFTS_HELP =
  "Fill-in normally redoes the bars you pick in Inpaint. Turn this on to also use it in Generate to write "
  + "a whole chart, and to pick it for new projects. It's still experimental.";

const NOTICE_BUTTONS = [
  { key: "releaseNotes", label: "Release notes" },
  { key: "thirdParty", label: "Licenses" },
  { key: "ffmpegLicense", label: "FFmpeg license" },
  { key: "privacy", label: "Privacy" },
];

// Last values the page saw. Revisits render these immediately and refresh them
// in the background instead of waiting on the model scan again.
const lastLoaded = { settings: null, setup: null, hardware: null, manifest: null };

function shortPath(value, home) {
  if (!value) return "";
  if (home && (value === home || value.startsWith(home + "/") || value.startsWith(home + "\\"))) {
    return "~" + value.slice(home.length);
  }
  return value;
}

function gpuName(hardware) {
  const name = hardware?.nvidia?.detected ? hardware.nvidia.gpus?.[0]?.name || "" : "";
  return name.replace(/^NVIDIA\s+(GeForce\s+)?/i, "");
}

function performanceSummary(hardware, unsupported) {
  if (unsupported) return `${friendlyTarget(hardware)} is unsupported.`;
  if (!hardware) return "Checking hardware…";
  const device = hardware.selectedMode === "cpu"
    ? hardware.cpu
    : hardware.selectedMode === "coreml"
      ? "Apple Silicon"
      : gpuName(hardware);
  return `Using ${hardware.selectedModeLabel}${device ? ` · ${device}` : ""}`;
}

// One status for a family's generators: ready, missing, partial (some files),
// or repair (a file failed verification).
function familyStatus(family, generatorsById, manifestLoaded) {
  if (!manifestLoaded) return "checking";
  const statuses = [family.generatorId, family.inpaintGeneratorId]
    .filter(Boolean)
    .map((id) => generatorsById.get(id)?.setup?.status || "missing");
  if (statuses.includes("unsupported")) return "unsupported";
  if (statuses.some((status) => status === "corrupt" || status === "partial")) return "repair";
  if (statuses.every((status) => status === "ready")) return "ready";
  return statuses.some((status) => status === "ready") ? "partial" : "missing";
}

function StatusPill({ status }) {
  const value = status || "missing";
  return <span className={`setup-status ${value}`}>{humanizeStatus(value)}</span>;
}

function ComponentCard({ component }) {
  const files = Array.isArray(component.files) ? component.files : [];
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

// Model file checks, hardware, and the folders the scan looked in. Opens over
// the page so the main cards keep their layout.
function DiagnosticsSheet({ setup, hardware, busy, onCheck, onClose }) {
  const components = setup?.components || [];
  const chartComponents = components.filter((component) => component.kind === "chart-model");
  const runtimeComponents = components.filter((component) => component.kind === "runtime");
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="settings-sheet-scrim" onClick={onClose} aria-hidden="true" />
      <section className="settings-sheet" role="dialog" aria-label="Diagnostics">
        <header className="ms-head">
          <h2>Diagnostics</h2>
          <button type="button" className="ms-close" onClick={onClose} aria-label="Close diagnostics" title="Close (Esc)">
            <I.plus />
          </button>
        </header>
        <div className="settings-sheet-body">
          <div className="advanced-row">
            <div>
              <b>Model files</b>
              <small>Checks every installed file against its checksum.</small>
            </div>
            <div className="advanced-row-actions">
              <StatusPill status={setup ? setup.combinedStatus || setup.standardPack?.status || "missing" : "checking"} />
              <button
                className="settings-secondary"
                onClick={onCheck}
                disabled={Boolean(busy)}
                title={busy ? "Wait for the current settings operation to finish." : "Check the model files again"}
              >
                <I.spark /> {busy === "loading" ? "Checking…" : "Check files"}
              </button>
            </div>
          </div>
          {[...chartComponents, ...runtimeComponents].map((component) => (
            <ComponentCard key={component.id} component={component} />
          ))}
          {hardware && (
            <div className="hardware-details">
              <div><span>Platform</span><b>{friendlyTarget(hardware)}</b></div>
              {hardware.supportLabel && <div><span>Support</span><b>{humanizeSupportLabel(hardware.supportLabel)}</b></div>}
              <div><span>CPU</span><b>{hardware.cpu || "Unknown"}</b></div>
              <div><span>GPU</span><b>{hardware.nvidia?.detected ? hardware.nvidia.gpus.map((gpu) => gpu.name).join(", ") : "Not detected"}</b></div>
              <div><span>Runtime</span><b>{humanizeRuntime(hardware.selectedRuntimePack)}</b></div>
              <div><span>Provider</span><b>{humanizeStatus(hardware.providerStatus)}</b></div>
            </div>
          )}
          {setup?.sourceRoots?.length > 0 && (
            <div className="setup-file-list">
              <b className="settings-sheet-label">Folders checked</b>
              {setup.sourceRoots.map((root) => (
                <div className="setup-file-row" key={root}>
                  <span>{root}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}

export default function Settings() {
  const [settings, setSettingsState] = useState(() => lastLoaded.settings || EMPTY_SETTINGS);
  const [setup, setSetupState] = useState(() => lastLoaded.setup);
  const [hardware, setHardwareState] = useState(() => lastLoaded.hardware);
  const [manifest, setManifestState] = useState(() => lastLoaded.manifest);
  const setSettings = (next) => setSettingsState((current) => {
    const value = typeof next === "function" ? next(current) : next;
    lastLoaded.settings = value;
    return value;
  });
  const setSetup = (value) => {
    lastLoaded.setup = value;
    setSetupState(value);
  };
  const setHardware = (value) => {
    lastLoaded.hardware = value;
    setHardwareState(value);
  };
  const setManifest = (value) => {
    lastLoaded.manifest = value;
    setManifestState(value);
  };
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [installProgress, setInstallProgress] = useState(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  // Each source fills in as soon as it answers; settings are instant, the
  // model scan is the slow one. Only an explicit rescan blocks the controls.
  const loadAll = async ({ fresh = false } = {}) => {
    if (fresh) setBusy("loading");
    setMessage("");
    try {
      await Promise.all([
        getAppSettings().then((next) => setSettings({ ...EMPTY_SETTINGS, ...next })),
        scanModelSetup({ fresh }).then(setSetup),
        probeHardware().then(setHardware),
      ]);
      // After the scan so a fresh check's digests are reused here.
      setManifest(await listGenerators());
    } catch (err) {
      setMessage({ text: err.message || "Could not load settings.", tone: "error" });
    } finally {
      if (fresh) setBusy("");
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => subscribeModelInstallEvents(setInstallProgress), []);

  const refreshModels = async () => {
    const [nextSetup, nextHardware] = await Promise.all([scanModelSetup(), probeHardware()]);
    setSetup(nextSetup);
    setHardware(nextHardware);
    setManifest(await listGenerators());
  };

  const runAction = async (label, action) => {
    setBusy(label);
    setMessage("");
    try {
      const result = await action();
      if (result?.settings) setSettings({ ...EMPTY_SETTINGS, ...result.settings });
      else if (result && ("projectsFolder" in result || "setupComplete" in result)) {
        setSettings({ ...EMPTY_SETTINGS, ...result });
      }
      if (label !== "opening") await refreshModels();
      setMessage(
        result?.canceled || label === "opening"
          ? ""
          : label === "clear-cache"
            ? "Cache cleared."
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
      await refreshModels();
    } catch (err) {
      setMessage({ text: err.message || "Could not update hardware mode.", tone: "error" });
    } finally {
      setBusy("");
    }
  };

  // Model preferences save quietly: the selected row and the switch show the result.
  const updateModelPreference = async (patch) => {
    const previous = settings;
    setSettings((current) => ({ ...current, ...patch }));
    try {
      const next = await updateAppSettings(patch);
      setSettings({ ...EMPTY_SETTINGS, ...next });
    } catch (err) {
      setSettings(previous);
      setMessage({ text: err.message || "Could not save the model setting.", tone: "error" });
    }
  };

  const installModels = async () => {
    setBusy("installing-models");
    setMessage("");
    setInstallProgress({ phase: "starting", percent: 0, message: "Preparing download." });
    try {
      const result = await installAssets();
      if (result?.settings) setSettings({ ...EMPTY_SETTINGS, ...result.settings });
      if (result?.setup) setSetup(result.setup);
      await refreshModels();
      setInstallProgress((current) => ({ ...(current || {}), phase: "complete", percent: 100 }));
      setMessage("Model installed.");
    } catch (err) {
      setInstallProgress((current) => ({ ...(current || {}), phase: "failed" }));
      setMessage({ text: err.message || "Could not install the model.", tone: "error" });
    } finally {
      setBusy("");
    }
  };

  const openBundledNotice = async (key) => {
    try {
      const opened = await openNotice(key);
      if (!opened) {
        setMessage({ text: "Notices are available in the desktop app.", tone: "info" });
      }
    } catch (err) {
      setMessage({ text: err.message || "Could not open the notice.", tone: "error" });
    }
  };

  const generators = manifest?.generators || [];
  const generatorsById = new Map(generators.map((generator) => [generator.id, generator]));
  const manifestLoaded = Boolean(manifest);
  const preferences = { defaultGeneratorId: settings.defaultGeneratorId, fillInDrafts: settings.fillInDrafts };
  const defaultGeneratorId = defaultGeneratorIdFrom(generators, preferences);
  const isReady = (generatorId) => Boolean(generatorsById.get(generatorId)?.setup?.ready);

  const standardPack = setup?.standardPack;
  const unsupported = setup?.combinedStatus === "unsupported" || hardware?.supportedPlatform === false;
  const targetPlatform = setup?.platform || hardware?.platform || electronPlatform();
  const hardwareModes = hardwareModesForPlatform(targetPlatform);
  const selectedHardwareMode = hardwareModeForPlatform(settings.hardwareMode, targetPlatform);
  const home = settings.homeFolder;

  const messageText = typeof message === "string" ? message : message?.text;
  const messageTone = typeof message === "object" ? message.tone : "success";

  const familyAction = (family) => {
    const status = familyStatus(family, generatorsById, manifestLoaded);
    const downloadable = standardPack?.defaultGeneratorId === family.generatorId;
    if (status === "checking") return <StatusPill status="checking" />;
    if (status === "ready") return <StatusPill status="ready" />;
    if (status === "unsupported") return <StatusPill status="unsupported" />;
    const installing = busy === "installing-models" && downloadable;
    const label = installing
      ? "Installing…"
      : status === "missing"
        ? `Download${downloadable ? ` · ${generationDownloadSize(standardPack)}` : ""}`
        : "Repair";
    const reason = !downloadable
      ? "Not available to download yet."
      : busy && !installing
        ? "Wait for the current settings operation to finish."
        : "";
    return (
      <>
        <button
          className={(downloadable ? "btn-primary" : "settings-secondary") + " model-action"}
          onClick={installModels}
          disabled={!downloadable || Boolean(busy)}
          aria-describedby={`settings-install-reason-${family.id}`}
          title={reason || `Download ${family.label}`}
        >
          {label}
        </button>
        <span id={`settings-install-reason-${family.id}`} className="sr-only">{reason}</span>
      </>
    );
  };

  // One row per model; picking a row makes it the model new projects start
  // with. Beta models come with a family's download and can only be picked
  // while "Write whole charts" is on.
  const modelRows = [
    ...MODEL_FAMILIES.map((family) => ({
      ...family,
      action: familyAction(family),
      pickable: isReady(family.generatorId),
      reason: `Download ${family.label} first`,
    })),
    ...BETA_MODELS.map((model) => {
      const family = MODEL_FAMILIES.find((item) => item.id === model.familyId);
      const installed = isReady(model.generatorId);
      return {
        ...model,
        action: installed ? <StatusPill status="ready" /> : <span className="model-row-note">With {family.label}</span>,
        pickable: installed && settings.fillInDrafts,
        reason: installed ? "Turn on Write whole charts first" : `Download ${family.label} first`,
      };
    }),
  ];

  const setFillInDrafts = (on) => {
    const patch = { fillInDrafts: on };
    // Turning drafting off moves new projects back to the recommended model.
    if (!on && isBetaGenerator(defaultGeneratorId)) {
      patch.defaultGeneratorId = MODEL_FAMILIES.find((family) => family.recommended)?.generatorId || "";
    }
    void updateModelPreference(patch);
  };

  return (
    <div className="ac-body settings-page">
      <main className="settings-main">
        <header className="page-head settings-head">
          <h1 className="page-title">Settings</h1>
          <button className="settings-secondary" onClick={() => setDiagnosticsOpen(true)} title="Model files and hardware">
            <I.info /> Diagnostics
          </button>
        </header>

        {settings.settingsRecovery && (
          <section className="settings-card settings-recovery" role="status">
            <div>
              <h2 className="settings-card-title">Your settings were reset</h2>
              <p className="settings-card-sub">
                The old settings file couldn't be read. It's saved at <code>{settings.settingsRecovery.backupPath}</code>.
              </p>
            </div>
            <button
              className="settings-secondary"
              disabled={Boolean(busy)}
              onClick={() => runAction("dismiss-recovery", dismissSettingsRecoveryNotice)}
            >
              Dismiss
            </button>
          </section>
        )}

        <div className="settings-grid">
          <section className="settings-card settings-models" aria-labelledby="settings-models-title">
            <div className="settings-card-head">
              <h2 className="settings-card-title" id="settings-models-title">Models</h2>
              <span className="settings-card-hint" id="settings-models-pick">Pick the one new projects start with</span>
            </div>

            <div
              className="model-list"
              role="radiogroup"
              aria-labelledby="settings-models-title"
              aria-describedby="settings-models-pick"
            >
              {modelRows.map((row) => {
                const selected = defaultGeneratorId === row.generatorId;
                return (
                  <div className={"model-row" + (selected ? " selected" : "")} key={row.id}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className="model-pick"
                      onClick={() => updateModelPreference({ defaultGeneratorId: row.generatorId })}
                      disabled={!row.pickable}
                      title={row.pickable ? `Start new projects with ${row.label}` : row.reason}
                    >
                      <span className="model-radio" aria-hidden="true" />
                      <span className={`model-badge ${row.id}`} aria-hidden="true">{row.badge}</span>
                      <span className="model-row-copy">
                        <span className="model-row-name">
                          <b>{row.label}</b>
                          {row.recommended && <span className="model-tag recommended">Recommended</span>}
                        </span>
                        <small>{row.about}</small>
                      </span>
                    </button>
                    <div className="model-row-action">{row.action}</div>
                    {isBetaGenerator(row.generatorId) && (
                      <div className="model-row-option">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={settings.fillInDrafts}
                          aria-labelledby="settings-fill-in-drafts"
                          className={"ms-toggle" + (settings.fillInDrafts ? " on" : "")}
                          onClick={() => setFillInDrafts(!settings.fillInDrafts)}
                        >
                          <span className="ms-toggle-knob" aria-hidden="true" />
                          {settings.fillInDrafts ? "On" : "Off"}
                        </button>
                        <span id="settings-fill-in-drafts">Write whole charts</span>
                        <span className="model-tag beta">Beta</span>
                        <i
                          className="ms-info"
                          role="img"
                          aria-label={FILL_IN_DRAFTS_HELP}
                          title={FILL_IN_DRAFTS_HELP}
                        >
                          <I.info />
                        </i>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {(busy === "installing-models" || installProgress) && <InstallProgress progress={installProgress} />}
          </section>

          <section className="settings-card settings-folders" aria-labelledby="settings-folders-title">
            <div className="settings-card-head">
              <h2 className="settings-card-title" id="settings-folders-title">Folders</h2>
            </div>
            <div className="folder-list">
              {FOLDER_ROWS.map((row) => {
                const value = settings[row.key];
                const atDefault = settings.pathDefaults ? value === (settings.pathDefaults[row.key] || "") : false;
                return (
                  <div className="folder-row" key={row.key}>
                    <div className="folder-row-copy">
                      <b>{row.title}</b>
                      <span className={"folder-path" + (value ? "" : " empty")} title={value || ""}>
                        {value ? shortPath(value, home) : "Not set"}
                      </span>
                    </div>
                    <div className="folder-row-actions">
                      <button
                        className="settings-secondary"
                        onClick={() => runAction("opening", () => openSettingsPath(row.key))}
                        disabled={Boolean(busy) || !value}
                        title="Open folder"
                      >
                        <I.open /> Open
                      </button>
                      <button
                        className="settings-secondary"
                        onClick={() => runAction(row.key, row.choose)}
                        disabled={Boolean(busy)}
                        title="Choose another folder"
                      >
                        <I.inbox /> Change
                      </button>
                      <button
                        className="settings-secondary"
                        onClick={() => runAction(`reset-${row.key}`, () => resetSettingsPath(row.key))}
                        disabled={Boolean(busy) || atDefault}
                        title={atDefault ? "Already the default" : "Go back to the default folder"}
                      >
                        <I.undo /> Reset
                      </button>
                      {row.key === "cacheFolder" && (
                        <button
                          className="settings-secondary"
                          onClick={confirmAndClearCache}
                          disabled={Boolean(busy) || !value}
                          title="Delete separated stems and analysis"
                        >
                          <I.trash /> Clear
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="settings-card settings-perf" aria-labelledby="settings-perf-title">
            <div className="settings-card-head">
              <h2 className="settings-card-title" id="settings-perf-title">Performance</h2>
              <span className="settings-card-hint" title={hardwareModeCaveat(settings.hardwareMode, targetPlatform)}>
                {performanceSummary(hardware, unsupported)}
              </span>
            </div>
            <div
              className="perf-modes"
              role="radiogroup"
              aria-labelledby="settings-perf-title"
              style={{ gridTemplateColumns: `repeat(${hardwareModes.length}, minmax(0, 1fr))` }}
            >
              {hardwareModes.map((mode) => (
                <button
                  key={mode.value}
                  role="radio"
                  aria-checked={selectedHardwareMode === mode.value}
                  className={selectedHardwareMode === mode.value ? "active" : ""}
                  onClick={() => updateHardwareMode(mode.value)}
                  disabled={Boolean(busy) || unsupported}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            {hardware?.fallbackReason && <p className="settings-card-sub warn">{hardware.fallbackReason}</p>}
          </section>

          <section className="settings-card settings-about" aria-labelledby="settings-about-title">
            <div className="settings-card-head">
              <h2 className="settings-card-title" id="settings-about-title">About</h2>
              <span className="settings-card-hint">Everything stays on this computer. No telemetry.</span>
            </div>
            <div className="about-links">
              {NOTICE_BUTTONS.map((notice) => (
                <button key={notice.key} className="settings-secondary" onClick={() => openBundledNotice(notice.key)}>
                  {notice.label}
                </button>
              ))}
              <a className="settings-secondary" href={NOTICE_LINKS.ffmpeg} target="_blank" rel="noreferrer">
                FFmpeg legal
              </a>
            </div>
          </section>
        </div>

        {diagnosticsOpen && (
          <DiagnosticsSheet
            setup={setup}
            hardware={hardware}
            busy={busy}
            onCheck={() => loadAll({ fresh: true })}
            onClose={() => setDiagnosticsOpen(false)}
          />
        )}

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
