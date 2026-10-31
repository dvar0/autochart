import { I } from "../icons.jsx";
import {
  LANGUAGES, PSEUDO_AVAILABLE, languagePreference, setLanguagePreference, systemLanguage, t, useLanguage,
} from "../i18n/index.js";
import { updateAppSettings } from "../services/appSettings.js";

const nameOf = (id) => LANGUAGES.find((language) => language.id === id)?.name || id;

// Each language is named in itself, so someone who can't read the current
// one still finds theirs. The globe marks it in any language.
export default function LanguagePicker({ className = "" }) {
  useLanguage();
  const preference = languagePreference();
  const shown = preference === "system" ? systemLanguage() : preference;
  const choose = (next) => {
    setLanguagePreference(next);
    // The padded test language stays out of the saved settings.
    if (next !== "xx") updateAppSettings({ language: next }).catch(() => {});
  };
  return (
    <label className={"settings-secondary language-picker " + className} title={t("Language")}>
      <I.globe aria-hidden="true" />
      <span aria-hidden="true">{nameOf(shown)}</span>
      <I.chev className="language-picker-chevron" aria-hidden="true" />
      <select
        aria-label={t("Language")}
        value={LANGUAGES.some((language) => language.id === preference) || preference === "xx" ? preference : "system"}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="system">{t("Match system")} ({nameOf(systemLanguage())})</option>
        {LANGUAGES.map((language) => (
          <option key={language.id} value={language.id} lang={language.id}>{language.name}</option>
        ))}
        {PSEUDO_AVAILABLE && <option value="xx">Pseudo (dev)</option>}
      </select>
    </label>
  );
}
