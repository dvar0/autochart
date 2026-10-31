import React from "react";
import { t } from "../../i18n/index.js";

export default function UnsupportedGenerationState({ message, targetLabel }) {
  return (
    <div className="ac-body setup-cta-page unsupported-target-page">
      <main className="settings-main" role="status" aria-live="polite">
        <header className="page-head">
          <h1 className="page-title">{t("Chart generation is unavailable")}</h1>
          <p className="page-sub">{t("This device is not a supported generation target for this release.")}</p>
        </header>
        <section className="setup-cta-panel unsupported-target-panel">
          <div>
            <h2>{targetLabel || t("Unsupported device")}</h2>
            <p>{message || t("Use Autochart on a supported Linux x64, Windows x64, or macOS Apple Silicon device.")}</p>
          </div>
        </section>
      </main>
    </div>
  );
}
