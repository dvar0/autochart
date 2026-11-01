// Gives the app the browser version's bridge before any of it loads. The
// bridge has no library, settings, files or window: projects and settings
// use the app's own browser storage (IndexedDB, localStorage).
import { createWebBridge } from "./webEngine.js";
import { canSaveToFolder, downloadCloneHeroSong, saveToSongsFolder } from "./cloneHeroExport.js";
import { LANGUAGES, languagePreference, setLanguagePreference, systemLanguage } from "../i18n/index.js";
import { updateAppSettings } from "../services/appSettings.js";

window.autochart = {
  ...createWebBridge(),
  webExport: {
    download: downloadCloneHeroSong,
    saveToFolder: saveToSongsFolder,
    canSaveToFolder,
  },
};

// A link from the site carries the language the site was showing. It counts
// only while the app's own language setting hasn't been chosen.
if (!import.meta.env.DEV) {
  const params = new URLSearchParams(location.search);
  const linked = params.get("lang");
  if (LANGUAGES.some((language) => language.id === linked)) {
    if (languagePreference() === "system" && linked !== systemLanguage()) {
      setLanguagePreference(linked);
      updateAppSettings({ language: linked });
    }
    params.delete("lang");
    const query = params.toString();
    history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  }
}
