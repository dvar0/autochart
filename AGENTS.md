# AGENTS.md

## Commands

- `npm run dev` — Vite dev server on :5173 (browser mode: folder import works through the picker and persists in IndexedDB; generation and native export require Electron)
- `npm run electron:dev` — Vite + Electron concurrently; the real app
- `npm run build` — production build to `dist/`
- `npm run ffmpeg:prepare` — build the bundled audio/video LGPL FFmpeg and its matching source archive (native C build tools required; packaging prepares it automatically)
- `npm run test:video-preview` — Electron video conversion, thumbnail, seek and saved-background regression harness using the synthetic MPEG-4/AAC fixture; optionally pass `-- /absolute/path/to/video.mp4` for another conversion-required video
- `npm run release:verify` — release gate: dependency audit, package contents, runtime artifacts, source licenses, path safety, media persistence, direct engine/WebGPU parity, and packaged generation smoke checks
- `npm run release:stage -- /new/output /linux/artifacts /windows/artifacts /mac/artifacts` — verify completed native artifacts and stage six public downloads with exact sources/notices in one ZIP; `npm run test:release-staging` checks this consolidation
- `npm run smoke:generate -- --wipe` — clean-install generation smoke test (downloads the chart generation package, generates from `fixtures/demo/`, asserts streamed `partial_chart` note lines)
- `npm run test:installer` / `test:ffmpeg-source` — asset-installer and FFmpeg Corresponding Source security harnesses
- `npm run test:v010:frontend` / `test:v010:backend` — v0.1.0 UI and backend regression contracts
- `npm run test:source-chart-timing` / `test:source-chart-stage` — imported-sync beat-grid math and real timing-stage/cache regression checks
- `npm run test:imported-final-chart` — imported difficulty preservation, final-chart assembly, and durable slot-save checks
- `npm run test:clone-hero-export` — real export/media compatibility checks using the bundled FFmpeg; see `docs/clone-hero-compatibility.md` for the audit and in-game checklist
- `npm run test:yarg-export` — real YARG v0.15.0 scanner/chart-loader integration (requires .NET 10 and `AUTOCHART_YARG_CORE_PATH`); see `docs/yarg-compatibility.md`
- `npm run test:generation-navigation` — Electron navigation, renderer-reload, and durable take-save regression harness
- `npm run test:library-folder-prompt` — Electron songs-folder prompt harness: Save to Clone Hero / YARG from Library and Generate with no folder set, picker outcomes, and keyboard focus
- `npm run test:release-smoke` — sender-bound Electron preload/release-smoke probe with hermetic path-boundary checks
- `npm run artifact:check` / `runtime:verify` — packaged-file allowlist and bundled-runtime verification
- `npm run dist:linux` / `dist:mac` / `dist:win` — packaged builds via electron-builder (build on the OS you are targeting; FFmpeg source inputs and Node runtime bytes are pinned for each supported target)

No conventional test framework, linter, or formatter is configured. Custom Node harnesses live in `scripts/`, with engine gates in `engine/test/`; `npm run release:verify` orchestrates them and must run the direct ONNX smoke, WebGPU parity, and transcriber CFG gates before a release.

## Architecture

- **`src/`** — React 18 SPA (JSX, no TypeScript, no router). Page state is manual (`useState` in `App.jsx`). In Electron, `src/services/` talks to the main process through the preload bridge (`window.autochart`); in a plain browser it uses IndexedDB/localStorage-backed preview storage for UI development, without chart generation or native filesystem export.
- **`src/data/difficultyMetadata.js`** — shared difficulty metadata used by library and generation surfaces.
- **`electron/`** — CommonJS (`.cjs`). Entry: `electron/main.cjs`. `electron/hostContext.cjs` is the settings/library context factory. Loads the Vite dev server in dev, `dist/index.html` in production.
- **`engine/`** — versioned chart-generation engine pack contract. `engine/manifest.json` advertises generators; `electron/engineManager.cjs` runs jobs via the job/result/event JSON contract and loads results.
- **`engine/lib/chartTiming.cjs`** — `.chart` tempo-map reading: the imported-chart-sync beat grid and the generated-chart timing stats.
- **`engine/lib/onnx/`** — the fully-local ONNX pipeline (the only generator, `autochart.fretformer.v1-onnx`): Demucs separation → Beat This detection + timing smoother → transcriber (encoder + autoregressive CFG decoder) → `.chart`, all on **onnxruntime-node**, with no Python runtime. Modules: `sessionLoader.cjs`, `demucsSeparate.cjs`, `beatDetect.cjs`, `buildBeatMel.cjs`, `transcribe.cjs`, `chartEventStream.cjs`, `prefixTables.cjs`. In development, graphs in `engine/models-onnx/fretformer-v1/` may be symlinks; installed apps load the same files from `settings.modelsFolder/fretformer-v1/`. See `docs/engine-integration.md`.

## Key conventions

- No CSS framework — plain `src/styles.css` with `data-theme` attribute for theming.
- No component library — all UI is hand-rolled in `src/components/`.
- `package.json` uses `"type": "module"` so JS files are ESM by default, but Electron and engine files are `.cjs`.
- On-demand generation goes through the engine contract (`engine/manifest.json`, job JSON, result JSON), never direct calls from React into engine internals.
- **ONNX/WebGPU fallback:** WebGPU is attempted only through a standalone Node runtime that can initialize Dawn. If no adapter is available or provider initialization fails, the job reports the fallback and reruns on CPU; Electron-run-as-node is CPU-only.
- See `docs/engine-integration.md` before changing generation behavior.
- YARG venue authoring is maintained in a separate project. Make venue edits in the standalone venue repository; venue sources are outside this repository's scope.
