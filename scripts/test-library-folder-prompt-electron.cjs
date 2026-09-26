// Run with: npx electron scripts/test-library-folder-prompt-electron.cjs
// Real React UI, preload IPC, and filesystem library. Saving to Clone Hero /
// YARG with no songs folder must open the folder prompt from both the Library
// and Generate pages, keep keyboard focus inside it, return focus to the Save
// button, and resume the parked save once a folder is chosen.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain } = require("electron");
const esbuild = require("esbuild");
const library = require("../electron/libraryStore.cjs");
const chartWriter = require("../shared/chartWriter.cjs");
const ROOT = path.resolve(__dirname, "..");
const MISSING_FOLDER = "Choose a Clone Hero / YARG library folder in Settings first.";

async function main() {
  // The mock refusal below must stay identical to the real main-process one.
  const mainSource = await fs.readFile(path.join(ROOT, "electron/main.cjs"), "utf8");
  assert(mainSource.includes(JSON.stringify(MISSING_FOLDER)), "main-process missing-folder message changed");

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-folder-prompt-"));
  const context = { userDataPath: temp, projectsFolder: path.join(temp, "projects") };
  const settings = { setupComplete: true, cloneHeroLibraryFolder: "" };
  const pickerResponses = [];
  const saves = [];
  let refuseNextSave = false;
  const errors = [];
  let win;
  try {
    const chartText = chartWriter.writeChartText([[0, 0, 0], [192, 1, 0], [384, 2, 0]], {
      title: "Folder prompt fixture", difficulty: "expert", resolution: 192, syncLines: ["0 = B 120000"],
    }).text;
    const seed = {
      id: "folder_prompt_fixture", schemaVersion: 2, source: "generated", status: "charted",
      createdAt: Date.now(), updatedAt: Date.now(),
      meta: { title: "Folder prompt fixture", artist: "Test", favorite: false },
      settings: { difficulty: "expert", activeVersionId: "take_1" },
      chart: { text: chartText },
      versions: [{ id: "take_1", name: "Take 1", source: "generated", status: "charted", settings: { difficulty: "expert" }, chart: { text: chartText } }],
    };
    await library.saveSong(context, {
      record: seed,
      assets: { audio: { name: "song.wav", mime: "audio/wav", data: await fs.readFile(path.join(ROOT, "fixtures/demo/autochart-demo-30s.wav")) } },
    });

    ipcMain.handle("settings:get", () => ({ ...settings }));
    ipcMain.handle("settings:update", (_event, patch) => Object.assign(settings, patch));
    ipcMain.handle("settings:chooseCloneHeroLibraryFolder", () => {
      const next = pickerResponses.shift();
      if (!next) throw new Error("unexpected folder picker");
      if (next.error) throw new Error(next.error);
      if (next.canceled) return { canceled: true, settings: { ...settings } };
      settings.cloneHeroLibraryFolder = next.folder;
      return { canceled: false, settings: { ...settings } };
    });
    ipcMain.handle("library:saveSongToCloneHeroLibrary", (_event, payload) => {
      if (!settings.cloneHeroLibraryFolder || refuseNextSave) {
        refuseNextSave = false;
        throw new Error(MISSING_FOLDER);
      }
      saves.push({ ...payload, folder: settings.cloneHeroLibraryFolder });
      const out = path.join(settings.cloneHeroLibraryFolder, "Folder prompt fixture");
      return { path: out, message: `Saved Autochart copy to Clone Hero / YARG library: ${out}` };
    });
    ipcMain.handle("library:listSongs", () => library.listSongs(context));
    ipcMain.handle("library:getSong", (_event, id) => library.getSong(context, id));
    ipcMain.handle("library:saveSong", (_event, payload) => library.saveSong(context, payload));
    ipcMain.handle("library:patchSong", (_event, payload) => library.patchSong(context, payload));
    ipcMain.handle("library:getAssetSource", async (_event, { songId, fileName }) => {
      const source = await library.getMediaAssetSource(context, songId, fileName, "audio");
      return { kind: "project-asset", projectId: songId, fileName: source.name, ...source };
    });
    ipcMain.handle("library:getAssetUrl", async (_event, { songId, fileName }) => {
      const source = await library.getMediaAssetSource(context, songId, fileName);
      return pathToFileURL(source.path).href;
    });
    ipcMain.handle("engine:getManifest", () => ({ available: true, generators: [{ id: "autochart.fretformer.v1-onnx", label: "Fretformer", setup: { ready: true } }] }));
    ipcMain.handle("window:isFullscreen", () => false);

    await esbuild.build({
      absWorkingDir: ROOT,
      stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; import App from "./src/App.jsx"; createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);', resolveDir: ROOT, loader: "jsx" },
      bundle: true, outfile: path.join(temp, "app.js"), format: "iife", platform: "browser", jsx: "automatic",
      alias: { "@autochart/chart-writer": path.join(ROOT, "shared/chartWriter.cjs") },
      define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "true" }, logLevel: "silent",
    });
    await fs.copyFile(path.join(ROOT, "src/styles.css"), path.join(temp, "app.css"));
    await fs.writeFile(path.join(temp, "index.html"), '<link rel="stylesheet" href="app.css"><div id="root"></div><script src="app.js"></script>');
    win = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), contextIsolation: true } });
    win.webContents.on("console-message", ({ level, message }) => {
      if (level === "error") errors.push(message);
    });
    await win.loadFile(path.join(temp, "index.html"));
    win.webContents.focus();

    const evaluate = (code) => win.webContents.executeJavaScript(code, true);
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 15000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}\n${await evaluate("document.body.innerText")}\n${errors.join("\n")}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const buttonByText = (text) => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
    const click = async (text) => {
      await waitFor(() => evaluate(`Boolean(${buttonByText(text)})`), `button ${text}`);
      await evaluate(`(() => { ${buttonByText(text)}.click(); return true; })()`);
    };
    // Focus then click, as a pointer press on a button does in Chromium. Check
    // and click in one step: the Generate page briefly disables Save while it loads.
    const pressSave = async (selector) => {
      await waitFor(() => evaluate(`(() => {
        const b = document.querySelector(${JSON.stringify(selector)});
        if (!b || b.disabled) return false;
        b.focus();
        b.click();
        return true;
      })()`), `${selector} pressed`);
    };
    const key = async (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await new Promise((resolve) => setTimeout(resolve, 30));
    };
    const promptOpen = () => evaluate('Boolean(document.querySelector("dialog.lib-prompt[open]"))');
    const focused = () => evaluate(`(() => {
      const el = document.activeElement;
      return { text: el?.textContent.trim() || "", inPrompt: Boolean(el?.closest("dialog.lib-prompt")) };
    })()`);
    const focusIs = (selector) => evaluate(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`);

    const expectFocusContained = async (saveSelector) => {
      assert.deepEqual(await focused(), { text: "Choose Folder & Save", inPrompt: true }, "prompt did not focus its primary action");
      const seen = [];
      for (let i = 0; i < 4; i++) {
        await key("Tab");
        const now = await focused();
        assert(now.inPrompt, `Tab ${i + 1} left the prompt for "${now.text}"`);
        seen.push(now.text);
      }
      assert.deepEqual(seen, ["Open Settings", "Cancel", "Choose Folder & Save", "Open Settings"], "Tab order does not wrap inside the prompt");
      const back = [];
      for (let i = 0; i < 4; i++) {
        await key("Tab", ["shift"]);
        const now = await focused();
        assert(now.inPrompt, `Shift+Tab ${i + 1} left the prompt for "${now.text}"`);
        back.push(now.text);
      }
      assert.deepEqual(back, ["Choose Folder & Save", "Cancel", "Open Settings", "Choose Folder & Save"], "Shift+Tab order does not wrap inside the prompt");
      // The page behind the modal is inert: it can be neither focused nor clicked.
      await evaluate(`document.querySelector(${JSON.stringify(saveSelector)}).focus()`);
      assert((await focused()).inPrompt, "background Save button took focus while the prompt was open");
      const hit = await evaluate(`(() => {
        const r = document.querySelector(${JSON.stringify(saveSelector)}).getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return el?.closest("dialog.lib-prompt") ? "prompt" : el === document.querySelector(${JSON.stringify(saveSelector)}) ? "save" : "other";
      })()`);
      assert.notEqual(hit, "save", "background Save button is still hit-testable under the prompt");
    };

    const exerciseEntryPoint = async (name, saveSelector) => {
      // Escape dismisses and returns focus to the invoking Save button.
      await pressSave(saveSelector);
      await waitFor(promptOpen, `${name}: prompt opens with no folder`);
      await expectFocusContained(saveSelector);
      await key("Escape");
      await waitFor(async () => !(await promptOpen()), `${name}: Escape closes prompt`);
      assert(await focusIs(saveSelector), `${name}: Escape did not return focus to Save`);

      // Cancel does the same.
      await pressSave(saveSelector);
      await waitFor(promptOpen, `${name}: prompt reopens`);
      await click("Cancel");
      await waitFor(async () => !(await promptOpen()), `${name}: Cancel closes prompt`);
      assert(await focusIs(saveSelector), `${name}: Cancel did not return focus to Save`);
      assert.equal(saves.length, 0, `${name}: dismissing the prompt saved anyway`);

      // A canceled picker keeps the prompt; a picker error is shown in it.
      await pressSave(saveSelector);
      await waitFor(promptOpen, `${name}: prompt opens for picker`);
      pickerResponses.push({ canceled: true });
      await click("Choose Folder & Save");
      await waitFor(() => pickerResponses.length === 0, `${name}: picker canceled`);
      assert(await promptOpen(), `${name}: canceling the picker closed the prompt`);
      pickerResponses.push({ error: "Folder is not writable" });
      await click("Choose Folder & Save");
      await waitFor(() => evaluate('document.querySelector(".lib-prompt-error")?.textContent === "Folder is not writable"'), `${name}: picker error shown`);
      assert.equal(saves.length, 0, `${name}: failed picker saved anyway`);

      // Choosing a folder resumes the parked save and restores focus.
      const folder = path.join(temp, `${name}-songs`);
      pickerResponses.push({ folder });
      await click("Choose Folder & Save");
      await waitFor(() => saves.length === 1, `${name}: save resumed after choosing folder`);
      await waitFor(async () => !(await promptOpen()), `${name}: prompt closed after save`);
      assert.equal(saves[0].songId, seed.id);
      assert.equal(saves[0].folder, folder);
      await waitFor(() => evaluate('document.body.innerText.includes("Saved Autochart copy to Clone Hero / YARG library")'), `${name}: save result shown`);
      await waitFor(() => focusIs(saveSelector), `${name}: focus returned to Save after saving`);

      // If the main process still refuses (folder cleared elsewhere), the same
      // prompt opens and the retry goes through once a folder is chosen.
      refuseNextSave = true;
      await pressSave(saveSelector);
      await waitFor(promptOpen, `${name}: main-process refusal opens prompt`);
      assert.equal(saves.length, 1);
      pickerResponses.push({ folder });
      await click("Choose Folder & Save");
      await waitFor(() => saves.length === 2, `${name}: refused save retried`);
      await waitFor(async () => !(await promptOpen()), `${name}: prompt closed after retry`);
      saves.length = 0;
      settings.cloneHeroLibraryFolder = "";
    };

    await waitFor(() => evaluate('Boolean(document.querySelector(".detail-actions .act.purple"))'), "library detail panel");
    await exerciseEntryPoint("library", ".detail-actions .act.purple");
    await click("OPEN PROJECT");
    await exerciseEntryPoint("generate", ".deck-save-library");
    assert.deepEqual(errors, [], "renderer errors while saving");

    // Open Settings leaves the prompt and lands on the Settings page.
    await pressSave(".deck-save-library");
    await waitFor(promptOpen, "prompt opens before Open Settings");
    await click("Open Settings");
    await waitFor(() => evaluate('document.querySelector(".page-title")?.textContent === "Settings"'), "Settings page shown");
    assert.equal(await promptOpen(), false, "prompt stayed open on Settings");
    assert.equal(saves.length, 0);
    console.log("library folder prompt: Library and Generate saves, picker cancel/error/success, main-process refusal, focus containment, focus return, and Open Settings passed");
  } finally {
    win?.destroy();
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

app.on("window-all-closed", () => {});
app.whenReady().then(main).then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });
