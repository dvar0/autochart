# Privacy

Autochart is local-first. Your songs, charts and projects never leave your device, in the desktop app or in the browser version. The desktop app has no telemetry, analytics or crash reporting. The browser version counts a few things, such as how many charts are made and what failed, without anything about you or your songs; see [Browser version](#browser-version). Neither has advertising or a cloud generation service.

## What stays on this computer

- Imported songs, audio, chart files, project manifests, album art, and background media stay in the selected project/library storage.
- Generated charts and chart-generation metadata stay in the project record.
- Reusable audio analysis, separated stems, and model/runtime files stay in the app-owned folders shown in Settings.

## Network access

Network access is limited to downloading the chart generation package files named by Autochart's shipped, pinned catalog from the package source configured by the user or release configuration, and to checking for app updates. The catalog itself ships with Autochart; setup does not fetch or trust a remote catalog. Autochart does not upload songs, project files, charts, media, diagnostics, or identifiers. After the package is installed, generation runs against local model/runtime files.

The default package source is the public Autochart model repository on Hugging
Face, pinned to a fixed commit. Downloads do not require a Hugging Face account
or token. Like any download host, Hugging Face and its delivery infrastructure
receive the connection's IP address and requested file URLs. After a model
download finishes, Autochart asks Hugging Face for one more small file
(`meta.yaml`) so the repository's public download count goes up; it sends
nothing else.

Once a day, Autochart downloads a small signed file from the latest GitHub
release to see whether a newer version is out, and the release's picture when
it has one. The request carries nothing
about you, your songs or this computer beyond what any download sends (the
connection's IP address and the requested URL). Turn it off with **Check for
updates** in Settings; the update sheet's **Check now** still checks when you
ask. An update only downloads when you choose **Download update**, and its file
must match the signed checksum before it can install.

A release may bundle the package instead of downloading it; that does not add a new service or data collection path.

## Local processing

FFmpeg, ONNX Runtime, and the chart-generation engine process media locally for import, preview, analysis, generation, and export. GPU providers are local execution backends; CPU fallback is local as well.

## User control

Settings lets users choose project, model, cache, and export folders and clear the app-owned cache. Deleting a project affects only the selected project storage (or moves the native project directory to the operating system Trash). Autochart does not scan unrelated folders or transmit their contents.

## Browser version

The browser version runs the same engine inside the page. The song file you
pick is read in the browser and never uploaded. Models download from Hugging
Face into the browser's storage (with the same one `meta.yaml` request after a
download), separations stay in its private file storage,
and the open song lives in the tab's memory until you export it. Like any
website, the host serving the page (Cloudflare) receives the connection's IP
address and the requested URLs.

### Usage counts

The browser version sends a few counts so we can see what works and what
breaks. Each one is an event and a handful of coarse fields. The server adds
it to a total for that day and keeps nothing else: no single events, no times
of day, no IP addresses, no IDs or cookies, nothing about the song, its file
or its chart.

Every count carries:

- **browser**: chrome, edge, firefox, safari or other (no version)
- **device**: desktop or mobile
- **version**: the Autochart version, such as 0.2.0

The events, and what each one adds:

| Event | Also sends |
| --- | --- |
| A chart started, finished or failed | the model, the difficulty; once it runs, WebGPU or CPU. Finished runs add the time taken and the song's length as ranges (such as 2–5 minutes). Failed runs add the step it failed at and a fixed reason (out of memory, GPU lost, no WebGPU, download failed, file couldn't be decoded, engine crashed, storage full, other) |
| An Inpaint finished or failed | the model, WebGPU or CPU; the time as a range, or the step and reason |
| A run was cut short | generate or Inpaint, the model, the step, and whether the tab was closed or crashed |
| A song was exported | .sng, .zip or a songs folder |
| A model was downloaded | which model |
| Fretformer 2 Lite was offered, taken or declined | nothing else |

Error messages are never sent: they can name your file. To count runs a
crashed tab cut short, a run keeps a small note in this browser's local
storage (the run kind, model and step) and deletes it when it ends. A note
still there on the next visit is counted once and deleted.

The number of charts made in the browser may be shown on autochart.org.

Turn the counts off with **Share usage counts** in Settings. They're also off
when your browser sends Do Not Track or Global Privacy Control. The page
code is `src/web/usageCounts.js`, the list of events and fields is
`shared/usageEvents.js`, and the server is `cloudflare/usage-counts/`.
