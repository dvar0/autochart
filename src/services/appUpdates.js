import { electronUpdates } from "./runtimeBridge.js";

// Update notices come from the desktop app's main process; the browser
// version is always the latest, so it has none.
export function updatesAvailable() {
  return Boolean(electronUpdates()?.isAvailable?.());
}

const call = (name) => () => (updatesAvailable() ? electronUpdates()[name]() : Promise.resolve(null));

export const getUpdateState = call("get");
export const checkForUpdate = call("check");
export const downloadUpdate = call("download");
export const getUpdateImage = call("image");
export const installUpdate = call("install");
export const dismissUpdate = call("dismiss");
export const markUpdateAnnounced = call("markAnnounced");
export const markWhatsNewSeen = call("markWhatsNewSeen");
export const openUpdatePage = call("openPage");

export function onUpdateState(callback) {
  return updatesAvailable() ? electronUpdates().onState(callback) : () => {};
}

// The offered update's text in the app's language, when its feed has it
// (update.json "translations"); any part it doesn't translate stays English.
export function updateInLanguage(update, language) {
  const text = update?.translations?.[language];
  if (!text) return update;
  return {
    ...update,
    headline: text.headline || update.headline,
    sub: text.sub || update.sub,
    features: (update.features || []).map((feature, index) => ({ ...feature, ...(text.features?.[index] || {}) })),
    fixes: text.fixes?.length ? text.fixes : update.fixes,
  };
}
