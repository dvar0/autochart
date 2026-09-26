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
symlinks. Installed apps load the same layout from:

```text
<settings.modelsFolder>/fretformer-v1/
```

The shipped catalog component `fretformer-v1-onnx` and pack `standard-onnx`
pin 11 model artifacts and four attribution/license files by canonical path,
byte size, and SHA-256. Model artifacts come from the configured asset host;
the four invariant legal files are copied from the packaged
`engine/licenses/` directory. `electron/modelManager.cjs` hashes the actual
installed bytes at that location, and the engine receives it as
`job.engine.modelsFolder`; both use the same folder before falling back to
development symlinks.

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
  damped smoother, and derives tempo anchors from the detected grid. It is the
  default for projects created from bare audio.
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
  grid. `engine/lib/chartTiming.cjs` holds the tempo-map math and
  `npm run test:source-chart-timing` gates it.

A project that ships an imported `notes.chart` defaults to `source_chart_sync`,
so importing a song reuses its human sync track unless the detector is changed;
that choice is then remembered with the project's saved generation settings.

## Setup and hardware

Setup downloads `standard-onnx` from the configured asset source, but trusts
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
