import { useEffect, useState } from "react";
import { I } from "../icons.jsx";
import ProgressRing from "./ProgressRing.jsx";
import ReleaseCard, { ReleaseContent, ReleaseNotesLink } from "./ReleaseCard.jsx";
import { MODEL_FAMILIES } from "../data/modelFamilies.js";
import { listGenerators } from "../services/generation.js";
import { installAssets, subscribeModelInstallEvents } from "../services/modelSetup.js";

// Outlives the window, so closing and reopening it mid-download keeps the
// progress instead of offering the download twice.
let modelInstall = { status: "", percent: 0, error: "" };

// Downloads the release's model right here, the way Settings would.
function ModelButton({ action }) {
  const family = MODEL_FAMILIES.find((item) => item.id === action.familyId);
  const [install, setInstall] = useState(modelInstall);
  const update = (next) => {
    modelInstall = { ...modelInstall, ...next };
    setInstall(modelInstall);
  };

  useEffect(() => {
    if (modelInstall.status === "installing" || modelInstall.status === "done") return undefined;
    let active = true;
    listGenerators()
      .then((manifest) => {
        const ready = Boolean(manifest?.generators?.find((g) => g.id === family?.generatorId)?.setup?.ready);
        if (active) update({ status: ready ? "done" : "idle" });
      })
      .catch(() => active && update({ status: "idle" }));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => subscribeModelInstallEvents((event) => {
    if (modelInstall.status !== "installing") return;
    if (Number.isFinite(event?.percent)) update({ percent: Math.round(event.percent) });
  }), []);

  const start = async () => {
    update({ status: "installing", percent: 0, error: "" });
    try {
      await installAssets(action.packId);
      update({ status: "done", percent: 100 });
    } catch (err) {
      update({ status: "failed", error: err?.message || "The download didn't finish." });
    }
  };

  if (!family) return null;
  if (install.status === "done") {
    return (
      <button type="button" className="btn-primary release-done" disabled>
        <I.check /> {family.label} is ready
      </button>
    );
  }
  if (install.status === "installing") {
    return (
      <button type="button" className="btn-primary" disabled>
        <ProgressRing value={install.percent || null} /> Downloading {install.percent}%
      </button>
    );
  }
  return (
    <>
      {install.status === "failed" && <span className="release-error" role="alert">The download didn't finish.</span>}
      <button type="button" className="btn-primary" onClick={start} disabled={!install.status}>
        <I.download /> {install.status === "failed" ? "Try again" : `Download ${family.label}`}
      </button>
    </>
  );
}

// What changed since the version this computer last ran: the newest release in
// full, anything skipped in between as a short list. Opens once after an
// update, and again from the update window.
export default function WhatsNewSheet({ entries, onClose }) {
  const [latest, ...earlier] = entries;
  // Versions skipped in between join the quiet list.
  const fixes = [
    ...(latest?.fixes || []),
    ...earlier.flatMap((entry) => [
      ...entry.features.map((feature) => `${feature.title}: ${feature.text}`),
      ...(entry.fixes || []),
    ]),
  ];

  if (!latest) {
    return (
      <ReleaseCard label="What's new" title="Nothing new yet" sub="This version has no notes." onClose={onClose} />
    );
  }

  return (
    <ReleaseCard
      label="What's new"
      kicker={`New in ${latest.version}`}
      title={latest.headline}
      sub={latest.sub}
      image={latest.image}
      onClose={onClose}
      footer={
        <>
          <div className="release-foot-meta">
            <ReleaseNotesLink url={latest.notesUrl} />
          </div>
          <button type="button" className="settings-secondary" onClick={onClose}>
            Close
          </button>
          {latest.action?.kind === "install-model" && <ModelButton action={latest.action} />}
        </>
      }
    >
      <ReleaseContent features={latest.features} fixes={fixes} />
    </ReleaseCard>
  );
}
