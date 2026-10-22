// Run with: npx electron scripts/test-generator-picker-electron.cjs [--screenshots <dir>]
// Real React UI and preload IPC with the shipped engine/manifest.json:
// - installed-only generators stay hidden until their setup is ready, and
//   Fretformer keeps the plain model plate;
// - once installed, the plate is a model picker with a NEW badge;
// - picking the six-stem model swaps the Style faders to its set and the
//   generate payload carries its generator id and knob names;
// - separation cards list each model's stems only where that separation has
//   them (three lead-in separations, only one separated for the six-stem set);
// - a model that marks solos shows Mark solos and Force a solo in More
//   settings, and the payload carries both.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain } = require("electron");
const esbuild = require("esbuild");
const library = require("../electron/libraryStore.cjs");
const chartWriter = require("../shared/chartWriter.js");
const engineManifest = require("../engine/manifest.json");
const ROOT = path.resolve(__dirname, "..");
const V1_ID = "autochart.fretformer.v1-onnx";
const REMOVED_IDS = [
  "autochart.fretformer.v1-2-onnx",
  "autochart.fretformer.v2-onnx",
  "autochart.fretformer.v2-dpo3-onnx",
];
const KEPT_IDS = [
  "autochart.fretformer.v2-dpo-onnx",
  "autochart.fretformer.v2-dpo-fim-onnx",
];
// The first six-stem generator is the one separation cards name, and the one
// this test selects. It also marks solos.
const SIX_STEM = engineManifest.generators.find((generator) => generator.separation?.stemSet === "htdemucs_6s");
if (!SIX_STEM?.capabilities?.structureMarkers?.includes("solos")) {
  throw new Error("expected the first six-stem generator to mark solos");
}
// Every installed-only generator in the manifest is hidden until its folder
// exists, and shows up in the picker after.
const INSTALLED_ONLY = new Set(engineManifest.generators.filter((g) => g.availability === "installed").map((g) => g.id));

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main() {
  const screenshotIndex = process.argv.indexOf("--screenshots");
  const screenshotDir = screenshotIndex > 0 ? path.resolve(process.argv[screenshotIndex + 1]) : "";
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-picker-"));
  const context = { userDataPath: temp, projectsFolder: path.join(temp, "projects") };
  const payloads = [];
  let installedReady = false;
  let win;
  try {
    for (const id of REMOVED_IDS) {
      assert.equal(engineManifest.generators.some((generator) => generator.id === id), false, `${id} is still a generator`);
    }
    for (const id of KEPT_IDS) {
      assert.equal(engineManifest.generators.some((generator) => generator.id === id), true, `${id} should stay`);
    }
    const chartText = chartWriter.writeChartText([[0, 0, 0], [192, 1, 0]], {
      title: "Picker fixture", difficulty: "expert", resolution: 192, syncLines: ["0 = B 120000"],
    }).text;
    const transform = (ms) => ({
      kind: ms ? "lead-in-silence" : "original", leadInSilenceSeconds: ms / 1000, leadInSilenceMs: ms,
      key: `lead-in:${ms}`, label: ms ? `+${ms / 1000}s lead-in` : "No lead-in",
    });
    const stemMap = (names) => Object.fromEntries(names.map((name) => [name, { path: `/fixture/${name}.wav`, format: "wav", mime: "audio/wav" }]));
    const v1Stems = stemMap(["other", "drums", "bass", "vocals"]);
    const separation = (id, ms, sixStem) => ({
      id, engineId: "demucs_default", name: ms ? `Default separation (+${ms / 1000}s lead-in)` : "Default separation",
      status: "ready", createdAt: 1, updatedAt: 1, profile: "Standard Demucs", stems: v1Stems,
      stemSets: sixStem
        ? { htdemucs: { stems: v1Stems }, htdemucs_6s: { stems: stemMap(["drums", "bass", "vocals", "guitar", "other"]) } }
        : {},
      cache: { workspace: `/fixture/${id}` }, sourceTransform: transform(ms), sourceVariantKey: `lead-in:${ms}`,
    });
    const seed = {
      id: "picker_fixture", schemaVersion: 2, source: "generated", status: "charted",
      sourceArtifacts: {
        demucs: {
          activeId: "demucs_default",
          activeBySourceVariant: { "lead-in:0": "demucs_default", "lead-in:500": "demucs_default__lead_in_500", "lead-in:1000": "demucs_default__lead_in_1000" },
          items: [
            separation("demucs_default__lead_in_500", 500, true),
            separation("demucs_default__lead_in_1000", 1000, false),
            separation("demucs_default", 0, false),
          ],
        },
      },
      createdAt: Date.now(), updatedAt: Date.now(),
      meta: { title: "Picker fixture", artist: "Test", favorite: false },
      settings: { difficulty: "expert", activeVersionId: "take_1" },
      chart: { text: chartText },
      versions: [{ id: "take_1", name: "Take 1", source: "generated", status: "charted", settings: { difficulty: "expert" }, chart: { text: chartText } }],
    };
    await library.saveSong(context, {
      record: seed,
      assets: { audio: { name: "song.wav", mime: "audio/wav", data: await fs.readFile(path.join(ROOT, "fixtures/demo/autochart-demo-30s.wav")) } },
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
    ipcMain.handle("window:isFullscreen", () => false);
    ipcMain.handle("engine:getManifest", () => ({
      available: true,
      setup: { ready: true },
      generators: engineManifest.generators.map((generator) => ({
        ...generator,
        setup: INSTALLED_ONLY.has(generator.id) && !installedReady
          ? { ready: false, status: "missing", message: `${generator.models.onnxFolder} is not installed.` }
          : { ready: true, status: "ready" },
      })),
    }));
    ipcMain.handle("engine:generateChart", (_event, payload) => {
      payloads.push(payload);
      return { jobId: payload.jobId, status: "canceled" };
    });
    await esbuild.build({
      absWorkingDir: ROOT,
      stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; import App from "./src/App.jsx"; createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);', resolveDir: ROOT, loader: "jsx" },
      bundle: true, outfile: path.join(temp, "app.js"), format: "iife", platform: "browser", jsx: "automatic",
      alias: { "@autochart/chart-writer": path.join(ROOT, "shared/chartWriter.js") },
      define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "true" }, logLevel: "silent",
    });
    await fs.copyFile(path.join(ROOT, "src/styles.css"), path.join(temp, "app.css"));
    await fs.writeFile(path.join(temp, "index.html"), '<link rel="stylesheet" href="app.css"><div id="root"></div><script src="app.js"></script>');
    // Hidden windows stop painting after navigation, so screenshots render offscreen.
    win = new BrowserWindow({
      show: false,
      width: 1440,
      height: 1000,
      webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), contextIsolation: true, offscreen: Boolean(screenshotDir) },
    });
    await win.loadFile(path.join(temp, "index.html"));
    const evaluate = (code) => Promise.race([
      win.webContents.executeJavaScript(code, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`renderer did not answer: ${code.slice(0, 80)}`)), 10000)),
    ]);
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 15000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}\n${await evaluate("document.body.innerText")}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const step = (label) => { if (process.env.PICKER_DEBUG) console.log(`[picker] ${label}`); };
    const click = async (text) => {
      step(`click ${text}`);
      const selector = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
      await waitFor(() => evaluate(`Boolean(${selector})`), `button ${text}`);
      await evaluate(`(() => { ${selector}.click(); return true; })()`);
    };
    const faderNames = () => evaluate('[...document.querySelectorAll(".style-fader-name")].map(n => n.textContent.trim())');
    const openMoreSettings = async () => {
      if (await evaluate('Boolean(document.querySelector(".more-settings"))')) return;
      await evaluate('document.querySelector(".more-settings-row").click()');
      await waitFor(() => evaluate('Boolean(document.querySelector(".more-settings"))'), "more settings");
    };
    const settingButton = (label) => `[...document.querySelectorAll(".ms-row")].find((row) => row.querySelector("b")?.textContent.trim().startsWith(${JSON.stringify(label)}))?.querySelector("button")`;
    const screenshotDeck = async (name) => {
      if (!screenshotDir) return;
      await fs.mkdir(screenshotDir, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const rect = await evaluate('(() => { const r = document.querySelector(".demucs-row").getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()');
      const image = await win.webContents.capturePage(rect);
      await fs.writeFile(path.join(screenshotDir, `${name}.png`), image.toPNG());
    };
    const screenshot = async (name, selector = ".console-rail") => {
      if (!screenshotDir) return;
      await fs.mkdir(screenshotDir, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const rect = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);
      const image = await win.webContents.capturePage(rect);
      await fs.writeFile(path.join(screenshotDir, `${name}.png`), image.toPNG());
    };

    // Not installed: v1 only, plain plate, v1 faders, solos disabled.
    await click("OPEN PROJECT");
    await waitFor(() => evaluate('Boolean(document.querySelector(".model-plate-name"))'), "model plate");
    assert.equal(await evaluate('Boolean(document.querySelector(".model-plate-picker"))'), false, "no picker while test models are missing");
    assert.equal(await evaluate('document.querySelector(".model-plate-name").textContent.trim()'), "Fretformer");
    await waitFor(async () => (await faderNames()).length > 0, "style faders");
    assert.deepEqual(await faderNames(), ["Speed", "Chords", "Tech", "Move", "Repeat"]);
    await openMoreSettings();
    const v1Solos = settingButton("Mark solos");
    await waitFor(() => evaluate(`Boolean(${v1Solos})`), "Mark solos row");
    assert.equal(await evaluate(`${v1Solos}.disabled`), true, "v1 cannot mark solos");
    assert.equal(await evaluate('document.body.innerText.includes("this model doesn\'t mark solos")'), true, "v1 explains that it has no solos");
    await screenshot("1-v1-only");

    // Installed: reload the manifest (navigate away and back).
    installedReady = true;
    await click("Library");
    await click("OPEN PROJECT");
    await waitFor(() => evaluate('Boolean(document.querySelector(".model-plate-picker select"))'), "model picker");
    const options = await evaluate('[...document.querySelectorAll(".model-plate-picker option")].map(o => [o.value, o.textContent])');
    assert.deepEqual(options, engineManifest.generators.map((g) => [g.id, g.label]));
    assert.equal(await evaluate('document.querySelector(".model-plate-picker select").value'), V1_ID, "v1 stays the default");
    assert.equal(await evaluate('Boolean(document.querySelector(".model-plate-badge"))'), false, "no badge on v1");
    await waitFor(async () => (await faderNames()).length > 0, "style faders");
    await screenshot("2-v1-selected");

    await evaluate(`(() => {
      const select = document.querySelector(".model-plate-picker select");
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      setter.call(select, ${JSON.stringify(SIX_STEM.id)});
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    await waitFor(() => evaluate('document.querySelector(".model-plate-badge")?.textContent.trim() === "New"'), "NEW badge");
    assert.deepEqual(await faderNames(), ["Speed", "Chords", "HOPOs", "Taps", "Move"]);
    assert.equal(await evaluate(`document.body.innerText.includes(${JSON.stringify(`Its takes are tagged ${SIX_STEM.label}`)})`), true, "test-model note");
    await screenshot("3-six-stem-selected");

    // Separation cards: only the +0.5s separation has six-stem stems.
    const cards = () => evaluate(`[...document.querySelectorAll(".demucs-card")].map((card) => ({
      name: card.querySelector(".take-name").textContent.trim(),
      labels: [...card.querySelectorAll(".demucs-set-label")].map((n) => n.textContent.trim()),
      missing: [...card.querySelectorAll(".demucs-set-missing")].length,
      buttons: [...card.querySelectorAll(".demucs-stem-grid button")].map((b) => b.textContent.trim()),
    }))`);
    await evaluate('[...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("SEPARATION")).click()');
    await waitFor(async () => (await cards()).length === 3, "three separation cards");
    const sixStemCards = Object.fromEntries((await cards()).map((card) => [card.name, card]));
    assert.deepEqual(sixStemCards["Default · +0.5s"].labels, ["Fretformer · 4 stems", `${SIX_STEM.label} · 5 stems`]);
    assert.deepEqual(sixStemCards["Default · +0.5s"].buttons, ["Other", "Drums", "Bass", "Vocals", "Guitar", "Other", "Drums", "Bass", "Vocals"]);
    for (const name of ["Default", "Default · +1s"]) {
      assert.equal(sixStemCards[name].missing, 1, `${name} says it has no six-stem stems yet`);
      assert.deepEqual(sixStemCards[name].buttons, ["Other", "Drums", "Bass", "Vocals"], `${name} plays only its v1 stems`);
    }
    await screenshotDeck("4-separations-six-stem");

    await openMoreSettings();
    const solosButton = settingButton("Mark solos");
    const forceButton = settingButton("Force a solo");
    await waitFor(() => evaluate(`Boolean(${solosButton})`), "Mark solos switch");
    assert.equal(await evaluate(`${solosButton}.disabled`), false, "the six-stem model can mark solos");
    assert.equal(await evaluate(`${solosButton}.textContent.trim()`), "On", "Mark solos defaults to on");
    assert.equal(await evaluate(`${forceButton}.textContent.trim()`), "Off", "Force a solo defaults to off");
    assert.equal(await evaluate(`${forceButton}.disabled`), false, "Force a solo is available while Mark solos is on");
    const tooltip = await evaluate('document.querySelector(".ms-info")?.getAttribute("title") || ""');
    assert.match(tooltip, /takes longer/, "Force a solo has its info tooltip");

    await click("GENERATE CHART");
    await waitFor(() => payloads.length === 1, "generate payload");
    const payload = payloads[0];
    assert.equal(payload.generatorId, SIX_STEM.id);
    assert.deepEqual(Object.keys(payload.generation.controls.knobs), SIX_STEM.capabilities.descriptorKnobs);
    assert.match(payload.versionName, new RegExp(`^${escapeRegExp(SIX_STEM.label)} `));
    assert.equal(payload.generation.controls.solos, true, "solos default on");
    assert.equal(payload.generation.resolved.forceSolo, false, "Force a solo defaults off in the payload");

    await evaluate(`(() => { ${forceButton}.click(); return true; })()`);
    await waitFor(async () => (await evaluate(`${forceButton}.textContent.trim()`)) === "On", "Force a solo on");
    await screenshot("6-force-solo", ".more-settings");
    await click("GENERATE CHART");
    await waitFor(() => payloads.length === 2, "force-solo generate payload");
    assert.equal(payloads[1].generatorId, SIX_STEM.id);
    assert.equal(payloads[1].generation.controls.forceSolo, true, "payload carries forceSolo=true");
    assert.equal(payloads[1].generation.resolved.forceSolo, true);

    // Mark solos off disables Force a solo and turns it off in the payload.
    await openMoreSettings();
    await evaluate(`(() => { ${solosButton}.click(); return true; })()`);
    await waitFor(async () => (await evaluate(`${solosButton}.textContent.trim()`)) === "Off", "Mark solos off");
    assert.equal(await evaluate(`${forceButton}.disabled`), true, "Force a solo is disabled while Mark solos is off");
    await click("GENERATE CHART");
    await waitFor(() => payloads.length === 3, "solos-off payload");
    assert.equal(payloads[2].generation.controls.solos, false, "payload carries solos=false");
    assert.equal(payloads[2].generation.resolved.forceSolo, false, "Force a solo is off while Mark solos is off");

    // Back on v1, cards without six-stem stems look exactly as before.
    await evaluate(`(() => {
      const select = document.querySelector(".model-plate-picker select");
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      setter.call(select, ${JSON.stringify(V1_ID)});
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    await waitFor(async () => (await cards()).every((card) => card.missing === 0), "v1 cards");
    const v1Cards = Object.fromEntries((await cards()).map((card) => [card.name, card]));
    assert.deepEqual(v1Cards.Default.labels, [], "plain v1 card has no model rows");
    assert.equal(v1Cards["Default · +0.5s"].labels.length, 2, "existing six-stem stems stay listed");
    await screenshotDeck("5-separations-v1");
    console.log("generator picker: hidden until installed, v1 default, six-stem knobs and payload, Mark solos and Force a solo passed");
  } finally {
    win?.destroy();
    await fs.rm(temp, { recursive: true, force: true });
  }
}

app.whenReady().then(main).then(() => app.exit(0), (error) => {
  console.error(error.stack || error);
  app.exit(1);
});
