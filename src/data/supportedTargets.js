import { t } from "../i18n/index.js";
import targetMatrix from "../../config/supported-targets.json" with { type: "json" };

export const SUPPORTED_TARGETS = Object.freeze(
  (Array.isArray(targetMatrix.targets) ? targetMatrix.targets : []).map((target) =>
    Object.freeze({
      ...target,
      builderArgs: Object.freeze([...(target.builderArgs || [])]),
      appOutCandidates: Object.freeze([...(target.appOutCandidates || [])]),
    })
  )
);

export function targetKey(platform, arch) {
  return `${platform || ""}-${arch || ""}`;
}

export function supportedTarget(platform, arch) {
  return SUPPORTED_TARGETS.find(
    (target) => target.platform === platform && target.arch === arch
  ) || null;
}

export function isSupportedTarget(platform, arch) {
  return Boolean(supportedTarget(platform, arch));
}

export function targetLabel(platform, arch) {
  return supportedTarget(platform, arch)?.label || `${platform || t("Unknown OS")} ${arch || t("unknown architecture")}`;
}

export function unsupportedTargetMessage(platform, arch) {
  return t("{target} is not a supported generation target in this release.", { target: targetLabel(platform, arch) });
}
