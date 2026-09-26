"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-theme-"));
  try {
    let command = require("electron");
    let args = [...process.argv.slice(2), path.join(__dirname, "test-theme-electron.cjs")];
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      args = ["-a", command, ...args];
      command = "xvfb-run";
    }
    const code = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: { ...process.env, AUTOCHART_THEME_TEST_ROOT: root },
        stdio: "inherit",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("close", (status) => resolve(status ?? 1));
    });
    process.exitCode = code;
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
