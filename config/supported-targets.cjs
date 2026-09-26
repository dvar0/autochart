"use strict";

const targetMatrix = require("./supported-targets.json");

const SUPPORTED_TARGETS = Object.freeze(
  (Array.isArray(targetMatrix.targets) ? targetMatrix.targets : []).map((target) =>
    Object.freeze({
      ...target,
      builderArgs: Object.freeze([...(target.builderArgs || [])]),
      appOutCandidates: Object.freeze([...(target.appOutCandidates || [])]),
    })
  )
);

function platformLabel(platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return String(platform || "Unknown OS");
}

function targetKey(platform, arch) {
  return `${platform || ""}-${arch || ""}`;
}

function supportedTarget(platform, arch) {
  return SUPPORTED_TARGETS.find(
    (target) => target.platform === platform && target.arch === arch
  ) || null;
}

function isSupportedTarget(platform, arch) {
  return Boolean(supportedTarget(platform, arch));
}

function targetLabel(platform, arch) {
  return supportedTarget(platform, arch)?.label || `${platformLabel(platform)} ${arch || "unknown architecture"}`;
}

function unsupportedTargetMessage(platform, arch) {
  return `${targetLabel(platform, arch)} is not a supported generation target in this release.`;
}

function assertSupportedTarget(platform, arch) {
  if (!isSupportedTarget(platform, arch)) throw new Error(unsupportedTargetMessage(platform, arch));
  return supportedTarget(platform, arch);
}

module.exports = {
  SUPPORTED_TARGETS,
  assertSupportedTarget,
  isSupportedTarget,
  platformLabel,
  supportedTarget,
  targetKey,
  targetLabel,
  unsupportedTargetMessage,
};
