"use strict";

const path = require("path");

const RELEASE_SMOKE_CHANNEL = "releaseSmoke:ping";
const RELEASE_SMOKE_PROBE = `
  (async () => {
    const mounted = Boolean(document.querySelector("#root")?.childElementCount);
    if (!mounted) return { mounted: false, bridge: false, reply: null };
    const ping = window.autochart?.releaseSmoke?.ping;
    if (typeof ping !== "function") {
      return { mounted: true, bridge: false, reply: null };
    }
    return { mounted: true, bridge: true, reply: await ping() };
  })()
`;

function isStrictChild(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveReleaseSmokePaths(env = process.env) {
  if (env.AUTOCHART_RELEASE_SMOKE !== "1") return null;

  const configuredRoot = String(env.AUTOCHART_RELEASE_SMOKE_ROOT || "").trim();
  if (!configuredRoot) {
    throw new Error("AUTOCHART_RELEASE_SMOKE_ROOT is required for a release-smoke launch.");
  }
  if (!path.isAbsolute(configuredRoot)) {
    throw new Error("AUTOCHART_RELEASE_SMOKE_ROOT must be an absolute path.");
  }
  const root = path.resolve(configuredRoot);
  if (root === path.parse(root).root) {
    throw new Error("AUTOCHART_RELEASE_SMOKE_ROOT cannot be a filesystem root.");
  }

  const configuredUserData = String(env.AUTOCHART_USER_DATA || "").trim();
  const userData = path.resolve(configuredUserData || path.join(root, "user-data"));
  if (!isStrictChild(root, userData)) {
    throw new Error("AUTOCHART_USER_DATA must be inside AUTOCHART_RELEASE_SMOKE_ROOT.");
  }

  return Object.freeze({
    root,
    userData,
    documents: path.join(root, "documents"),
    home: path.join(root, "home"),
    appData: path.join(root, "app-data"),
    localAppData: path.join(root, "local-app-data"),
  });
}

function createReleaseSmokePingHandler(paths, authorizedSenderIds, processId = process.pid) {
  return (event) => {
    if (
      !paths ||
      event.sender.isDestroyed() ||
      !authorizedSenderIds.has(event.sender.id)
    ) {
      throw new Error("Release-smoke ping rejected for an unauthorized renderer.");
    }
    return { ok: true, senderId: event.sender.id, processId };
  };
}

async function waitForReleaseSmokeRenderer(
  win,
  { timeoutMs = 15_000, pollIntervalMs = 100 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let lastProbe = null;
  while (Date.now() < deadline) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("The release-smoke window closed before readiness.");
    }
    lastProbe = await win.webContents.executeJavaScript(RELEASE_SMOKE_PROBE, true);
    if (
      lastProbe?.mounted === true &&
      lastProbe?.bridge === true &&
      lastProbe?.reply?.ok === true &&
      lastProbe.reply.senderId === win.webContents.id &&
      lastProbe.reply.processId === process.pid
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const detail = !lastProbe?.mounted
    ? "renderer did not mount"
    : !lastProbe?.bridge
      ? "preload bridge is unavailable"
      : "sender-bound IPC ping failed";
  throw new Error(`The release-smoke app did not become ready: ${detail}.`);
}

module.exports = {
  RELEASE_SMOKE_CHANNEL,
  RELEASE_SMOKE_PROBE,
  createReleaseSmokePingHandler,
  isStrictChild,
  resolveReleaseSmokePaths,
  waitForReleaseSmokeRenderer,
};
