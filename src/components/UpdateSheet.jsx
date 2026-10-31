import { useEffect, useState } from "react";
import { I } from "../icons.jsx";
import { msg, t, tn } from "../i18n/index.js";
import ProgressRing from "./ProgressRing.jsx";
import ReleaseCard, { ReleaseContent, ReleaseNotesLink } from "./ReleaseCard.jsx";
import {
  checkForUpdate, downloadUpdate, getUpdateImage, installUpdate, openUpdatePage,
} from "../services/appUpdates.js";

const INSTALL_LABEL = {
  replace: msg("Restart to update"),
  installer: msg("Install and restart"),
  dmg: msg("Open installer"),
};

function formatSize(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function checkedLabel(at) {
  if (!at) return t("not checked yet");
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days < 1) return t("checked today");
  return days === 1 ? t("checked yesterday") : tn(days, "checked {count} day ago", "checked {count} days ago");
}

// The next version and the one button that gets it, or, without one, the
// version this is. Opens from the rail's version label; important updates
// open it once by themselves.
export default function UpdateSheet({ state, busy, onClose, onWhatsNew }) {
  const [error, setError] = useState("");
  const [image, setImage] = useState("");
  const update = state?.update;
  const download = state?.download || {};
  const mode = update?.installMode || "page";

  useEffect(() => {
    if (!update?.hasImage) return undefined;
    let active = true;
    getUpdateImage().then((url) => active && setImage(url || "")).catch(() => {});
    return () => {
      active = false;
    };
  }, [update?.version, update?.hasImage]);

  const run = async (action) => {
    setError("");
    try {
      await action();
    } catch (err) {
      setError(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };

  let primary = null;
  if (update && mode === "page") {
    primary = (
      <button type="button" className="btn-primary" onClick={() => run(openUpdatePage)}>
        <I.open /> {t("Open download page")}
      </button>
    );
  } else if (update && download.status === "downloading") {
    primary = (
      <button type="button" className="btn-primary" disabled>
        <ProgressRing value={download.percent || null} /> {t("Downloading {percent}%", { percent: download.percent || 0 })}
      </button>
    );
  } else if (update && download.status === "ready") {
    primary = (
      <button
        type="button"
        className="btn-primary"
        onClick={() => run(installUpdate)}
        disabled={busy}
        title={busy ? t("Finish generating first") : undefined}
      >
        <I.download /> {t(INSTALL_LABEL[mode])}
      </button>
    );
  } else if (update) {
    primary = (
      <button type="button" className="btn-primary" onClick={() => run(downloadUpdate)}>
        <I.download /> {t("Download update")}
      </button>
    );
  } else {
    primary = (
      <button type="button" className="btn-primary" onClick={() => run(checkForUpdate)} disabled={Boolean(state?.checking)}>
        {state?.checking ? <ProgressRing value={null} /> : <I.loop />} {state?.checking ? t("Checking…") : t("Check for updates")}
      </button>
    );
  }

  const message = error || download.error || state?.error || "";
  const current = state?.currentVersion || "";

  return (
    <ReleaseCard
      label={t("Updates")}
      kicker={update ? `Autochart ${update.version}` : `Autochart ${current}`}
      title={update
        ? update.headline ? t(update.headline) : t("Autochart {version} is out", { version: update.version })
        : state?.lastCheckedAt ? t("You're up to date") : t("Updates")}
      sub={update ? t(update.sub) : ""}
      image={image}
      onClose={onClose}
      footer={
        <>
          <div className="release-foot-meta">
            <span>{t("You have {version}, {checked}", { version: current, checked: state?.checking ? t("checking…") : checkedLabel(state?.lastCheckedAt) })}</span>
            <button type="button" className="release-link" onClick={onWhatsNew}>{t("What's new")}</button>
            {update && <ReleaseNotesLink url={update.notesUrl} />}
          </div>
          {primary}
        </>
      }
    >
      {update && <ReleaseContent features={update.features} fixes={update.fixes} />}
      {update && (
        <p className="release-fine">
          {update.size ? `${formatSize(update.size)} · ` : ""}{t("Songs and settings stay as they are.")}
          {mode === "dmg" && ` ${t("Autochart closes, then drag it to Applications.")}`}
          {mode !== "page" && (
            <>
              {" "}
              <button type="button" className="release-link" onClick={() => run(openUpdatePage)}>
                {t("Or get it from the download page")}
              </button>
            </>
          )}
        </p>
      )}
      {message && <p className="release-error" role="alert">{message}</p>}
    </ReleaseCard>
  );
}
