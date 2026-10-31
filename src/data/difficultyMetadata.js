// UI metadata shared by the library and generation surfaces.
import { t } from "../i18n/index.js";

export const DIFF = {
  easy: { get name() { return t("Easy"); }, color: "green", stars: 1 },
  medium: { get name() { return t("Medium"); }, color: "amber", stars: 2 },
  hard: { get name() { return t("Hard"); }, color: "peach", stars: 3 },
  expert: { get name() { return t("Expert"); }, color: "red", stars: 0, skull: true },
};
