import { electronFiles, electronLibrary } from "./runtimeBridge.js";

const backgroundPreviews = new WeakMap();

// An MP4 can load successfully as audio-only when Chromium lacks its video
// decoder. Require an actual decoded frame, not just loadedmetadata/canPlayType.
export function canDecodeVideo(url) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let done = false;
    const finish = (playable) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      resolve(playable);
    };
    const timer = setTimeout(() => finish(false), 8000);
    video.onloadeddata = () => finish(video.videoWidth > 0 && video.videoHeight > 0);
    video.onerror = () => finish(false);
    video.muted = true;
    video.preload = "auto";
    video.src = url;
  });
}

export async function playableVideoUrl(url, getSource) {
  if (await canDecodeVideo(url)) return url;
  const library = electronLibrary();
  if (!library?.prepareVideoPreview) {
    throw new Error("This video codec cannot be played here. Open it in the desktop app to create a compatible preview.");
  }
  const compatible = await library.prepareVideoPreview(await getSource());
  // The native converter confirmed that this container has no video stream.
  if (compatible === null) return null;
  if (!await canDecodeVideo(compatible)) throw new Error("The compatible video preview could not be decoded.");
  return compatible;
}

export async function createVideoFileUrl(file) {
  const original = URL.createObjectURL(file);
  try {
    const url = await resolveVideoBackground({ type: "video", url: original, file });
    if (url !== original) URL.revokeObjectURL(original);
    return url;
  } catch (error) {
    URL.revokeObjectURL(original);
    throw error;
  }
}

// Background preparation belongs to preview consumers, never the import or
// generation critical path. Share it across thumbnails and comparison players.
export function resolveVideoBackground(background) {
  if (!backgroundPreviews.has(background)) {
    const ready = playableVideoUrl(background.url, async () => {
      if (background.source) return background.source;
      const capability = await electronFiles()?.registerLibraryAsset?.(background.file, "background-video");
      if (!capability?.token) throw new Error("Select the video from disk to create a compatible preview.");
      return { kind: "selected-file", token: capability.token };
    });
    backgroundPreviews.set(background, ready);
  }
  return backgroundPreviews.get(background);
}
