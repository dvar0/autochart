import { getAutochartBridge } from "./runtimeBridge.js";

const EXTERNAL_FFMPEG_URL = "https://ffmpeg.org/legal.html";

export const NOTICE_LINKS = Object.freeze({
  ffmpeg: EXTERNAL_FFMPEG_URL,
});

export async function openNotice(key) {
  const bridge = getAutochartBridge()?.notices;
  if (bridge?.open) {
    await bridge.open(key);
    return true;
  }
  return false;
}
