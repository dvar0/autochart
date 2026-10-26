# Autochart Engine Integration

Autochart runs chart generation through a versioned engine pack. The renderer
never calls a model script directly.

```text
Generate page → generation service → Electron IPC → engineManager
              → engine job JSON → ONNX engine → result.json + notes.chart
```

## V1 engine

V1 has one generator: `autochart.fretformer.v1-onnx` (`Fretformer`). It is a
fully local `onnxruntime-node` pipeline with no Python runtime:

```text
audio → Demucs separation → beat detection + smoothing → Fretformer → .chart
```

The implementation is in `engine/lib/onnx/`. It emits normal stage events and
incremental `partial_chart` events while decoding; the final `notes.chart` is
the authoritative output.

The stage modules (`*.mjs`) are ES modules shared with the browser engine. They
reach ONNX Runtime, graph files and `.npz` tables only through the host seam in
`runtime.mjs`: `sessionLoader.cjs` installs an `onnxruntime-node` host for the
desktop, `engine/web/host.mjs` installs an `onnxruntime-web` host (WebGPU, with
the wasm backend as CPU). `pipeline.mjs` holds the stage orchestration both
hosts run (separation, timing, transcription, chart writing), so desktop and
browser charts come from the same code. `resample.mjs` is a port of FFmpeg's
default resampler; the browser decodes with Web Audio at the file's own rate and
resamples with it, which keeps its audio identical to the desktop's FFmpeg path.
Demucs' STFT and inverse STFT are computed in JS with an FFT (`stft.mjs`); only
its core network runs as an ONNX graph. Fretformer v1's folder still lists the
two STFT basis graphs (`demucs_analysis_stft.onnx`, `demucs_synthesis_istft.onnx`)
because its published pack pins them, but the engine no longer loads them and
the browser doesn't download them. The Fretformer 2 folders don't have them.

### Browser engine

`engine/web/` runs the same pipeline in a Web Worker: `audio.mjs` (decode +
resample), `host.mjs` (runtime host, device choice, model manifest over HTTP),
`generate.mjs` (`generateChart`) and `engine.worker.mjs`. The page must be
cross-origin isolated (COOP `same-origin`, COEP `require-corp`) so the wasm
backend can use threads. On WebGPU, charts match the desktop byte for byte. In
`auto` mode the transcriber moves to CPU when a GPU readback takes longer than
20 ms. Firefox polls GPU work about every 100 ms; the readback pump in
`host.mjs` brings that down to a few milliseconds, but per-token decoding still
runs about three times slower than on CPU, so a browser that needed the pump
decodes on CPU. The CPU backend's separation differs
slightly from native CPU, so CPU-only browser charts are valid but not identical
to the desktop's.

`scripts/web-spike/` is the test harness: `build.mjs` bundles the page and
worker, `server.mjs` serves them with the isolation headers plus the model
folder, and `compare.mjs` checks a browser run against a desktop job (chart,
beats, per-stem SDR).

For project-backed jobs, Electron commits the completed take to the project
before returning the generation response. This save is independent of the
renderer page and is deduplicated by job ID. Project writes are serialized;
metadata edits use partial updates so favoriting a project cannot replace a
newly saved take with an older version list. The `project_saved` event refreshes
the library and any idle workspace reopened after a renderer reload.

`npm run test:generation-navigation` exercises repeated Library navigation,
background completion, renderer reload during generation, duplicate completion,
and concurrent favorite updates against the real Electron preload and library
store with deterministic engine responses.

`engine/models-onnx/fretformer-v1/` is a development fallback and may contain
symlinks (each generator names its folder in `generator.models.onnxFolder`).
Installed apps load the same layout from:

```text
<settings.modelsFolder>/fretformer-v1/
```

The shipped catalog pins every model artifact and attribution/license file by
canonical path, byte size, and SHA-256. Component `fretformer-v1-onnx` (pack
`standard-onnx`) pins 11 model artifacts; components `fretformer-2-onnx` and
`fretformer-2-fill-in-onnx` (pack `fretformer-2`, the catalog default) pin 9
and 10. Components may share a path (the license texts) only with identical
pins. The installer copies a file whose pinned bytes are already installed at
another catalog path (models share Beat This and the transcriber mel graph)
instead of downloading it; the copy passes the same size and SHA-256 checks,
and a copy that fails them falls back to the download. Model artifacts come from the configured asset host;
the four invariant legal files are copied from the packaged
`engine/licenses/` directory. `electron/modelManager.cjs` hashes the actual
installed bytes at that location, and the engine receives it as
`job.engine.modelsFolder`; both use the same folder before falling back to
development symlinks.

