import { useEffect, useRef } from "react";
import {
  DEFAULT_GENERATION_CONTROLS,
  descriptorKnobsForGenerator,
  generatorMarksSolos,
  TIMING_DETECTOR_OPTIONS,
  timingDetectorLabel,
} from "../../data/generationSettings.js";
import { I } from "../../icons.jsx";

const FORCE_SOLO_INFO =
  "Only acts when the model places no solo on its own. It then starts one where it came closest to " +
  "starting one and charts the rest of the song again from there, so generation takes longer for those " +
  "songs. A forced solo can be less convincing than one the model found itself.";

function sameNumber(value, target) {
  const number = Number(value);
  return !Number.isFinite(number) || Math.abs(number - target) < 0.000001;
}

function separationLabel(artifact) {
  const name = String(artifact?.name || "Default separation").replace(/\s*\([^)]*lead-in[^)]*\)\s*$/i, "").trim();
  const regenerated = name.match(/^regenerated separation\s*(.*)$/i);
  if (regenerated) return `Remake${regenerated[1] ? ` ${regenerated[1].trim()}` : ""}`;
  return /^default separation$/i.test(name) ? "Default" : name;
}

function isDefaultSeparation(artifact) {
  return !artifact || separationLabel(artifact) === "Default";
}

// Short labels for every More-settings value that differs from its default,
// so the console row can show the popover's state without opening it.
export function changedSettingsSummary(project) {
  const {
    generationControls: c,
    selectedPreset,
    selectedGenerator,
    usesSourceChartSync,
    projectDefaultTimingDetector,
    activeDemucsArtifact,
  } = project;
  const items = [];
  if (!isDefaultSeparation(activeDemucsArtifact)) items.push(`${separationLabel(activeDemucsArtifact)} separation`);
  if (projectDefaultTimingDetector && c.timingDetector !== projectDefaultTimingDetector) {
    items.push(timingDetectorLabel(c.timingDetector, { short: true }));
  }
  if (!usesSourceChartSync && c.timingSmoothing === false) items.push("Raw beats");
  if (generatorMarksSolos(selectedGenerator)) {
    if (c.solos === false) items.push("No solos");
    else if (c.forceSolo) items.push("Forced solo");
  }
  if (!sameNumber(c.temperature, selectedPreset.temperature)) items.push(`Temp ${c.temperature}`);
  if (!sameNumber(c.topP, selectedPreset.topP)) items.push(`Top-p ${c.topP}`);
  const knobsSet = selectedGenerator?.capabilities?.descriptorKnobs
    && descriptorKnobsForGenerator(selectedGenerator).some((knob) => (c[knob.key] ?? "auto") !== "auto");
  if (knobsSet && !sameNumber(c.guidanceScale, Number(DEFAULT_GENERATION_CONTROLS.guidanceScale))) {
    items.push(`Guidance ${c.guidanceScale}`);
  }
  return items;
}

function Toggle({ on, onClick, disabled }) {
  return (
    <button
      type="button"
      className={"ms-toggle" + (on ? " on" : "")}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
    >
      <span className="ms-toggle-knob" aria-hidden="true" />
      {on ? "On" : "Off"}
    </button>
  );
}

function Row({ label, hint, info, children, disabled }) {
  return (
    <div className={"ms-row" + (disabled ? " is-off" : "")}>
      <div className="ms-row-label">
        <b>
          {label}
          {info && (
            <i className="ms-info" title={info} aria-label={info} role="img">
              <I.info />
            </i>
          )}
        </b>
        <small>{hint}</small>
      </div>
      <div className="ms-row-control">{children}</div>
    </div>
  );
}

