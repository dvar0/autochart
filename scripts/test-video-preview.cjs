"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-video-preview-"));
  try {
    let command = require("electron");
    const inputs = process.argv.slice(2);
    if (!inputs.length) inputs.push(path.join(__dirname, "../fixtures/video-preview/source-mpeg4-aac.mp4"));
    let args = [path.join(__dirname, "test-video-preview-electron.cjs"), ...inputs];
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      args = ["-a", command, ...args];
      command = "xvfb-run";
    }
    process.exitCode = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: { ...process.env, AUTOCHART_VIDEO_TEST_ROOT: root },
        stdio: "inherit",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("close", (status) => resolve(status ?? 1));
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
