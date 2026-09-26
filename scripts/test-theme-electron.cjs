// Exercises the real App, sidebar selector, OS media query, and persistence.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, nativeTheme } = require("electron");
const esbuild = require("esbuild");
const settingsStore = require("../electron/settingsStore.cjs");

const ROOT = path.resolve(__dirname, "..");
app.on("window-all-closed", () => {});

async function main() {
  const temp = process.env.AUTOCHART_THEME_TEST_ROOT || await fs.mkdtemp(path.join(os.tmpdir(), "autochart-theme-"));
  app.setPath("userData", path.join(temp, "profile"));
  let win;
  try {
    const settingsPath = path.join(temp, "settings");
    assert.equal((await settingsStore.readSettings(settingsPath)).theme, "system");
    for (const theme of ["light", "dark", "system"]) {
      await settingsStore.updateSettings(settingsPath, { theme });
      assert.equal((await settingsStore.readSettings(settingsPath)).theme, theme);
    }
    assert.equal(settingsStore.normalizeSettings({ theme: "invalid" }).theme, "system");

    await esbuild.build({
      stdin: {
        contents: `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import App from "./src/App.jsx";
          import "./src/styles.css";
          createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
        `,
        resolveDir: ROOT,
        loader: "jsx",
      },
      bundle: true,
      outfile: path.join(temp, "app.js"),
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      alias: { "@autochart/chart-writer": path.join(ROOT, "shared/chartWriter.cjs") },
      define: { "import.meta.env.DEV": "false" },
      logLevel: "silent",
    });
    await fs.writeFile(path.join(temp, "index.html"), '<link rel="stylesheet" href="app.css"><div id="root"></div><script src="app.js"></script>');
    await app.whenReady();
    nativeTheme.themeSource = "light";
    win = new BrowserWindow({ show: false, width: 1100, height: 800 });
    const rendererErrors = [];
    win.webContents.on("console-message", (details) => {
      if (details.level === "error") rendererErrors.push(details.message);
    });
    await win.loadFile(path.join(temp, "index.html"));
    const evaluate = code => win.webContents.executeJavaScript(code, true);
    const waitFor = async (code) => {
      const deadline = Date.now() + 5000;
      while (!(await evaluate(code))) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${code}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    const expectTheme = theme => waitFor(`document.querySelector('.ac-app')?.dataset.theme === ${JSON.stringify(theme)}`);
    const chooseTheme = async theme => {
      await evaluate(`(() => {
        const select = document.querySelector('[aria-label="Color theme"]');
        select.value = ${JSON.stringify(theme)};
        select.dispatchEvent(new Event('change', {bubbles:true}));
      })()`);
      await waitFor(`JSON.parse(localStorage.getItem('autochart.settings')).theme === ${JSON.stringify(theme)}`);
    };
    const setSystemTheme = async theme => {
      nativeTheme.themeSource = theme;
      await waitFor(`matchMedia('(prefers-color-scheme: dark)').matches === ${theme === "dark"}`);
    };

    // New profiles follow the OS even before setup is complete.
    await waitFor(`!!document.querySelector('.setup-page')`);
    await expectTheme("light");
    await setSystemTheme("dark");
    await expectTheme("dark");

    // Simulate finishing setup to exercise the real sidebar and browser store.
    await evaluate(`localStorage.setItem('autochart.settings', JSON.stringify({setupComplete:true}))`);
    await win.loadFile(path.join(temp, "index.html"));
    await waitFor(`!!document.querySelector('[aria-label="Color theme"]')`);
    assert.equal(await evaluate(`document.querySelector('[aria-label="Color theme"]').value`), "system");
    await expectTheme("dark");
    await setSystemTheme("light");
    await expectTheme("light");

    for (const theme of ["dark", "light"]) {
      await chooseTheme(theme);
      await expectTheme(theme);
      await setSystemTheme("dark");
      await expectTheme(theme);
      await setSystemTheme("light");
      await expectTheme(theme);
      await win.loadFile(path.join(temp, "index.html"));
      await waitFor(`document.querySelector('[aria-label="Color theme"]')?.value === ${JSON.stringify(theme)}`);
      await expectTheme(theme);
    }

    await evaluate(`document.querySelector('[aria-label="Collapse sidebar"]').click()`);
    await waitFor(`!!document.querySelector('.rail.collapsed')`);
    await evaluate(`document.querySelector('[aria-label="Color theme"]').focus()`);
    assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), "Color theme");
    const selectorSize = await evaluate(`(() => {const r=document.querySelector('[aria-label="Color theme"]').getBoundingClientRect();return {width:r.width,height:r.height};})()`);
    assert.ok(selectorSize.width >= 30 && selectorSize.height >= 30);
    await setSystemTheme("dark");
    await chooseTheme("system");
    await expectTheme("dark");
    await win.loadFile(path.join(temp, "index.html"));
    await waitFor(`document.querySelector('[aria-label="Color theme"]')?.value === 'system'`);
    await setSystemTheme("light");
    await expectTheme("light");
    assert.deepEqual(rendererErrors, []);
    console.log("Theme: fresh setup, live OS changes, manual overrides, relaunch persistence, and collapsed selector passed.");
  } finally {
    if (win) {
      win.webContents.session.flushStorageData();
      win.destroy();
    }
    nativeTheme.themeSource = "system";
    // The Node runner removes the profile after Electron exits and releases
    // its Windows database handles. Standalone runs retain diagnostic files.
    if (!process.env.AUTOCHART_THEME_TEST_ROOT) console.log(`Theme test profile retained: ${temp}`);
  }
}

main().then(() => app.exit(0), error => {
  console.error(error);
  app.exit(1);
});
