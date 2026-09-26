"use strict";

// Defaults to the synthetic MPEG-4/AAC conversion fixture through the Node runner.
// An explicit input must be visibly nonblank, at least 7 seconds, with playable
// audio and a video codec that this Electron build cannot decode directly.
const assert = require("assert/strict");
const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { execFileSync } = require("child_process");
const { app } = require("electron");
const esbuild = require("esbuild");
const libraryStore = require("../electron/libraryStore.cjs");
const videoPreviews = require("../electron/videoPreview.cjs");
const { prepareVideoPreview } = videoPreviews;
const { MEDIA_SCHEME, mediaAssetUrl } = require("../electron/mediaProtocol.cjs");
const { resolveFfmpegPath } = require("../electron/ffmpegPath.cjs");
const { lstatRegular } = require("../electron/fileSafety.cjs");

// Keep the real conversion/IPC path, but hold its reply to prove that import,
// source replacement, and playback readiness do not await video completion.
let releasePreview;
let previewGate = new Promise((resolve) => { releasePreview = resolve; });
let previewRequests = 0;
const pendingPreviews = new Set();
videoPreviews.prepareVideoPreview = (...args) => {
  previewRequests += 1;
  const gate = previewGate;
  const task = (async () => {
    const url = await prepareVideoPreview(...args);
    if (gate) await gate;
    return url;
  })();
  pendingPreviews.add(task);
  task.finally(() => pendingPreviews.delete(task)).catch(() => {});
  return task;
};

// Boot the production main process with isolated settings/storage. Duplicating
// its IPC handlers here misses integration errors such as undefined settings
// helpers, even when transcoding and the renderer work in isolation.
const root = process.env.AUTOCHART_VIDEO_TEST_ROOT || fsSync.mkdtempSync(path.join(os.tmpdir(), "autochart-video-preview-"));
process.env.AUTOCHART_RELEASE_SMOKE = "1";
process.env.AUTOCHART_RELEASE_SMOKE_ROOT = root;
process.env.AUTOCHART_USER_DATA = path.join(root, "user-data");
process.env.VITE_DEV_SERVER_URL = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
const loadedWindow = new Promise((resolve) => app.once("browser-window-created", (_event, win) => {
  win.webContents.on("render-process-gone", (_event, details) => { console.error("Renderer exited", details); app.exit(1); });
  win.webContents.once("did-finish-load", () => resolve(win));
}));
require("../electron/main.cjs");

