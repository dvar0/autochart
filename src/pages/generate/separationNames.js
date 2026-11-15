import { t } from "../../i18n/index.js";

// Lead-in labels are saved in English with the project ("+2s lead-in"); these
// show them in the current language.

export function leadInText(label) {
  const text = String(label || "").trim();
  if (!text || /^no lead-in$/i.test(text)) return t("No lead-in");
  const seconds = text.match(/^\+?([\d.]+)\s*s lead-in$/i);
  return seconds ? t("+{seconds}s lead-in", { seconds: seconds[1] }) : text;
}

// A separation goes by its lead-in: separating the song again gives the same
// stems, so that's all that tells two apart.
export function separationLeadInName(artifact) {
  const ms = Number(artifact?.sourceTransform?.leadInSilenceMs ?? String(artifact?.sourceVariantKey || "").match(/lead-in:(\d+)/)?.[1] ?? 0);
  return ms > 0 ? t("+{seconds}s lead-in", { seconds: String(ms / 1000) }) : t("No lead-in");
}
