// Run with: npx electron scripts/test-generation-navigation.cjs
// Real React UI, preload IPC, and filesystem library; generation is held at
// deterministic checkpoints so navigation and completion races are repeatable.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain } = require("electron");
const esbuild = require("esbuild");
const library = require("../electron/libraryStore.cjs");
const { persistGeneratedTake } = require("../electron/generatedTake.cjs");
const chartWriter = require("../shared/chartWriter.cjs");
const ROOT = path.resolve(__dirname, "..");
let testWindow;

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-navigation-"));
  const context = { userDataPath: temp, projectsFolder: path.join(temp, "projects") };
  const jobs = [];
  const errors = [];
  let win;
  try {
    const chartText = chartWriter.writeChartText([[0, 0, 0], [192, 1, 0], [384, 2, 0]], {
      title: "Navigation fixture", difficulty: "expert", resolution: 192, syncLines: ["0 = B 120000"],
    }).text;
    const seed = {
      id: "navigation_fixture", schemaVersion: 2, source: "generated", status: "charted",
      createdAt: Date.now(), updatedAt: Date.now(),
      meta: { title: "Navigation fixture", artist: "Test", favorite: false },
      settings: { difficulty: "expert", activeVersionId: "take_1" },
      chart: { text: chartText },
      versions: [{ id: "take_1", name: "Take 1", source: "generated", status: "charted", settings: { difficulty: "expert" }, chart: { text: chartText } }],
    };
    await library.saveSong(context, {
      record: seed,
      assets: {
        audio: { name: "song.wav", mime: "audio/wav", data: await fs.readFile(path.join(ROOT, "fixtures/demo/autochart-demo-30s.wav")) },
        background: { type: "image", name: "background.png", mime: "image/png", data: await fs.readFile(path.join(ROOT, "public/app-icon.png")) },
      },
    });
    ipcMain.handle("settings:get", () => ({ setupComplete: true }));
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
    ipcMain.handle("engine:generateChart", async (event, payload) => {
      const result = await new Promise((resolve, reject) => jobs.push({ payload, resolve, reject }));
      const saved = await persistGeneratedTake(context, payload.audio.projectId, result, payload);
      if (!event.sender.isDestroyed()) event.sender.send("engine:jobEvent", { type: "project_saved", projectId: payload.audio.projectId, jobId: result.jobId });
      return saved;
    });
    ipcMain.handle("window:isFullscreen", () => false);
    await esbuild.build({
      absWorkingDir: ROOT,
      stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; import App from "./src/App.jsx"; createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);', resolveDir: ROOT, loader: "jsx" },
      bundle: true, outfile: path.join(temp, "app.js"), format: "iife", platform: "browser", jsx: "automatic",
      alias: { "@autochart/chart-writer": path.join(ROOT, "shared/chartWriter.cjs") },
      define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "true" }, logLevel: "silent",
    });
    // The real layout constrains canvas CSS dimensions independently from their
    // Retina backing stores. Without it the density canvas doubles its intrinsic
    // size on each ResizeObserver callback on a high-DPI display.
    await fs.copyFile(path.join(ROOT, "src/styles.css"), path.join(temp, "app.css"));
    await fs.writeFile(path.join(temp, "index.html"), '<link rel="stylesheet" href="app.css"><div id="root"></div><script src="app.js"></script>');
    win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), contextIsolation: true } });
    testWindow = win;
    win.webContents.on("console-message", ({ level, message }) => {
      if (level === "error") errors.push(message);
    });
    await win.loadFile(path.join(temp, "index.html"));
    const evaluate = (code) => win.webContents.executeJavaScript(code, true);
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 15000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}\n${await evaluate('document.body.innerText')}\n${errors.join("\n")}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    const click = async (text) => {
      const selector = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
      await waitFor(() => evaluate(`Boolean(${selector})`), `button ${text}`);
      await evaluate(`(() => { ${selector}.click(); return true; })()`);
    };
    const running = () => evaluate(`Boolean([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'STOP'))`);
    await click("OPEN PROJECT");
    await waitFor(() => evaluate('Boolean(document.querySelector("img.bg-layer"))'), "saved background visible");
    await click("Media");
    await click("Remove background");
    await waitFor(() => evaluate('!document.querySelector(".bg-layer")'), "background cleared immediately");
    await click("Save");
    await waitFor(async () => (await library.getSong(context, seed.id)).assets.background === null, "background removal saved");
    await waitFor(() => evaluate('document.body.innerText.includes("Project saved.")'), "save completed");
    await click("Library");
    await click("OPEN PROJECT");
    await click("Media");
    assert.equal(await evaluate('document.body.innerText.includes("Remove background")'), false, "background restored after reopening");
    // Picking another image after clearing is allowed; clearing it before
    // generation must also discard the pending upload.
    await evaluate(`(() => {
      const input = document.querySelector('input[accept="image/*"]');
      const files = new DataTransfer();
      files.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'], 'background.svg', { type: 'image/svg+xml' }));
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(() => evaluate('Boolean(document.querySelector("img.bg-layer"))'), "replacement image visible");
    await click("Remove background");
    await waitFor(() => evaluate('!document.querySelector(".bg-layer")'), "pending background cleared");
    await click("GENERATE CHART");
    await waitFor(() => jobs.length === 1, "job started");
    assert.equal((await library.getSong(context, seed.id)).assets.background, null, "generation restored the removed background");
    for (let i = 0; i < 4; i++) {
      win.webContents.send("engine:jobEvent", { jobId: jobs[0].payload.jobId, type: "stage", stage: "transcription", status: "running", progress: (i + 1) / 5 });
      await click("Library");
      await click("OPEN PROJECT");
      await waitFor(running, `run survives round trip ${i + 1}`);
    }
    await click("Library");
    jobs[0].resolve({ jobId: jobs[0].payload.jobId, status: "completed", chartText });
    await waitFor(async () => (await library.getSong(context, seed.id)).versions.length === 2, "second take saved while in library");
    await click("OPEN PROJECT");
    await waitFor(() => evaluate('document.querySelectorAll(".take-card[role=button]").length === 2'), "second take visible");
    await click("Library");
    await click("OPEN PROJECT");
    await waitFor(() => evaluate('document.querySelectorAll(".take-card[role=button]").length === 2'), "second take survives reopening");
    assert.equal((await library.getSong(context, seed.id)).versions.length, 2);
    // Opening compare during playback must not unmount the app with a render
    // error. Exercise the real take checkboxes and both preview transports.
    await waitFor(() => evaluate('Boolean(document.querySelector(".single-preview .transport-btn:not(.ghost):not(:disabled)"))'), "single preview ready");
    await evaluate('document.querySelector(".single-preview .transport-btn").click()');
    await waitFor(() => evaluate('document.querySelector(".single-preview .transport-btn")?.textContent.includes("Pause")'), "single preview playing");
    await evaluate('document.querySelectorAll(".take-check input").forEach(input => { if (!input.checked) input.click(); })');
    await click("Compare (2)");
    await waitFor(() => evaluate('document.querySelectorAll(".joined-highway-canvas").length === 2 && Number(document.querySelector(".compare-timeline .seekbar")?.max) > 29'), "joined compare loaded with audio duration");
    const compareButton = 'document.querySelector(".compare-transport .transport-btn")';
    await evaluate(`${compareButton}.click()`);
    await waitFor(() => evaluate('Number(document.querySelector(".compare-timeline .seekbar")?.value) > 0.2'), "joined compare playback advances");
    await evaluate(`${compareButton}.click()`);
    await evaluate(`(() => {
      const seek = document.querySelector('.compare-timeline .seekbar');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(seek, '10');
      seek.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(() => evaluate('document.querySelector(".compare-transport .transport-time")?.textContent === "0:10"'), "compare seek updates transport");
    await click("Split");
    await waitFor(() => evaluate('document.querySelectorAll(".compare-pane canvas.highway-canvas").length === 2 && !document.querySelector(".highway-loading")'), "split compare ready");
    await evaluate(`${compareButton}.click()`);
    await waitFor(() => evaluate('Number(document.querySelector(".compare-timeline .seekbar")?.value) > 10.2'), "split compare playback advances");
    await click("✕ Close compare");
    await waitFor(() => evaluate('Boolean(document.querySelector(".single-preview"))'), "single preview restored after compare");
    assert.deepEqual(errors, [], "renderer errors during compare");
    await click("GENERATE CHART");
    await waitFor(() => jobs.length === 2, "second job started");
    // The completion promise in the old document is now gone. Electron must
    // still save the take before there is any renderer to receive its result.
    await win.loadFile(path.join(temp, "index.html"));
    await click("OPEN PROJECT");
    await waitFor(() => evaluate('document.querySelectorAll(".take-card[role=button]").length === 2'), "project reopened during detached generation");
    const result = { jobId: jobs[1].payload.jobId, status: "completed", chartText };
    jobs[1].resolve(result);
    await waitFor(async () => (await library.getSong(context, seed.id)).versions.length === 3, "take saved after renderer reload");
    // Concurrent metadata patches and duplicate completion cannot erase or
    // duplicate the just-finished take.
    await Promise.all([
      persistGeneratedTake(context, seed.id, result, jobs[1].payload),
      library.patchSong(context, { record: { id: seed.id, meta: { favorite: true } } }),
    ]);
    const saved = await library.getSong(context, seed.id);
    assert.equal(saved.versions.length, 3);
    assert.equal(saved.meta.favorite, true);
    await waitFor(() => evaluate('document.querySelectorAll(".take-card[role=button]").length === 3'), "all takes visible after reload");
    assert.deepEqual(errors, [], "renderer errors during navigation");
    await click("GENERATE CHART");
    await waitFor(() => jobs.length === 3, "accelerated job started");
    const failedPayload = jobs[2].payload;
    jobs[2].reject(new Error("WebGPU device lost: execution failed"));
    await waitFor(() => evaluate('document.body.innerText.includes("Retry using CPU")'), "CPU recovery offered");
    await evaluate('document.querySelector(".difficulty-segments [role=radio]").click()');
    await waitFor(() => evaluate('document.querySelector(".difficulty-segments [role=radio]").getAttribute("aria-checked") === "true"'), "controls changed after failure");
    // Two clicks before React commits must still submit exactly one retry.
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Retry using CPU');
      button.click(); button.click();
    })()`);
    await waitFor(() => jobs.length === 4, "CPU retry started");
    const retryPayload = jobs[3].payload;
    assert.notEqual(retryPayload.jobId, failedPayload.jobId);
    assert.equal(retryPayload.hardwareMode, "cpu");
    for (const key of ["audio", "generation", "difficulty", "metadata", "sourceTransform", "sourceChart", "demucsSeparation"]) {
      assert.deepEqual(retryPayload[key], failedPayload[key], `CPU retry changed ${key}`);
    }
    jobs[3].resolve({ jobId: retryPayload.jobId, status: "completed", chartText });
    await waitFor(async () => (await library.getSong(context, seed.id)).versions.length === 4, "retry take saved once");
    await waitFor(() => evaluate('document.querySelectorAll(".take-card[role=button]").length === 4'), "retry take visible");
    assert.equal(jobs.length, 4, "duplicate retry submitted");
    await click("GENERATE CHART");
    await waitFor(() => jobs.length === 5, "unrelated failure job started");
    jobs[4].reject(new Error("Audio file is missing"));
    await waitFor(() => evaluate('document.body.innerText.includes("Audio file is missing") && !document.body.innerText.includes("STOPPING")'), "unrelated failure visible");
    assert.equal(await evaluate('document.body.innerText.includes("Retry using CPU")'), false, "file error offered hardware recovery");
    assert.equal((await library.getSong(context, seed.id)).versions.length, 4, "failed run added a take");
    assert.deepEqual(errors, [], "renderer errors during CPU retry");
    console.log("CPU recovery: same inputs, fresh job ID, duplicate-click guard, durable take, and unrelated-error rejection passed");
    console.log("generation navigation: repeated trips, background completion, compare playback and seeking, renderer reload, and concurrent favorite persistence passed");
  } finally {
    win?.destroy();
    testWindow = null;
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

app.on("window-all-closed", () => {});
app.whenReady().then(main).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