// Everything that isn't on the console itself: separation, timing, solos and
// raw sampling. A compact popover hanging off the console's left edge; it
// keeps one fixed layout, so settings a model doesn't have are disabled, not
// hidden. Esc or a click outside closes it.
export default function MoreSettings({ project }) {
  const {
    busy,
    generationControls: c,
    setGenerationControls,
    updateGenerationControl,
    updateAdvancedNumberControl,
    selectedGenerator,
    selectedPreset,
    hasSourceChartSync,
    usesSourceChartSync,
    projectDefaultTimingDetector,
    activeDemucsArtifact,
    setDeckTab,
    setAdvancedSettingsOpen,
  } = project;
  const panelRef = useRef(null);

  const close = () => setAdvancedSettingsOpen(false);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setAdvancedSettingsOpen(false);
    };
    const onPointer = (e) => {
      if (panelRef.current?.contains(e.target) || e.target.closest?.(".more-settings-row")) return;
      setAdvancedSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [setAdvancedSettingsOpen]);

  const marksSolos = generatorMarksSolos(selectedGenerator);
  const hasKnobs = Boolean(selectedGenerator?.capabilities?.descriptorKnobs);
  const knobsSet = hasKnobs
    && descriptorKnobsForGenerator(selectedGenerator).some((knob) => (c[knob.key] ?? "auto") !== "auto");
  const timingOptions = TIMING_DETECTOR_OPTIONS.filter((option) => !option.sourceChart || hasSourceChartSync);
  const smoothingOn = c.timingSmoothing !== false;
  const changed = changedSettingsSummary(project);

  const resetAll = () => {
    setGenerationControls((current) => ({
      ...current,
      temperature: selectedPreset.temperature.toFixed(2),
      topP: selectedPreset.topP.toFixed(2),
      guidanceScale: DEFAULT_GENERATION_CONTROLS.guidanceScale,
      timingDetector: projectDefaultTimingDetector,
      timingSmoothing: DEFAULT_GENERATION_CONTROLS.timingSmoothing,
      solos: DEFAULT_GENERATION_CONTROLS.solos,
      forceSolo: DEFAULT_GENERATION_CONTROLS.forceSolo,
    }));
  };

  return (
    <section ref={panelRef} className="more-settings" role="dialog" aria-label="More settings">
      <header className="ms-head">
        <h2>More settings</h2>
        <button type="button" className="ms-reset" onClick={resetAll} disabled={busy || !changed.length}>
          Reset
        </button>
        <button type="button" className="ms-close" onClick={close} aria-label="Close more settings" title="Close (Esc)">
          <I.plus />
        </button>
      </header>

      <div className="ms-body">
        <div className="ms-group">
          <h3>Audio separation</h3>
          <p className="ms-group-note">
            Splits the song so the model hears the guitar on its own. If a chart misses parts, try another one.
          </p>
          <Row label="New takes use" hint={activeDemucsArtifact?.name || "Default separation"}>
            <button
              type="button"
              className="ms-link-btn"
              onClick={() => {
                close();
                setDeckTab("demucs");
              }}
              disabled={busy}
            >
              {separationLabel(activeDemucsArtifact)} <I.chevRight />
            </button>
          </Row>
        </div>

        <div className="ms-group">
          <h3>Timing</h3>
          <Row label="Beat map" hint={usesSourceChartSync ? "taken from the imported chart" : "found from the audio"}>
            <select
              value={c.timingDetector}
              onChange={(e) => updateGenerationControl("timingDetector", e.target.value)}
              disabled={busy || timingOptions.length < 2}
            >
              {timingOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
          </Row>
          <Row
            label="Smoothing"
            hint={usesSourceChartSync ? "the imported chart is already steady" : "steadies the beat spacing"}
            disabled={usesSourceChartSync}
          >
            <Toggle
              on={smoothingOn && !usesSourceChartSync}
              onClick={() => updateGenerationControl("timingSmoothing", !smoothingOn)}
              disabled={busy || usesSourceChartSync}
            />
          </Row>
        </div>

        <div className="ms-group">
          <h3>Solos</h3>
          <Row
            label="Mark solos"
            hint={marksSolos ? "where the model hears one" : "this model doesn't mark solos"}
            disabled={!marksSolos}
          >
            <Toggle
              on={marksSolos && c.solos !== false}
              onClick={() => updateGenerationControl("solos", c.solos === false)}
              disabled={busy || !marksSolos}
            />
          </Row>
          <Row
            label="Force a solo"
            hint="adds one if the model found none"
            info={FORCE_SOLO_INFO}
            disabled={!marksSolos || c.solos === false}
          >
            <Toggle
              on={marksSolos && c.solos !== false && Boolean(c.forceSolo)}
              onClick={() => updateGenerationControl("forceSolo", !c.forceSolo)}
              disabled={busy || !marksSolos || c.solos === false}
            />
          </Row>
        </div>

        <div className="ms-group">
          <h3>Sampling</h3>
          <Row label="Temperature" hint="higher is more varied">
            <input
              inputMode="decimal"
              value={c.temperature}
              disabled={busy}
              onChange={(e) => updateAdvancedNumberControl("temperature", e.target.value)}
              aria-label="Temperature"
            />
          </Row>
          <Row label="Top-p" hint="lower is safer">
            <input
              inputMode="decimal"
              value={c.topP}
              disabled={busy}
              onChange={(e) => updateAdvancedNumberControl("topP", e.target.value)}
              aria-label="Top-p"
            />
          </Row>
          <Row
            label="Style strength"
            hint={!hasKnobs ? "this model has no style" : knobsSet ? "how hard style is pushed" : "set a style first"}
            disabled={!knobsSet}
          >
            <input
              inputMode="decimal"
              value={c.guidanceScale}
              disabled={busy || !knobsSet}
              onChange={(e) => updateAdvancedNumberControl("guidanceScale", e.target.value)}
              aria-label="Style strength"
            />
          </Row>
        </div>
      </div>
    </section>
  );
}
