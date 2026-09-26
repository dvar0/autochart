// Real React + Web Audio regressions for EOF and live-generation completion.
// Run with: npx electron scripts/test-highway-playback-electron.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { build } = require('esbuild');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Let main's cleanup finish and report failures before exiting.
app.on('window-all-closed', () => {});

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autochart-playback-'));
  let win;
  try {
    await build({
      stdin: {
        contents: `
          import React, { useRef, useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import HighwayPreview from './src/highway/HighwayPreview.jsx';
          import JoinedHighwayCompare from './src/highway/JoinedHighwayCompare.jsx';
          import PreviewStage from './src/pages/generate/PreviewStage.jsx';

          // Half a second of PCM silence exercises the real audio clock.
          function makeAudio(seconds = 0.5) {
          const samples = Math.round(seconds * 44100);
          const audioBuffer = new ArrayBuffer(44 + samples * 2);
          const wav = new DataView(audioBuffer);
          const word = (at, value) => [...value].forEach((c, i) => wav.setUint8(at + i, c.charCodeAt(0)));
          word(0, 'RIFF'); wav.setUint32(4, 36 + samples * 2, true);
          word(8, 'WAVE'); word(12, 'fmt '); wav.setUint32(16, 16, true);
          wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
          wav.setUint32(24, 44100, true); wav.setUint32(28, 88200, true);
          wav.setUint16(32, 2, true); wav.setUint16(34, 16, true);
          word(36, 'data'); wav.setUint32(40, samples * 2, true);
          return audioBuffer;
          }
          const audioBuffer = makeAudio();
          window.makeAudio = makeAudio;
          const tracks = [0, 1].map((fret) => ({
            song: { resolution: 192, offset: 0 },
            tempoMap: { tickToSeconds: (tick) => tick / 384 },
            notes: [{ time: 0.2, endTime: 0.2, tick: 77, sustain: 0, frets: [fret] }],
            events: [], starPower: [],
          }));
          window.testTracks = tracks;
          function Preview({ joined }) {
            const ref = useRef(null);
            const [playing, setPlaying] = useState(false);
            const [take, setTake] = useState(0);
            window.preview = ref;
            window.switchTake = () => setTake((value) => 1 - value);
            return <>
              <output id="playing" data-take={take}>{String(playing)}</output>
              {joined ? <>
                <JoinedHighwayCompare ref={ref} charts={[{ id: take, track: tracks[take] }]}
                  audioBuffer={audioBuffer} onPlayingChange={setPlaying} />
                <button className="transport-btn" onClick={() => playing ? ref.current.pause() : ref.current.play()}>
                  {playing ? 'Pause' : 'Play'}
                </button>
              </> : <HighwayPreview ref={ref} track={tracks[take]} audioBuffer={audioBuffer}
                onPlayingChange={setPlaying} />}
            </>;
          }
          // Exercise the actual parent branch that used to unmount the live player.
          const reportPreviewPlaying = (playing) => { window.reportedPlaying = playing; };
          window.autochart = { window: {
            isFullscreen: async () => Boolean(window.fullscreenActive),
            setFullscreen: async (active) => { window.fullscreenActive = active; },
          } };
          function Generation({ first, lead }) {
            const [project, setProject] = useState(() => ({
              showingLiveStage: true, busyAction: 'generating', previewMode: 'single',
              track: first ? null : tracks[0], baseTrack: tracks[0],
              selectedCompareVersions: [], reportPreviewPlaying,
              liveGeneration: { track: tracks[0], committedSeconds: 3 },
              genRun: { live: {}, leadInSeconds: lead, startedAt: Date.now() },
              liveAnalysisAudioBuffer: makeAudio(8 + lead),
              audioBuffer: null, audioLeadInSeconds: 0,
            }));
            window.patchGeneration = (patch) => setProject((current) => ({ ...current, ...patch }));
            return <PreviewStage project={project} />;
          }
          const root = createRoot(document.getElementById('root'));
          window.mountGeneration = (first, lead) => root.render(<Generation key={'generation-' + first + '-' + lead} first={first} lead={lead} />);
          window.mountPreview = (joined) => root.render(<Preview key={String(joined)} joined={joined} />);
        `,
        resolveDir: path.resolve(__dirname, '..'),
        loader: 'jsx',
      },
      alias: { "@autochart/chart-writer": path.resolve(__dirname, "../shared/chartWriter.cjs") },
      bundle: true,
      outfile: path.join(temp, 'app.js'),
      format: 'iife', platform: 'browser', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.DEV': 'true' },
      logLevel: 'silent',
    });
    await fs.copyFile(path.join(__dirname, '../src/styles.css'), path.join(temp, 'app.css'));
    await fs.writeFile(path.join(temp, 'index.html'), '<link rel="stylesheet" href="app.css"><div id="root"></div><script src="app.js"></script>');
    win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    await win.loadFile(path.join(temp, 'index.html'));
    const evaluate = (code) => win.webContents.executeJavaScript(code, true);
    const waitFor = async (code, label) => {
      const deadline = Date.now() + 5000;
      while (!(await evaluate(`Boolean(${code})`))) {
        if (Date.now() > deadline) throw new Error('Timed out: ' + label);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    for (const joined of [false, true]) {
      const label = joined ? 'joined compare' : 'single preview';
      await evaluate(`window.mountPreview(${joined})`);
      await waitFor('window.preview?.current?.isReady()', label + ' ready');
      await evaluate('document.querySelector(".transport-btn").click()');
      await waitFor('document.querySelector("#playing").textContent === "true"', label + ' playing');
      await waitFor('!window.preview.current.isPlaying()', label + ' natural completion');
      await waitFor('document.querySelector(".transport-btn").textContent.trim() === "Play"', label + ' button after completion');
      assert.equal(await evaluate('document.querySelector("#playing").textContent'), 'false', label + ' must notify its parent');

      await evaluate('window.preview.current.seek(0.1); document.querySelector(".transport-btn").click()');
      await waitFor('window.preview.current.isPlaying()', label + ' replay after backward seek');
      await waitFor('document.querySelector("#playing").textContent === "true"', label + ' replay state');
      await waitFor('document.querySelector("#playing").textContent === "false"', label + ' second completion');

      await evaluate('window.switchTake()');
      await waitFor('document.querySelector("#playing").dataset.take === "1"', label + ' take changed');
      await waitFor('window.preview.current.isReady()', label + ' next take ready');
      await evaluate('window.preview.current.seek(0.1); document.querySelector(".transport-btn").click()');
      await waitFor('window.preview.current.isPlaying()', label + ' play after switching takes');
      await waitFor('document.querySelector("#playing").textContent === "true"', label + ' next take playing');
      await waitFor('document.querySelector("#playing").textContent === "false"', label + ' third completion');

      await evaluate('document.querySelector(".transport-btn").click()');
      await waitFor('window.preview.current.isPlaying()', label + ' replay directly from the end');
      await waitFor('document.querySelector("#playing").textContent === "true"', label + ' playing from the end');
      await waitFor('document.querySelector("#playing").textContent === "false"', label + ' replay completion');
    }
    console.log('Single and joined preview end-of-song playback regressions passed');

    for (const [first, lead] of [[true, 0], [false, 2]]) {
      const label = first ? 'first generation' : 'later generation with lead-in';
      await evaluate(`window.mountGeneration(${first}, ${lead})`);
      await waitFor('document.querySelector(".live-play-affordance") && window.__highway.engine.buffer', label + ' live audio');
      await evaluate('document.querySelector(".live-play-affordance").click()');
      await waitFor('window.__highway.engine.running', label + ' playing');
      await evaluate(`window.__highway.engine.seek(${2 + lead}); document.querySelector('[aria-label="Full screen"]').click()`);
      await waitFor('document.querySelector(".preview.is-fullscreen") && window.fullscreenActive', label + ' fullscreen');
      await evaluate(`
        window.savedEngine = window.__highway.engine;
        window.savedCanvas = document.querySelector('canvas.highway-canvas');
        window.beforeCompletion = window.savedEngine.songTime;
        window.patchGeneration({ showingLiveStage: false, busyAction: '', track: window.testTracks[1],
          genRun: null, liveAnalysisAudioBuffer: null, audioBuffer: null, audioLeadInSeconds: ${lead}, activeVideoOffset: ${lead} });
      `);
      await waitFor('document.querySelector(".single-preview")', label + ' saved preview');
      assert.equal(await evaluate('window.__highway.engine === window.savedEngine && document.querySelector("canvas.highway-canvas") === window.savedCanvas'), true, label + ' must retain the transport and canvas');
      assert.equal(await evaluate('window.savedEngine.running && window.savedEngine.songTime >= window.beforeCompletion - 0.05'), true, label + ' continues while saved audio is unavailable');
      assert.equal(await evaluate('Boolean(document.querySelector(".preview.is-fullscreen")) && window.fullscreenActive'), true, label + ' retains fullscreen');

      // A delayed final decode must not stop the existing clock.
      await evaluate(`
        window.releaseDecode = null;
        window.originalDecode = window.savedEngine.decodeAudio.bind(window.savedEngine);
        window.savedEngine.decodeAudio = async (data) => {
          const decoded = await window.originalDecode(data);
          await new Promise((resolve) => { window.releaseDecode = resolve; });
          return decoded;
        };
        window.patchGeneration({ audioBuffer: window.makeAudio(${8 + lead}) });
      `);
      await waitFor('Boolean(window.releaseDecode)', label + ' delayed decode');
      assert.equal(await evaluate('window.savedEngine.running'), true, label + ' plays during decode');
      await evaluate('window.oldBuffer = window.savedEngine.buffer; window.releaseDecode()');
      await waitFor('window.savedEngine.buffer !== window.oldBuffer', label + ' audio installed');
      assert.equal(await evaluate('window.savedEngine.running && window.savedEngine.songTime >= window.beforeCompletion - 0.05'), true, label + ' resumes at the current position');

      // Pause during another pending decode; completion must honor that action.
      await evaluate('window.releaseDecode = null; window.patchGeneration({ audioBuffer: window.makeAudio(12), audioLeadInSeconds: 3, activeVideoOffset: 3 })');
      await waitFor('Boolean(window.releaseDecode)', label + ' next decode');
      await evaluate('document.querySelector(".transport-btn").click(); window.pausedAt = window.savedEngine.songTime; window.oldBuffer = window.savedEngine.buffer; window.releaseDecode()');
      await waitFor('window.savedEngine.buffer !== window.oldBuffer', label + ' paused replacement');
      assert.equal(await evaluate('window.savedEngine.running'), false, label + ' stays paused');
      assert.ok(Math.abs(await evaluate('window.savedEngine.songTime - window.pausedAt') - (3 - lead)) < 0.05, label + ' converts audio lead-in exactly once');

      // Resolve two replacements out of order. The stale decode must not win.
      await evaluate(`
        window.releases = {};
        window.savedEngine.decodeAudio = async (data) => {
          const decoded = await window.originalDecode(data);
          await new Promise((resolve) => { window.releases[decoded.duration] = resolve; });
          return decoded;
        };
        window.patchGeneration({ audioBuffer: window.makeAudio(13) });
      `);
      await waitFor('Boolean(window.releases[13])', label + ' older decode');
      await evaluate('window.patchGeneration({ audioBuffer: window.makeAudio(14) })');
      await waitFor('Boolean(window.releases[14])', label + ' newer decode');
      await evaluate('window.releases[14]()');
      await waitFor('window.savedEngine.duration === 14', label + ' latest buffer');
      await evaluate('window.releases[13]()');
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(await evaluate('window.savedEngine.duration'), 14, label + ' ignores stale decode');

      // EOF during decoding must stay ended, rather than restarting at zero.
      await evaluate('window.savedEngine.seek(13.85); document.querySelector(".transport-btn").click(); window.patchGeneration({ audioBuffer: window.makeAudio(15) })');
      await waitFor('Boolean(window.releases[15])', label + ' EOF decode');
      await waitFor('!window.savedEngine.running', label + ' EOF');
      await evaluate('window.releases[15]()');
      await waitFor('window.savedEngine.duration === 15', label + ' EOF replacement');
      assert.equal(await evaluate('window.savedEngine.running'), false, label + ' does not autoplay after EOF');
      assert.ok(await evaluate('window.savedEngine.songTime') >= 14, label + ' retains end position');
    }
    // Pausing the live chart is distinct from returning to silent chase mode.
    for (const interactive of [true, false]) {
      await evaluate(`window.mountGeneration(${interactive}, 4)`);
      await waitFor('document.querySelector(".live-play-affordance") && window.__highway.engine.buffer', 'paused/follow live audio');
      if (interactive) {
        await evaluate('document.querySelector(".live-play-affordance").click()');
        await waitFor('window.__highway.engine.running', 'interactive live playback');
        await evaluate('window.__highway.engine.seek(5); document.querySelector(".transport-btn").click()');
        await waitFor('!window.__highway.engine.running', 'paused live playback');
      } else {
        await waitFor('window.__highway.engine.songTime > 0.1', 'silent chase position');
      }
      const before = await evaluate('window.__highway.engine.songTime');
      await evaluate(`window.patchGeneration({ showingLiveStage: false, busyAction: '',
        track: window.testTracks[1], genRun: null, liveAnalysisAudioBuffer: null,
        audioBuffer: null, audioLeadInSeconds: 4, activeVideoOffset: 4 })`);
      await waitFor('document.querySelector(".single-preview")', 'paused/follow final chart');
      assert.equal(await evaluate('window.__highway.engine.running'), false, 'completion must not autoplay a paused or silent preview');
      assert.ok(Math.abs(await evaluate('window.__highway.engine.songTime') - (interactive ? before : 0)) < 0.05,
        interactive ? 'paused live playhead survives completion' : 'silent chase ends with final chart at the beginning');
    }
    console.log('Live-generation completion, fullscreen, delayed audio, lead-in, pause, stale decode, and EOF regressions passed');

    // A confirmed missing padded cache must not leave the previous take's
    // audio playing underneath a chart that needs a different audio timeline.
    await evaluate(`window.patchGeneration({ audioBuffer: window.makeAudio(12) })`);
    await waitFor('window.__highway.engine.duration === 12', 'saved audio ready');
    await evaluate(`document.querySelector('.transport-btn').click()`);
    await waitFor('window.__highway.engine.running', 'saved preview playing');
    await evaluate(`
      window.previousEngine = window.__highway.engine;
      window.patchGeneration({ audioBuffer: null, audioLeadInSeconds: 2,
        previewAudioError: 'The padded audio cache is missing. Regenerate the chart before previewing.' });
    `);
    await waitFor('document.querySelector(".preview-audio-error")', 'missing padded audio message');
    assert.equal(await evaluate('window.previousEngine.running'), false, 'missing audio must stop the previous take');
    assert.equal(await evaluate('Boolean(document.querySelector(".transport-btn"))'), false, 'missing audio must not offer stale playback');
    assert.equal(await evaluate('window.reportedPlaying'), false, 'missing audio must clear the playback report');
    console.log('Missing padded audio stops stale playback and clears the transport');

  } finally {
    win?.destroy();
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

app.whenReady().then(main).then(() => app.exit(0)).catch((error) => {
  console.error(error);
  app.exit(1);
});
