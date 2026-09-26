"use strict";

const path = require("path");

const NOTICE_FILES = Object.freeze({
  thirdParty: "docs/third-party-notices.md",
  privacy: "docs/privacy.md",
  releaseNotes: "docs/release-notes.md",
  ffmpegLicense: "docs/lgpl-2.1.txt",
});

function resolveNoticePath(appRoot, key) {
  const relative = NOTICE_FILES[String(key || "")];
  if (!relative) throw new Error("Unknown Autochart notice.");
  const root = path.resolve(String(appRoot || ""));
  const target = path.resolve(root, relative);
  const relativeTarget = path.relative(root, target);
  if (!relativeTarget || relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new Error("Autochart notice path escaped the packaged app.");
  }
  return target;
}

module.exports = { NOTICE_FILES, resolveNoticePath };
