import { t } from "../../i18n/index.js";

// Separation names and lead-in labels are saved in English with the project
// ("Regenerated separation 2 (+2s lead-in)"); these show them in the current
// language. Names someone typed stay as they are.

export function leadInText(label) {
  const text = String(label || "").trim();
  if (!text || /^no lead-in$/i.test(text)) return t("No lead-in");
  const seconds = text.match(/^\+?([\d.]+)\s*s lead-in$/i);
  return seconds ? t("+{seconds}s lead-in", { seconds: seconds[1] }) : text;
}

function baseName(base) {
  if (/^default separation$/i.test(base)) return t("Default separation");
  if (/^demucs separation$/i.test(base)) return t("Demucs separation");
  if (/^selected separation$/i.test(base)) return t("Selected separation");
  const regenerated = base.match(/^regenerated separation\s*(\d*)$/i);
  if (regenerated) {
    return regenerated[1] ? t("Remade separation {number}", { number: regenerated[1] }) : t("Remade separation");
  }
  return base;
}

export function separationName(name) {
  const text = String(name || "Default separation").trim();
  const lead = text.match(/\s*\(([^)]*lead-in[^)]*)\)\s*$/i);
  const shown = baseName(lead ? text.slice(0, lead.index).trim() : text);
  return lead ? `${shown} (${leadInText(lead[1])})` : shown;
}