async function main() {
  const input = process.argv[2];
  assert(input, "Pass a video path to test compatibility conversion and decoded frames.");
  const file = await fs.realpath(input);
  let win;
  try {
    win = await loadedWindow;
    win.webContents.on("console-message", ({ level, message }) => {
      if (level === "error") console.error("video test renderer:", message);
    });
    win.webContents.setBackgroundThrottling(false);
    const settings = await win.webContents.executeJavaScript("window.autochart.settings.get()");
    const context = { userDataPath: path.join(root, "user-data"), projectsFolder: settings.projectsFolder };
    const cache = settings.cacheFolder;
    assert(path.relative(root, cache) && !path.relative(root, cache).startsWith(".."), "Cache must remain inside the isolated test root.");
    for (const [entry, globalName] of [["videoPreview", "VideoPreview"], ["mediaMetadata", "MediaMetadata"]]) {
      const result = await esbuild.build({
        entryPoints: [path.join(__dirname, "..", "src", "services", `${entry}.js`)],
        bundle: true, format: "iife", globalName, write: false,
      });
      await win.webContents.executeJavaScript(`${result.outputFiles[0].text}\nvoid 0;`);
    }
    await win.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<input type="file" id="video-file">');`);
    win.webContents.debugger.attach("1.3");
    const { root: documentRoot } = await win.webContents.debugger.sendCommand("DOM.getDocument");
    const { nodeId } = await win.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: documentRoot.nodeId, selector: "#video-file" });
    await win.webContents.debugger.sendCommand("DOM.setFileInputFiles", { nodeId, files: [file] });
    win.webContents.debugger.detach();

    const nativeInput = await win.webContents.executeJavaScript(`(async () => {
      const original = URL.createObjectURL(document.querySelector('#video-file').files[0]);
      try { return await VideoPreview.canDecodeVideo(original); }
      finally { URL.revokeObjectURL(original); }
    })()`);
    assert.equal(nativeInput, false, "This fixture plays natively; use a video requiring compatibility conversion (the default MPEG-4/AAC fixture is provided).");

    const ui = await esbuild.build({
      absWorkingDir: path.join(__dirname, ".."),
      stdin: { resolveDir: path.join(__dirname, ".."), loader: "jsx", contents: `
        import React, { useEffect, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import useGenerateProject from './src/pages/generate/useGenerateProject.js';
        import HighwayPreview from './src/highway/HighwayPreview.jsx';
        import JoinedHighwayCompare from './src/highway/JoinedHighwayCompare.jsx';
        import { parseChart } from './src/lib/chart/parseChart.js';
        import { buildPlayableTrack } from './src/lib/chart/tempoMap.js';
        import { recordToImported } from './src/services/songLibrary.js';
        import { resolveVideoBackground } from './src/services/videoPreview.js';
        const text = '[Song]\\n{\\n Resolution = 192\\n}\\n[SyncTrack]\\n{\\n 0 = B 120000\\n}\\n[ExpertSingle]\\n{\\n 0 = N 0 0\\n 7680 = N 1 0\\n}';
        const track = buildPlayableTrack(parseChart(text), 'expert');
        function Harness() {
          const [imported, setImported] = useState(null);
          const [audio, setAudio] = useState(null);
          const project = useGenerateProject({ importedSong: imported, onGeneratedSong: setImported, visible: false });
          window.videoTest = { project, setImported, setAudio, recordToImported, resolveVideoBackground };
          useEffect(() => { window.videoTestMounted = true; }, []);
          return <div>
            <HighwayPreview ref={ref => { window.singlePreview = ref; }} track={track} visualOnly followTime={7} videoOffset={2} background={project.background} />
            <JoinedHighwayCompare ref={ref => { window.joinedPreview = ref; }} charts={[{ id: 'test', track }]} audioBuffer={audio} videoOffset={2} background={project.background} />
          </div>;
        }
        const host = document.createElement('div'); host.id = 'video-test'; document.body.appendChild(host);
        window.videoTestRoot = createRoot(host); window.videoTestRoot.render(<Harness />);
      ` },
      bundle: true, format: "iife", jsx: "automatic", write: false,
      alias: { "@autochart/chart-writer": path.join(__dirname, "..", "shared", "chartWriter.cjs") },
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    });
    await win.webContents.executeJavaScript(`${ui.outputFiles[0].text}\nvoid 0;`);
    const evaluate = (code) => win.webContents.executeJavaScript(code);
    const waitFor = async (predicate, label, timeout = 10000) => {
      const end = Date.now() + timeout;
      while (!await predicate()) {
        if (Date.now() > end) throw new Error(`Timed out: ${label}\n${await evaluate('JSON.stringify({ status: window.videoTest?.project.statusMsg, source: window.videoTest?.project.sourceAudioName, busy: window.videoTest?.project.busy })')}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await waitFor(() => evaluate('Boolean(window.videoTestMounted)'), 'project hook mounted');
    const importMs = await evaluate(`(async () => {
      const start = performance.now();
      await Promise.race([
        window.videoTest.project.handleMediaFile(document.querySelector('#video-file').files[0]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Import waited for video conversion')), 3000)),
      ]);
      return performance.now() - start;
    })()`);
    await waitFor(() => evaluate('window.videoTest.project.hasMedia && !window.videoTest.project.busy'), 'source ready while conversion is held');
    await waitFor(() => previewRequests > 0, 'background conversion started');
    assert.equal(previewRequests, 1, 'Thumbnail and both players must share one preview request.');
    assert.equal(await evaluate("document.querySelectorAll('#video-test .video-preview-status').length"), 2);
    const rawAudio = await evaluate("document.querySelector('#video-file').files[0].arrayBuffer().then(buffer => { window.videoTest.setAudio(buffer); return true; })");
    assert(rawAudio);
    await waitFor(() => evaluate('Boolean(window.joinedPreview?.isReady())'), 'audio ready before video');
    await evaluate('window.joinedPreview.seek(7); window.singlePreview.seek(7);');
    releasePreview();
    previewGate = null;
    await waitFor(() => evaluate("document.querySelectorAll('#video-test video.bg-layer').length === 2"), 'late video attached to both players', 60000);
    await waitFor(() => evaluate("[...document.querySelectorAll('#video-test video.bg-layer')].every(v => v.readyState >= 2 && Math.abs(v.currentTime - 5) < 0.1)"), 'late video respects paused transport and offset');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#video-test video.bg-layer')].map(v => getComputedStyle(v).objectFit)"), ['contain', 'contain']);
    await waitFor(() => evaluate('Boolean(window.videoTest.project.albumUrl)'), 'asynchronous cover extracted');
    console.log('video preview: import returned before conversion', { importMs: Math.round(importMs), previewRequests, fit: 'contain', lateSeek: 'passed' });

    console.log("video preview: testing selected-file decoder and thumbnail");

    const selected = await win.webContents.executeJavaScript(`(async () => {
      const file = document.querySelector('#video-file').files[0];
      const original = URL.createObjectURL(file);
      const native = await VideoPreview.canDecodeVideo(original);
      URL.revokeObjectURL(original);
      const url = await VideoPreview.createVideoFileUrl(file);
      const metadata = await MediaMetadata.readMediaFileMetadata(file, { videoUrl: url });
      window.previewUrl = url;
      return { native, url, thumbnailBytes: metadata.albumBlob?.size || 0 };
    })()`);
    console.log("video preview: selected-file result", selected);
    assert(selected.thumbnailBytes > 0, "Import must produce a video thumbnail.");
    if (!selected.native) assert(selected.url.startsWith(`${MEDIA_SCHEME}://preview/`));

    // Verify real seek/decode output, not simply a successful conversion exit.
    const frame = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const timer = setTimeout(() => reject(new Error('Video seek timed out')), 15000);
      video.crossOrigin = 'anonymous'; video.muted = true;
      video.onloadedmetadata = () => { video.currentTime = Math.min(2, video.duration / 2); };
      video.onerror = () => reject(new Error(video.error?.message || 'Video decode failed'));
      video.onseeked = () => {
        const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
        const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 64, 64);
        const pixels = ctx.getImageData(0, 0, 64, 64).data;
        let max = 0, min = 255;
        for (let i = 0; i < pixels.length; i += 4) {
          max = Math.max(max, pixels[i], pixels[i+1], pixels[i+2]);
          min = Math.min(min, pixels[i], pixels[i+1], pixels[i+2]);
        }
        clearTimeout(timer);
        resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration, range: max-min });
        video.removeAttribute('src'); video.load();
      };
      video.src = window.previewUrl;
    })`);
    assert(frame.width > 0 && frame.height > 0 && frame.range > 10, "Decoded preview must contain a nonblank frame.");
    console.log("video preview: decoded frame and seek passed", frame);

    // Persist the original via the same capability path used by the renderer.
    const record = {
      record: { id: "video-regression", meta: { title: "Video regression" }, chart: { text: "[Song]\n{\n  Resolution = 192\n}\n" }, assets: {} },
    };
    const saved = await win.webContents.executeJavaScript(`(async () => {
      const file = document.querySelector('#video-file').files[0];
      const capability = await window.autochart.files.registerLibraryAsset(file, 'background-video');
      return window.autochart.library.saveSong({
        ...${JSON.stringify(record)},
        assets: { background: { type: 'video', name: file.name, mime: file.type, source: { kind: 'selected-file', token: capability.token } } },
      });
    })()`);
    const source = await libraryStore.getMediaAssetSource(context, saved.id, saved.assets.background.file, "background-video");
    const [url, duplicate] = await Promise.all([prepareVideoPreview(source, cache), prepareVideoPreview(source, cache)]);
    assert.equal(url, duplicate, "Concurrent requests must reuse one conversion.");
    assert.equal(await prepareVideoPreview(source, cache), url, "Reopening must reuse the cached conversion.");
    console.log("video preview: saved source and conversion cache passed");
    const persisted = await win.webContents.executeJavaScript(`VideoPreview.playableVideoUrl(
      ${JSON.stringify(mediaAssetUrl(saved.id, saved.assets.background.file))},
      async () => (${JSON.stringify({ kind: "project-asset", projectId: saved.id, fileName: saved.assets.background.file })})
    )`);
    assert(await win.webContents.executeJavaScript(`VideoPreview.canDecodeVideo(${JSON.stringify(persisted)})`));
    console.log("video preview: saved project decoder passed");
    const range = await win.webContents.executeJavaScript(`(async () => {
      const response = await fetch(${JSON.stringify(url)}, { headers: { Range: 'bytes=0-15' } });
      return { status: response.status, type: response.headers.get('content-type'), length: (await response.arrayBuffer()).byteLength };
    })()`);
    assert.deepEqual(range, { status: 206, type: "video/webm", length: 16 });
    const unknown = await win.webContents.executeJavaScript(`fetch('${MEDIA_SCHEME}://preview/${"0".repeat(64)}').then(r => r.status)`);
    assert.equal(unknown, 404);
    assert.equal((await fs.stat(file)).size, source.size, "Original file must remain intact.");
    console.log("video preview: byte ranges and original preservation passed");

    previewGate = new Promise((resolve) => { releasePreview = resolve; });
    await evaluate(`(async () => {
      const payload = await Promise.race([
        window.videoTest.recordToImported(${JSON.stringify(saved)}, { audioBuffer: new ArrayBuffer(1) }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Project loading waited for video')), 3000)),
      ]);
      window.videoTest.setImported(payload);
    })()`);
    await waitFor(() => evaluate("document.querySelectorAll('#video-test .video-preview-status').length === 2"), 'saved project opens with video pending');
    await evaluate('window.savedBackgroundReady = window.videoTest.resolveVideoBackground(window.videoTest.project.background); void 0;');
    console.log("video preview: saved project opened before conversion completed");
    const replacementMs = await evaluate(`(async () => {
      const start = performance.now();
      await Promise.race([
        window.videoTest.project.handleMediaFile(document.querySelector('#video-file').files[0]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Source replacement waited for video')), 3000)),
      ]);
      return performance.now() - start;
    })()`);
    await waitFor(() => evaluate(`window.videoTest.project.songId !== ${JSON.stringify(saved.id)} && !window.videoTest.project.busy`), 'replacement source ready before video');
    await evaluate('window.replacementBackgroundReady = window.videoTest.resolveVideoBackground(window.videoTest.project.background); void 0;');
    console.log("video preview: replacement source opened before conversion completed");
    await evaluate(`(() => {
      const image = new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='), c => c.charCodeAt(0))], 'replacement.png', {type: 'image/png'});
      window.videoTest.project.pickBackground('image')({target: {files: [image], value: ''}});
    })()`);
    await waitFor(() => evaluate("document.querySelectorAll('#video-test img.bg-layer').length === 2"), 'image replaces pending video');
    console.log("video preview: image replaced pending video");
    releasePreview();
    previewGate = null;
    await Promise.all([...pendingPreviews]);
    console.log("video preview: pending conversions drained");
    // Await the same renderer promises as the preview consumers, then let React
    // process their completion. Hidden/occluded Windows windows may never paint,
    // so requestAnimationFrame is not a valid completion barrier here.
    await evaluate(`Promise.all([window.savedBackgroundReady, window.replacementBackgroundReady])
      .then(() => new Promise(resolve => setTimeout(() => setTimeout(resolve, 0), 0)))`);
    assert.equal(await evaluate("document.querySelectorAll('#video-test video.bg-layer').length"), 0, 'Late video must not overwrite the new background.');
    assert.equal(await evaluate("document.querySelectorAll('#video-test img.bg-layer').length"), 2, 'Both players must retain the replacement image.');
    console.log('video preview: saved project, source replacement, and stale completion passed', { replacementMs: Math.round(replacementMs) });

    // Video extensions do not guarantee a video stream. Exercise the real IPC,
    // both highway consumers, and cover extraction with an audio-only WebM.
    const audioOnly = path.join(root, "audio-only.webm");
    execFileSync(resolveFfmpegPath(), ["-nostdin", "-v", "error", "-i", file, "-map", "0:a:0", "-c:a", "libvorbis", "-vn", audioOnly]);
    const cacheBefore = (await fs.readdir(path.join(cache, "video-previews"))).sort();
    win.webContents.debugger.attach("1.3");
    const { root: audioDocument } = await win.webContents.debugger.sendCommand("DOM.getDocument");
    const { nodeId: audioNode } = await win.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: audioDocument.nodeId, selector: "#video-file" });
    await win.webContents.debugger.sendCommand("DOM.setFileInputFiles", { nodeId: audioNode, files: [audioOnly] });
    win.webContents.debugger.detach();
    assert.equal(await evaluate("VideoPreview.createVideoFileUrl(document.querySelector('#video-file').files[0])"), null);
    await evaluate("window.videoTest.project.handleMediaFile(document.querySelector('#video-file').files[0])");
    await waitFor(() => evaluate("document.querySelectorAll('#video-test .video-preview-status').length === 2 && [...document.querySelectorAll('#video-test .video-preview-status')].every(el => el.textContent === 'This file has no video track. Audio is ready.')"), 'audio-only fallback in both players');
    assert.equal(await evaluate("document.querySelectorAll('#video-test video.bg-layer').length"), 0);
    assert.equal(await evaluate("Boolean(window.videoTest.project.albumUrl)"), false, 'Audio-only media must not create a video thumbnail.');
    await evaluate("document.querySelector('#video-file').files[0].arrayBuffer().then(buffer => window.videoTest.setAudio(buffer))");
    await waitFor(() => evaluate('Boolean(window.joinedPreview?.isReady())'), 'audio-only playback ready');
    assert.deepEqual((await fs.readdir(path.join(cache, "video-previews"))).sort(), cacheBefore, 'Audio-only media must not leave preview files behind.');

    const invalid = path.join(root, "invalid.webm");
    await fs.writeFile(invalid, "This is not media");
    const invalidSource = await lstatRegular(invalid, "Video source");
    await assert.rejects(prepareVideoPreview({ path: invalid, ...invalidSource.identity }, cache), /Could not prepare a compatible video preview/);
    console.log('video preview: audio-only fallback, playback, absent thumbnail, cleanup, and corrupt-file errors passed');
    console.log("video preview electron:", { ...selected, ...frame, handlers: "production main.cjs", persisted: "playable", streaming: "passed" });
  } finally {
    releasePreview();
    await Promise.allSettled([...pendingPreviews]);
    app.removeAllListeners("window-all-closed");
    app.on("window-all-closed", () => {});
    win?.destroy();
    // Chromium's Windows database handles are released only after app exit.
    // The Node runner owns cleanup; standalone runs retain diagnostic files.
    if (!process.env.AUTOCHART_VIDEO_TEST_ROOT) console.log(`Video test profile retained: ${root}`);
  }
}

const deadline = setTimeout(() => { console.error("Video preview harness timed out"); app.exit(1); }, 180000);
app.on("window-all-closed", () => {});
app.whenReady().then(main).then(() => { clearTimeout(deadline); app.quit(); }).catch((error) => {
  console.error(error);
  app.exit(1);
});