## Fretformer 2 and Fill-in

`autochart.fretformer.v2-onnx` ("Fretformer 2") and
`autochart.fretformer.v2-inpaint-onnx` ("Fretformer 2 Inpaint", shown as
Fill-in) download together as the `fretformer-2` pack into
`<settings.modelsFolder>/fretformer-v2/` and `fretformer-v2-inpaint/`. Both are
listed on the Generate screen whether or not they are downloaded; new projects
start on the user's default model, else Fretformer 2 when it is downloaded,
else any downloaded model. Settings shows one Download per family
(`src/data/modelFamilies.js` names each family's `packId`). Fill-in is offered
for whole charts only while "Write whole charts" is on. Takes are named and
tagged with their model's label, and a project reopens on the model it last
generated with. Inpaint rewrites picked bars with Fretformer 2 Inpaint
(`capabilities.inpaint`); Generate stays on whichever model is selected.

They use the same pipeline code as Fretformer, with every difference read
from the model folder's `manifest.json`:

- Separation: `htdemucs_6s` (same STFT settings as Fretformer's) with
  piano summed into other (`stages.demucs.stems` / `stemFold`). Their stems
  live in `<separation workspace>/stems_htdemucs_6s/` (`generator.separation`),
  next to Fretformer's `stems/`, and results report every stem set under
  `sourceSeparation.stemSets`. Separation cards list one row per stem set:
  Fretformer's always, the six-stem set once it exists or while a six-stem
  model is selected (with "Not separated yet" and a Separate now button where
  it is missing).
- Features: six mel channels (full, drums, bass, vocals, guitar, other), dB
  reference over those six (`stages.transcriber.channelOrder`, `refOnlyMixes`).
- Knobs: speed, chords, HOPOs, taps, movement (`capabilities.descriptorKnobs`;
  the model vocab must agree). CFG runs only when a knob is set
  (`prefixConditioning.cfgOnlyWithSetKnobs`).
- Decoding matches `ChartTranscriber.generate`: knob tokens are looked up at
  `DESC_BASE + 8k` (`prefixConditioning.descriptorTokenBase`), and sampling
  starts only after the whole prefix (`decode.sampleOnlyAfterPrefix`).
  Fretformer's manifest has neither, so it keeps its original lookup and
  sampling and its seeds reproduce.
- Solo and section markers (`capabilities.structureMarkers`). More settings
  shows Mark solos and Force a solo for these generators. Fretformer does not
  mark solos, so those rows stay disabled.

Gates: `engine/test/generator-switch-e2e.cjs` (Fretformer and Fretformer 2
on one song through `engineManager.generateChart`: shared beat map, stem
sets, CFG gating, solo and section markers, legacy beat-map adoption;
`--only v1 --app-root <checkout>` is the v1 regression check;
`AUTOCHART_E2E_V2_ID` runs the marker steps against another generator),
`scripts/test-generator-picker-electron.cjs` (picker, knob swap, payload).

## Fretformer 2 Lite

`autochart.fretformer.v2-lite-onnx` ("Fretformer 2 Lite", experimental) is an
optional `fretformer-2-lite` pack in `<settings.modelsFolder>/fretformer-v2-lite/`.
Its transcriber reads only the full mix (`stages.transcriber.channelOrder` is
`["full"]`), so the folder has no Demucs graphs and generation skips separation:
`needsStems(manifest)` in `pipeline.mjs` is false, the engine emits the
`demucs` stage as `skipped`, and the result leaves it out of `stages`. The same
folder holds a fill-in decoder, so Lite fills in its own takes without stems.

On the Inpaint tab a take starts on its own family's Fill-in model (Lite takes
on Lite, others on Fretformer 2's), and the model picker switches between them.
Fretformer 2's Fill-in on a Lite take separates first, then caches the stems as
usual. Lite's generator lists the `htdemucs_6s` stem set
(`capabilities.usesStemCache: false`), so the separation cards and Separate now
use Fretformer 2's separation while Lite is selected.

Lite is `"availability": "installed"`, so the Generate picker lists it only
once it's downloaded (or picked in Settings). The app offers it when a device
needs it, not before:

- **Slow separation.** The engine's `demucs` progress events carry
  `audioSeconds`. `src/pages/generate/liteOffer.js` times the segments after
  the first one (which also loads the model) and, once a run's separation is
  projected past twice the song's length (and at least a minute), shows an
  offer under the progress: Switch to Lite stops the run, makes Lite the model
  new projects start with, downloads it if needed, and reruns on it; Keep going
  hides it and saves `liteOfferDeclined`, so it isn't offered again.
- **Browser.** A browser with 2 GB of memory or less, or a phone or tablet
  without graphics card access, lists Lite and starts new projects on it. The
  browser engine downloads only the Demucs graph before separating and the
  rest of the model after it, so a device that switches to Lite hasn't fetched
  Fretformer 2's other files.

Charts with a Lite take end their loading phrase with "(Fretformer 2 Lite)"
(see `docs/chart-metadata.md`).

## Beat maps

Beat maps belong to the analysis audio, not to a separation. Every generator
and separation of the same audio (same file, same lead-in) shares one map per
timing setting at
`<cache>/features/fretformer_timing_v1/<audio sha256>/<timing key>/beats.json`
(`job.timingWorkspace`), so takes from Fretformer, a six-stem model, or a regenerated separation
carry the same `[SyncTrack]` and can share a final chart. Maps written by older
versions under `<separation workspace>/timing/` are adopted on first use: the
active separation's first, then the default separation's, then any other.
Re-running Beat This on the same audio and settings gives the same map, so
the levers that change a beat map are the timing detector, smoothing, and
lead-in silence (which changes the analysis audio).

## Job and result contract

Electron writes jobs under `<settings.cacheFolder>/jobs/<jobId>/job.json`.
The stable fields include:

```json
{
  "schemaVersion": 1,
  "jobId": "…",
  "generatorId": "autochart.fretformer.v1-onnx",
  "audioPath": "/absolute/source.mp3",
  "outputDir": "/absolute/job/output",
  "cacheDir": "/absolute/engine-cache",
  "engine": { "modelsFolder": "/absolute/models" }
}
```

The engine writes `result.json`, `chart/notes.chart`, and
`chart/full_song_report.json` to the output directory. Keep this job/result
shape and the JSON event stream stable when changing the engine.

## Timing detectors

The timing stage produces the beat grid the transcriber is conditioned on and
the `[SyncTrack]` the generated chart ships with. Two detectors exist, chosen by
`generation.resolved.timingDetector`:

- `beat_this_custom_timing` runs Beat This over the audio, optionally through the
  grid smoother (spurious/missed-beat cleanup, folding short double-time bursts
  over 300 BPM back onto the surrounding tempo, short-glitch repair, then an
  edge-preserving local line fit), and derives tempo anchors from the detected
  grid. Tempo anchors are rounded to `bpmRound` with error feedback, so rounding
  never accumulates; where rounding alone would move a beat more than 5 ms (very
  slow tempos across long gaps), the exact tempo is written instead. It is the default for projects created from bare audio.
- `source_chart_sync` reuses the tempo map of an imported `notes.chart` instead
  of detecting one. Electron writes the picked version's chart to
  `<jobDir>/source_chart/notes.chart` and passes `job.sourceChart` with its
  SHA-256; the engine verifies that hash, takes one beat per quarter note from
  the `[SyncTrack]`, places downbeats at measure starts, and emits the source
  tempo and time-signature events verbatim, retaining the source resolution
  and chart offset so imported and generated difficulties can be combined.
  No beat model runs, smoothing and lead-in silence are forced off, and the
  timing cache key includes the source chart hash. A chart with no usable
  `[SyncTrack]` fails the job rather than falling back to detection, so a take
  labeled "Imported chart sync" can never have been charted against a detected
  grid. `engine/lib/chartTiming.mjs` holds the tempo-map math and
  `npm run test:source-chart-timing` gates it.

A project that ships an imported `notes.chart` defaults to `source_chart_sync`,
so importing a song reuses its human sync track unless the detector is changed;
that choice is then remembered with the project's saved generation settings.

## Setup and hardware

Setup downloads the catalog's default pack (`fretformer-2`) from the
configured asset source; Settings can also install `standard-onnx`. It trusts
only the `engine/catalog.json` shipped with that application release. The
default source is the public `Dvaro/autochart-models` Hugging Face repository,
pinned to commit `b38e69ca0dc919cef0218ef7f9c0014a1593b3c2`. Downloads require no
authentication. Override it through setup, Settings, or
`AUTOCHART_ASSETS_BASE_URL` when using a mirror. The source must serve every file at its pinned
path marked `source: "remote"`, with the pinned size and SHA-256; a remote
`catalog.json` cannot add or change downloads. Files marked
`source: "bundled-license"` are copied from the app only after the same pinned
checks. Installer destinations are strict children of the models root,
downloads have bounded redirects/timeouts/bytes, and archives are
application-inspected before staged extraction and promotion. Missing or
corrupt models or license files block Generate and direct the user back to
Setup.

Hardware mode controls the ONNX execution provider: Automatic, CUDA, Core ML,
WebGPU, or CPU. Core ML is available on macOS, while CUDA and WebGPU are
opportunistic. If ONNX Runtime cannot initialize a selected accelerated
provider—for example because cuDNN is unavailable—the session loader latches
the job to CPU instead of failing generation. Automatic requests WebGPU and
falls back to CPU when the provider cannot initialize; Core ML remains an
explicit macOS mode.

On Windows, a bounded, cached display-adapter inventory identifies machines
reporting only Microsoft's software display adapters (such as Hyper-V Video).
These machines use CPU and emit a fallback event instead of running WebGPU
through software graphics. A timed-out, failed, empty, or malformed inventory
also selects CPU for that job and reports why: successful WebGPU initialization
alone does not prove a hardware adapter exists. Valid hardware-only or mixed
hardware/software inventories retain the normal provider probe. Manual CPU mode
avoids this query.

If an accelerated run fails with a hardware-related error, the generation page
offers **Retry using CPU**. It retains the failed run's song and generation
options, starts one new job, and overrides hardware only for that job. It does
not change the saved preference, retry unrelated errors, or offer another CPU
retry after automatic CPU fallback has already failed. The navigation harness
checks successful recovery and duplicate-click protection.

Each engine CLI process owns one job. After awaiting result persistence, it
drains stdout/stderr and exits with the job's status. This avoids a reproduced
ONNX Runtime 1.27.0 cleanup crash after a failed WebGPU adapter request on Linux,
including with the bundled Node 24 runtime. CPU fallback still performs the
full generation and writes a validated result; a failed job exits nonzero.
The workaround applies only to the disposable CLI process. Related upstream
cleanup failures are tracked in [ONNX Runtime #29553](https://github.com/microsoft/onnxruntime/issues/29553).

WebGPU needs a standalone `node` process: Dawn cannot enumerate an adapter under
`ELECTRON_RUN_AS_NODE`. Release builds download a checksummed, target-specific
Node 24 runtime and place it at `resources/node-runtime`; `engineManager.cjs`
prefers `AUTOCHART_NODE_BIN`, then that bundled runtime, then a discovered
system `node`. Hardware probing reports accelerated providers as unverified
until an actual model session initializes or emits a CPU fallback event.

## Cache and verification

Analysis cache is stored under the selected app-owned
`<cache parent>/Autochart Cache/engine` directory; it is generation input, not
disposable UI state. Preserve it or create a new generation variant when
changing timing or separation behavior. Older cache roots remain read-only
during migration and are never cleared as part of the owned cache directory.

For a clean end-to-end gate:

```bash
npm run build
npm run smoke:generate -- --wipe
```

The smoke script downloads the pack, exercises hardware fallback, requires
note-bearing `partial_chart` events, and verifies that the final chart has
notes. Stage logs include the requested and selected execution providers. Generation
is canceled after 15 minutes (asset installation is excluded); use
`--generation-timeout-seconds` for longer custom fixtures. This limit belongs to
the smoke harness and does not limit generation in the app. Its wipe mode creates isolated, marked scratch directories and refuses
to delete pre-existing application or caller-owned paths.
