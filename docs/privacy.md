# Privacy

Autochart is local-first. It does not include telemetry, analytics, crash reporting, advertising, or a cloud generation service.

## What stays on this computer

- Imported songs, audio, chart files, project manifests, album art, and background media stay in the selected project/library storage.
- Generated charts and chart-generation metadata stay in the project record.
- Reusable audio analysis, separated stems, and model/runtime files stay in the app-owned folders shown in Settings.
- Browser mode stores imported projects in IndexedDB and settings in `localStorage`. It cannot run chart generation or native filesystem export.

## Network access

Network access is limited to downloading the chart generation package files named by Autochart's shipped, pinned catalog from the package source configured by the user or release configuration. The catalog itself ships with Autochart; setup does not fetch or trust a remote catalog. Autochart does not upload songs, project files, charts, media, diagnostics, or identifiers. After the package is installed, generation runs against local model/runtime files.

The default package source is the public Autochart model repository on Hugging
Face, pinned to a fixed commit. Downloads do not require a Hugging Face account
or token. Like any download host, Hugging Face and its delivery infrastructure
receive the connection's IP address and requested file URLs.

A release may bundle the package instead of downloading it; that does not add a new service or data collection path.

## Local processing

FFmpeg, ONNX Runtime, and the chart-generation engine process media locally for import, preview, analysis, generation, and export. GPU providers are local execution backends; CPU fallback is local as well.

## User control

Settings lets users choose project, model, cache, and export folders and clear the app-owned cache. Deleting a project affects only the selected project storage (or moves the native project directory to the operating system Trash). Autochart does not scan unrelated folders or transmit their contents.
