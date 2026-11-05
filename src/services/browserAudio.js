import { unsupportedAudioFormat } from "../../engine/web/audio.mjs";
import { t } from "../i18n/index.js";
import { isWebApp } from "./runtimeBridge.js";

const FORMAT_NAMES = {
  aiff: "AIFF",
  alac: "Apple Lossless",
  wma: "WMA",
  ac3: "Dolby Digital",
  dolby: "Dolby Digital",
  adpcm: "ADPCM WAV",
};
// Formats the desktop app's FFmpeg reads.
const DESKTOP_READS = new Set(["aiff", "alac", "dolby", "adpcm"]);

// Why the browser version can't use this song file, or "" when it can (as
// far as its header tells). The desktop app decodes through FFmpeg instead.
export async function unsupportedSongMessage(file) {
  if (!file || !isWebApp()) return "";
  const format = await unsupportedAudioFormat(file);
  if (!format) return "";
  const vars = { format: FORMAT_NAMES[format] };
  return DESKTOP_READS.has(format)
    ? t("Browsers can't play {format} audio. Convert the song to MP3, FLAC or WAV, or open it in the desktop app.", vars)
    : t("Autochart can't read {format} audio. Convert the song to MP3, FLAC or WAV first.", vars);
}
