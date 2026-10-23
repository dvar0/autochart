// Gives the app the browser version's bridge before any of it loads. The
// bridge has no library, settings, files or window: projects and settings
// use the app's own browser storage (IndexedDB, localStorage).
import { createWebBridge } from "./webEngine.js";
import { canSaveToFolder, downloadCloneHeroZip, saveToSongsFolder } from "./cloneHeroExport.js";

window.autochart = {
  ...createWebBridge(),
  webExport: {
    downloadZip: downloadCloneHeroZip,
    saveToFolder: saveToSongsFolder,
    canSaveToFolder,
  },
};
