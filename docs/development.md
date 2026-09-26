# Developing Autochart

Autochart is a React 18 application hosted by Electron, with a local Node/ONNX
generation engine. Source files use JSX and plain CSS; Electron and engine
modules use CommonJS (`.cjs`). See [AGENTS.md](../AGENTS.md) for the repository
map and regression commands.

## Start the desktop app

Use Node 24.19.0 to match the release workflow and a compatible npm version.
Install the [native FFmpeg build prerequisites](ffmpeg-source-status.md) for
your OS, then run:

```bash
npm ci
npm run ffmpeg:prepare
npm run electron:dev
```

The setup wizard downloads the pinned public model package. No model checkout,
Python runtime, account, or private download server is required. Model files
are excluded from the source repository. The app locates installed models in
the storage folder selected during setup.

Development launches can use your ordinary Autochart profile. To keep testing
separate, set `AUTOCHART_USER_DATA` to a dedicated test directory and select
separate project, model, and cache storage during setup. Do not point cleanup
or wipe commands at your real projects or game song library.

The [engine integration guide](engine-integration.md) describes the job/result
contract, model installation, GPU providers, timing, and cache behavior. Read it
before changing generation.

## Browser preview

```bash
npm run dev
```

Open `http://localhost:5173`. Browser mode imports folders through a picker and
stores projects in IndexedDB and settings in localStorage. Generation and native
filesystem export require Electron. Fonts are bundled through `@fontsource`.

## Useful checks

```bash
npm run build
npm run test:v010:frontend
npm run test:v010:backend
npm run test:release-docs
```

There is no conventional test framework, linter, or formatter configured.
Custom harnesses live in `scripts/` and `engine/test/`. Run the checks relevant
to your change; [CONTRIBUTING.md](../CONTRIBUTING.md) gives examples.

For an isolated model-install and generation smoke test:

```bash
npm run smoke:generate -- --wipe
```

The smoke uses the original procedural audio under `fixtures/demo/` and requires
note-bearing `partial_chart` events. It does not establish musical quality.

## Build a package

Build on the operating system you are targeting:

```bash
npm run dist:linux
# Or, on the matching native system:
npm run dist:win
npm run dist:mac
```

Packaging prepares the pinned FFmpeg build and standalone Node runtime.
`AUTOCHART_FFMPEG_PATH` overrides FFmpeg for development or diagnostics.
See [FFmpeg build instructions](ffmpeg-source-status.md).

`npm run release:verify -- --clean-install` runs the unified native release
gate using isolated scratch storage. It checks dependencies, security/path
boundaries, UI/media behavior, direct engine and WebGPU parity, packaged
generation, source integrity, and checksums. It can take substantial time and
rejects stale release output; preserve earlier artifacts before starting.

Public builds additionally require a clean commit tagged with the exact package
version and `--public-release`. Follow the [release checklist](release-checklist.md)
and [publication instructions](github-release.md). The verifier builds artifacts;
it does not publish a GitHub Release.
