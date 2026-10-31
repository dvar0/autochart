// Run with: npx electron scripts/test-generation-queue.cjs
// Real React UI, preload IPC, and filesystem library; generation is held at
// deterministic checkpoints so the queue's order and races are repeatable.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain } = require("electron");
const esbuild = require("esbuild");
const viteWorkers = require("./esbuild-vite-workers.cjs");
const library = require("../electron/libraryStore.cjs");
const { persistGeneratedTake } = require("../electron/generatedTake.cjs");
const chartWriter = require("../shared/chartWriter.js");
const ROOT = path.resolve(__dirname, "..");

const temp = fsSync.mkdtempSync(path.join(os.tmpdir(), "autochart-queue-"));
app.setPath("userData", path.join(temp, "user-data"));
let testWindow;

const chartFor = (difficulty) => chartWriter.writeChartText([[0, 0, 0], [192, 1, 0], [384, 2, 0]], {
  title: "Queue fixture", difficulty, resolution: 192, syncLines: ["0 = B 120000"],
}).text;

async function main() {
  const context = { userDataPath: temp, projectsFolder: path.join(temp, "projects") };
  const songsFolder = path.join(temp, "songs");
  const exportFolder = path.join(temp, "exported");
  await fs.mkdir(songsFolder);
  await fs.mkdir(exportFolder);
  const jobs = [];
  const errors = [];
  const awake = [];
  let win;
  let exportTaken = new Set();
  const audio = await fs.readFile(path.join(ROOT, "fixtures/demo/autochart-demo-30s.wav"));
  const expertChart = chartFor("expert");
  const seedSong = async (id, title, extra = {}) => library.saveSong(context, {
    record: {
      id, schemaVersion: 2, source: "generated", status: "new", createdAt: Date.now(), updatedAt: Date.now(),
      meta: { title, artist: "Test", favorite: false, durationSec: 30 },
      settings: { difficulty: "expert" }, chart: { text: "" }, versions: [], arrangements: [],
      ...extra,
    },
    assets: { audio: { name: "song.wav", mime: "audio/wav", data: audio } },
  });
  try {
    await seedSong("alpha", "Alpha", {
      source: "generated", status: "charted", chart: { text: expertChart },
      versions: [{ id: "take_1", name: "Take 1", source: "generated", status: "charted", settings: { difficulty: "expert" }, chart: { text: expertChart } }],
      arrangements: [{ id: "arr_final", name: "Final Chart", kind: "difficulty-slots", slots: { easy: "", medium: "", hard: "", expert: "take_1" } }],
    });
    await seedSong("bravo", "Bravo");
    await seedSong("charlie", "Charlie", { source: "imported-chart", status: "charted", chart: { text: expertChart } });
    await seedSong("delta", "Delta", {
      sourceArtifacts: { demucs: { activeId: "demucs_default", activeBySourceVariant: {}, items: [{
        id: "demucs_default", engineId: "demucs_default", status: "ready", sourceVariantKey: "lead-in:0",
        stemSets: { htdemucs_6s: { melTables: { path: "mel" } } },
      }] } },
    });

    ipcMain.handle("settings:get", () => ({ setupComplete: true, cloneHeroLibraryFolder: songsFolder }));
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
    ipcMain.handle("library:saveSongToCloneHeroLibrary", (_event, { songId, versionId }) =>
      library.saveSongToCloneHeroLibrary(context, songId, songsFolder, { versionId }));
    ipcMain.handle("library:chooseExportFolder", () => {
      exportTaken = new Set();
      return { canceled: false, grant: "grant", path: exportFolder };
    });
    ipcMain.handle("library:exportSongToChosenFolder", (_event, { songId, versionId }) =>
      library.exportSongIntoFolder(context, songId, exportFolder, exportTaken, { versionId }));
    ipcMain.handle("engine:getManifest", () => ({
      available: true,
      preferences: {},
      generators: [{
        id: "autochart.fretformer.v2-onnx",
        label: "Fretformer 2",
        setup: { ready: true },
        separation: { cacheSubdir: "htdemucs_6s", stemSet: "htdemucs_6s" },
        capabilities: { difficulties: ["easy", "medium", "hard", "expert"] },
      }],
    }));
    ipcMain.handle("engine:keepAwake", (_event, on) => {
      awake.push(on);
    });
    ipcMain.handle("engine:generateChart", async (event, payload) => {
      const result = await new Promise((resolve, reject) => jobs.push({ payload, resolve, reject, sender: event.sender }));
      if (result.status === "canceled") return result;
      const saved = await persistGeneratedTake(context, payload.audio.projectId, result, payload);
      if (!event.sender.isDestroyed()) event.sender.send("engine:jobEvent", { type: "project_saved", projectId: payload.audio.projectId, jobId: result.jobId });
      return saved;
    });
    ipcMain.handle("engine:cancelJob", (_event, { jobId }) => {
      jobs.find((job) => job.payload.jobId === jobId)?.resolve({ jobId, status: "canceled" });
      return { ok: true, jobId, status: "canceling" };
    });
    ipcMain.handle("window:isFullscreen", () => false);

    await esbuild.build({
      plugins: [viteWorkers],
      absWorkingDir: ROOT,
      stdin: { contents: 'import React from "react"; import {createRoot} from "react-dom/client"; import App from "./src/App.jsx"; createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);', resolveDir: ROOT, loader: "jsx" },
      bundle: true, outfile: path.join(temp, "app.js"), format: "iife", platform: "browser", jsx: "automatic",
      alias: { "@autochart/chart-writer": path.join(ROOT, "shared/chartWriter.js") },
      define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "true" }, logLevel: "silent",
    });
    await fs.copyFile(path.join(ROOT, "src/styles.css"), path.join(temp, "app.css"));
    await fs.writeFile(path.join(temp, "index.html"), '<link rel="stylesheet" href="app.css"><div id="root"></div><script src="app.js"></script>');
    win = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { preload: path.join(ROOT, "electron/preload.cjs"), contextIsolation: true } });
    testWindow = win;
    win.webContents.on("console-message", ({ level, message }) => {
      if (level === "error") errors.push(message);
    });
    await win.loadFile(path.join(temp, "index.html"));

    const evaluate = (code) => win.webContents.executeJavaScript(code, true);
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 15000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}\n${await evaluate("document.body.innerText")}\n${errors.join("\n")}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const buttonNamed = (text) => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
    const hasButton = (text) => evaluate(`Boolean(${buttonNamed(text)})`);
    const click = async (text) => {
      await waitFor(() => evaluate(`Boolean(${buttonNamed(text)}) && !${buttonNamed(text)}.disabled`), `button ${text}`);
      await evaluate(`(() => { ${buttonNamed(text)}.click(); return true; })()`);
    };
    const pick = (title, shift = false) => evaluate(`(() => {
      document.querySelector('.tile-select[aria-label^=${JSON.stringify(title)}]')
        .dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: ${shift} }));
      return true;
    })()`);
    const badge = (title) => evaluate(`document.querySelector('.tile-select[aria-label^=${JSON.stringify(title)}] .queue-badge')?.className || ""`);
    const percent = () => evaluate(`Number(document.querySelector(".queue-percent").textContent.replace("%", ""))`);
    const tileOrder = () => evaluate('[...document.querySelectorAll(".tile-select")].map(b => b.getAttribute("aria-label").split(" by ")[0])');
    const panelText = () => evaluate(`document.querySelector(".queue-panel").innerText`);
    const song = (id) => library.getSong(context, id);
    const finish = (job) => job.resolve({ jobId: job.payload.jobId, status: "completed", chartText: chartFor(job.payload.difficulty) });
    const send = (job, event) => job.sender.send("engine:jobEvent", { jobId: job.payload.jobId, ...event });
    const expectJobs = (count, label) => waitFor(() => jobs.length === count, label);

    // Picking keeps the Library on screen; the right panel becomes the queue.
    await waitFor(() => hasButton("Queue"), "Queue button");
    await click("Queue");
    await waitFor(() => evaluate('Boolean(document.querySelector(".queue-panel"))'), "queue panel");
    assert.equal(await evaluate('Boolean(document.querySelector(".tile-select"))'), true, "library left the screen");
    assert.equal(await evaluate('document.querySelector(".queue-panel .gen-cta").disabled'), true, "Generate on with an empty queue");
    await waitFor(() => evaluate('document.querySelectorAll(".tile-select").length === 4'), "tiles");
    const order = await evaluate('[...document.querySelectorAll(".tile-select")].map(b => b.getAttribute("aria-label").split(" by ")[0])');
    await pick(order[0]);
    await waitFor(async () => (await badge(order[0])).includes("is-waiting"), "first pick marked");
    await pick(order[0]);
    await waitFor(async () => (await badge(order[0])).includes("is-add"), "second click removes");
    await click("Add all");
    await waitFor(async () => (await panelText()).includes("0 of 4 charts"), "Add all adds what's shown");
    assert.equal(await evaluate(`${buttonNamed("Add all")}.disabled`), true, "Add all on with everything added");
    await click("Clear");
    await waitFor(async () => (await badge(order[0])).includes("is-add"), "Clear empties the queue");
    await pick(order[0]);
    await pick(order[3], true);
    await waitFor(async () => (await panelText()).includes("0 of 4 charts"), "shift-click adds the range");
    await pick("Delta");
    await waitFor(async () => (await panelText()).includes("0 of 3 charts"), "removed Delta");
    await waitFor(() => hasButton("Generate 3 charts"), "Generate 3 charts");
    console.log("picking: toggle and shift range passed");

    // One job at a time, in order, with the Generate payload's settings.
    const first = order.filter((title) => title !== "Delta");
    await click("Generate 3 charts");
    await expectJobs(1, "first song started");
    await waitFor(async () => (await tileOrder()).slice(0, 3).join() === [...first].reverse().join(), "songs moved to where they will finish");
    await waitFor(() => evaluate(`Boolean(${buttonNamed("Stop")})`), "Stop shown");
    assert.deepEqual(awake.at(-1), true, "sleep not held off");
    const [job1] = jobs;
    assert.equal(job1.payload.replaceFinal, true);
    assert.equal(job1.payload.audio.kind, "project-asset");
    assert.equal(job1.payload.sourceTransform.key, "lead-in:0");
    assert.equal(job1.payload.generatorId, "autochart.fretformer.v2-onnx");
    assert.equal(job1.payload.generation.modelPicked, true);
    send(job1, { type: "stage", stage: "demucs", status: "running", progress: 0.5 });
    await waitFor(async () => (await panelText()).includes("Separating"), "separating step shown");
    await waitFor(async () => (await percent()) > 0, "percent moved during separation");
    const midSeparation = await percent();
    send(job1, { type: "stage", stage: "demucs", status: "completed" });
    send(job1, { type: "stage", stage: "transcription", status: "running" });
    send(job1, { type: "partial_chart", committedBeats: 50, totalBeats: 100, noteLines: [] });
    await waitFor(async () => (await percent()) > midSeparation, "percent moved during charting");
    await waitFor(async () => (await evaluate('document.querySelector(".rail-item .rail-count")?.textContent || ""')).endsWith("%"), "rail shows percent");
    assert.equal(jobs.length, 1, "a second job ran alongside the first");
    finish(job1);
    await expectJobs(2, "second song started");
    assert.equal(jobs[1].payload.audio.projectId, first[1].toLowerCase(), "songs out of order");
    console.log("sequence: one job at a time, step and percent passed");

    // Closing the queue leaves only the song being charted marked on its tile.
    const orderWhileRunning = await tileOrder();
    await click("Close queue");
    await waitFor(() => evaluate('!document.querySelector(".queue-panel")'), "queue closed");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await tileOrder(), orderWhileRunning, "closing mid-run moved the tiles");
    await waitFor(() => evaluate('document.querySelectorAll(".queue-badge.is-add, .queue-badge.is-done, .queue-badge.is-waiting").length === 0'), "marks hidden");
    assert.equal(await evaluate('document.querySelectorAll(".tile.q-running .queue-badge.is-running").length'), 1, "charting song lost its mark");
    await evaluate('document.querySelector(".queue-toggle-btn").click()');
    await waitFor(() => evaluate('document.querySelectorAll(".tile .queue-badge.is-done").length === 1'), "marks back with the queue");
    await evaluate('document.querySelector(".queue-close").click()');
    await waitFor(() => evaluate('!document.querySelector(".queue-panel")'), "closed from the panel");
    await evaluate('document.querySelector(".queue-toggle-btn").click()');
    await waitFor(() => evaluate('Boolean(document.querySelector(".queue-panel"))'), "reopened");
    console.log("closing: marks follow the queue passed");

    // A project's run goes first; the queue waits between songs.
    if (jobs[1].payload.audio.projectId !== "alpha") {
      await evaluate(`[...document.querySelectorAll(".queue-row-open")].find(b => b.textContent.includes(${JSON.stringify(first[0])})).click()`);
    } else {
      throw new Error("expected the first song to be finished");
    }
    await waitFor(() => hasButton("Generate chart"), "project open");
    await click("Generate chart");
    await waitFor(() => evaluate('document.body.innerText.includes("Waiting for the queue")'), "project waits for the queue song");
    assert.equal(jobs.length, 2, "project started during a queue song");
    finish(jobs[1]);
    await expectJobs(3, "project run started");
    const projectJob = jobs[2];
    assert.equal(projectJob.payload.replaceFinal, false, "project take replaced the final chart");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(jobs.length, 3, "queue started during the project run");
    finish(projectJob);
    await expectJobs(4, "queue carried on after the project");
    await evaluate('document.querySelector(".rail-item[title=Library]").click()');
    await waitFor(() => evaluate('Boolean(document.querySelector(".queue-panel"))'), "queue panel still open");
    console.log("lanes: project first, queue resumes passed");

    // Stop cancels the current song and leaves it waiting.
    await click("Stop");
    await waitFor(() => hasButton("Generate 1 chart"), "stopped song waiting");
    assert.equal(awake.at(-1), false, "sleep still held off after stopping");
    const stoppedJob = jobs[3];
    await click("Generate 1 chart");
    await expectJobs(5, "restarted after stop");
    assert.notEqual(jobs[4].payload.jobId, stoppedJob.payload.jobId, "stopped song reused its job");
    finish(jobs[4]);
    await waitFor(async () => (await panelText()).includes("3 of 3 charts"), "all finished");
    await waitFor(async () => (await percent()) === 100, "100 percent");
    console.log("stop: canceled song restarts passed");

    // Queue takes replace the final slot; earlier takes stay in the project.
    const alpha = await song("alpha");
    const alphaFinal = alpha.arrangements.find((item) => item.id === "arr_final");
    const alphaQueueTake = `gen_${jobs.findLast((job) => job.payload.audio.projectId === "alpha").payload.jobId.replaceAll("-", "")}`;
    assert.equal(alphaFinal.slots.expert, alphaQueueTake, "queue take is not the final chart");
    assert.ok(alpha.versions.some((version) => version.id === "take_1"), "the earlier take was dropped");
    const charlie = await song("charlie");
    assert.ok(charlie.versions.some((version) => version.source === "imported-chart"), "imported chart was dropped");
    const charlieJob = jobs.find((job) => job.payload.audio.projectId === "charlie");
    assert.ok(charlieJob.payload.sourceChart?.text, "imported song didn't keep its sync");
    assert.equal(charlieJob.payload.generation.resolved.timingDetector, "source_chart_sync");
    console.log("final chart: replacement keeps earlier takes passed");

    // Save all writes every song to the game folder.
    await click("Save to Clone Hero / YARG");
    await waitFor(() => hasButton("Saved to Clone Hero / YARG"), "all saved");
    const saved = await fs.readdir(songsFolder);
    assert.equal(saved.length, 3, `saved ${saved.join(", ")}`);
    assert.ok(saved.every((name) => name.endsWith("(Autochart)")), "saved over a song's own name");
    await fs.access(path.join(songsFolder, saved[0], "notes.chart"));
    console.log("save all passed");

    // Export all picks one folder and writes each song under its own name.
    await click("Export all");
    await waitFor(async () => (await panelText()).includes("Exported 3 songs"), "exported note");
    const exported = await fs.readdir(exportFolder);
    assert.equal(exported.length, 3, `exported ${exported.join(", ")}`);
    await fs.access(path.join(exportFolder, exported[0], "notes.chart"));
    console.log("export all passed");

    // Two difficulties, a song that has its stems, and a failure the queue survives.
    await click("Clear");
    await waitFor(async () => (await panelText()).includes("No songs yet"), "cleared");
    await click("Easy");
    await waitFor(() => evaluate(`${buttonNamed("Easy")}.getAttribute("aria-pressed") === "true"`), "Easy on");
    await pick("Delta");
    await pick("Bravo");
    await waitFor(async () => (await panelText()).includes("0 of 4 charts"), "two charts each");
    await click("Generate 4 charts");
    await expectJobs(6, "Delta easy started");
    assert.equal(jobs[5].payload.audio.projectId, "delta");
    assert.equal(jobs[5].payload.difficulty, "easy");
    jobs[5].reject(new Error("WebGPU device lost: execution provider failed"));
    await expectJobs(7, "carried on after a failure");
    await waitFor(async () => (await panelText()).includes("device lost"), "failure shown");
    await waitFor(() => hasButton("Retry using CPU"), "CPU retry offered");
    assert.equal(jobs[6].payload.difficulty, "expert");
    finish(jobs[6]);
    await expectJobs(8, "Bravo easy");
    finish(jobs[7]);
    await expectJobs(9, "Bravo expert");
    finish(jobs[8]);
    await waitFor(async () => (await badge("Bravo")).includes("is-done"), "Bravo done");
    await waitFor(async () => (await badge("Delta")).includes("is-failed"), "Delta failed");
    assert.ok((await song("bravo")).arrangements.find((item) => item.id === "arr_final").slots.easy, "easy slot empty");
    await click("Retry using CPU");
    await expectJobs(10, "CPU retry started");
    assert.equal(jobs[9].payload.hardwareMode, "cpu");
    assert.equal(jobs[9].payload.difficulty, "easy");
    finish(jobs[9]);
    await waitFor(async () => (await badge("Delta")).includes("is-done"), "retry finished");
    console.log("difficulties and recovery: failed song, carry on, CPU retry passed");

    // Songs dropped with the queue open import and join it.
    await evaluate(`(async () => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(await (await fetch(${JSON.stringify(pathToFileURL(path.join(ROOT, "fixtures/demo/autochart-demo-30s.wav")).href)})).arrayBuffer())], "Echo.wav", { type: "audio/wav" }));
      document.querySelector(".library-body").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
      return true;
    })()`);
    await waitFor(async () => (await panelText()).includes("Echo"), "dropped song in the queue");
    await waitFor(() => hasButton("Generate 2 charts"), "dropped song waiting");
    console.log("drop: imported song joins the queue passed");

    // A take landing on the open project joins it without resetting the session.
    await click("Generate 2 charts");
    await expectJobs(11, "Echo started");
    // Opening a project mid-run shows the run as its own, caught up so far.
    send(jobs[10], { type: "stage", stage: "demucs", status: "completed" });
    send(jobs[10], { type: "stage", stage: "transcription", status: "running" });
    send(jobs[10], { type: "partial_chart", committedBeats: 50, totalBeats: 100, noteLines: [] });
    await waitFor(async () => (await panelText()).includes("Charting"), "queue charting Echo");
    await evaluate(`[...document.querySelectorAll(".queue-row-open")].find(b => b.textContent.includes("Echo")).click()`);
    await waitFor(() => hasButton("Stop"), "Echo's page shows the run");
    await waitFor(() => evaluate('Boolean(document.querySelector(".gen-progress, .generation-progress, [class*=gen-run], [class*=gen-progress]"))'), "progress on the project page");
    finish(jobs[10]);
    await expectJobs(12, "Echo second chart");
    await waitFor(() => hasButton("Stop"), "second chart shown too");
    finish(jobs[11]);
    const echoId = jobs[10].payload.audio.projectId;
    await waitFor(async () => (await song(echoId)).versions.length === 2, "Echo takes saved");
    await waitFor(() => hasButton("Generate chart"), "Generate back after the run");
    const newestTake = (await song(echoId)).versions.at(-1).name;
    await waitFor(() => evaluate(`document.querySelector(".take-card.selected")?.innerText.includes(${JSON.stringify(newestTake)})`), "the shown run's take selected");
    await click("Medium");
    const mediumOn = `${buttonNamed("Medium")}.getAttribute("aria-checked") === "true"`;
    await waitFor(() => evaluate(mediumOn), "a setting changed in the open project");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await evaluate(mediumOn), true, "the open project was reset");
    await waitFor(() => evaluate('document.querySelectorAll(".take-card[role=button]").length === 2'), "takes joined the open project");
    await evaluate('document.querySelector(".rail-item[title=Library]").click()');
    await waitFor(() => evaluate('Boolean(document.querySelector(".queue-panel"))'), "back in the library");
    console.log("open project: queue takes join without a reset passed");

    await click("Clear");
    await waitFor(async () => (await panelText()).includes("No songs yet"), "cleared again");
    // A finished run leaves the tiles where Generate put them, also after closing.
    const lastTwo = (await tileOrder()).slice(-2);
    await pick(lastTwo[0]);
    await pick(lastTwo[1]);
    await click("Generate 4 charts");
    await waitFor(async () => (await tileOrder()).slice(0, 2).join() === [...lastTwo].reverse().join(), "picks moved up on Generate");
    const placed = await tileOrder();
    const jobsBefore = jobs.length - 1;
    for (let done = 0; done < 4; done += 1) {
      await expectJobs(jobsBefore + done + 1, `chart ${done + 1} of the two songs started`);
      finish(jobs.at(-1));
    }
    await waitFor(async () => (await panelText()).includes("4 of 4 charts"), "both finished");
    assert.deepEqual(await tileOrder(), placed, "tiles moved while finishing");
    await click("Close queue");
    await waitFor(() => evaluate('!document.querySelector(".queue-panel")'), "closed after the run");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(await tileOrder(), placed, "tiles jumped when the queue closed");
    await evaluate('document.querySelector(".queue-toggle-btn").click()');
    await waitFor(() => evaluate('Boolean(document.querySelector(".queue-panel"))'), "reopened after the run");
    await click("Clear");
    await waitFor(async () => (await panelText()).includes("No songs yet"), "cleared after the run");
    console.log("order: Generate places the songs, closing leaves them passed");

    // Clear mid-run takes the waiting songs off and leaves the one being charted.
    const queueRows = () => evaluate('document.querySelectorAll(".queue-row-open").length');
    const clearDisabled = () => evaluate(`${buttonNamed("Clear")}.disabled`);
    const [stayer, leaver] = (await tileOrder()).slice(0, 2);
    await pick(stayer);
    await pick(leaver);
    const jobsAtClear = jobs.length;
    await click("Generate 4 charts");
    await expectJobs(jobsAtClear + 1, "first chart for clearing");
    assert.equal(await queueRows(), 2);
    await click("Clear");
    await waitFor(async () => (await queueRows()) === 1, "waiting song cleared");
    assert.equal(await clearDisabled(), true, "the song being charted can't be cleared");
    assert.equal((await panelText()).includes(stayer), true, "the song being charted stayed");

    // Stop on a project showing the run stops the queue instead of moving on.
    await evaluate('document.querySelector(".queue-row-open").click()');
    await waitFor(() => hasButton("Stop"), "project shows the run");
    await click("Stop");
    await waitFor(() => hasButton("Generate chart"), "project idle after Stop");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(jobs.length, jobsAtClear + 1, "the queue moved on after Stop");
    await evaluate('document.querySelector(".rail-item[title=Library]").click()');
    await waitFor(() => evaluate('Boolean(document.querySelector(".queue-panel"))'), "library after Stop");
    await waitFor(async () => !(await clearDisabled()), "Clear back after Stop");
    await click("Clear");
    await waitFor(async () => (await panelText()).includes("No songs yet"), "cleared after Stop");
    console.log("clear and stop: running song stays, Stop on its project stops the queue passed");

    await pick("Alpha");
    await waitFor(() => hasButton("Generate 2 charts"), "Alpha waiting");

    // The queue comes back after a restart, waiting to be started.
    await win.webContents.reload();
    await waitFor(() => evaluate('Boolean(document.querySelector(".queue-panel"))'), "queue reopened after restart");
    await waitFor(() => hasButton("Generate 2 charts"), "waiting songs restored");
    assert.ok((await panelText()).includes("Alpha"), "restored queue lost a song");
    assert.equal(jobs.length, 17, "restart started a job by itself");
    console.log("restore: queue waits after a restart passed");

    assert.deepEqual(errors, [], "renderer errors");
    console.log("generation queue: picking, sequence, lanes, stop, final chart, save, export, recovery, drop, open project and restore passed");
  } finally {
    win?.destroy();
    testWindow = null;
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

app.on("window-all-closed", () => {});
app.whenReady().then(main).then(() => app.quit()).catch((error) => {
  console.error(error);
  app.exit(1);
});
