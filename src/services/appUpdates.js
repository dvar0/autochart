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
