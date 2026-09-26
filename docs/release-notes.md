# Release notes

## 0.1.0 public beta preparation

Autochart 0.1.0 is being prepared as a free hobby beta for local chart generation.
Final public packages are not yet verified. See [testing status](testing-status.md)
for development-build evidence and maintainer YARG playtesting on Linux. Clone
Hero export has automated compatibility checks but no recorded in-game playtest.
See
[installation instructions](install.md) for first-run setup and checksum
verification. Windows and macOS downloads are unsigned; macOS builds are not
notarized. Operating-system trust warnings are expected.

Generate songs from audio or add Easy, Medium, and Hard difficulties alongside
an imported Expert chart using its original timing. Preview and compare takes,
choose final difficulties, and export a song folder. Generated notes have model
quirks and length limits; read [generation tips](generation-tips.md).

Exports containing generated notes identify the generated difficulties and
preserve imported charter credit in mixed charts. See
[chart metadata](chart-metadata.md).

The chart generation model download is approximately 693 MB (661 MiB), plus
temporary installation space. Audio, exported songs, and analysis caches need
additional storage. Minimum RAM and full-song generation times are awaiting
testing on different machines; CPU generation is supported and GPU acceleration
is optional. The GitHub release description lists the machines actually tested.

| Target | Package | CPU baseline | Accelerated providers | Fallback | FFmpeg |
| --- | --- | --- | --- | --- | --- |
| Linux x64 | AppImage | Supported | WebGPU; CUDA where available | CPU on provider initialization failure | 9.0.1 |
| Windows x64 | NSIS/zip | Supported | WebGPU; CUDA where available | CPU on provider initialization failure | 9.0.1 |
| macOS Apple Silicon | DMG | Supported | WebGPU; experimental Core ML | CPU on provider initialization failure | 9.0.1 |

Linux ARM, Windows ARM, and macOS Intel are unsupported generation targets;
the app must not offer a generation setup or Generate action for them. CPU is
the supported baseline on every supported target. WebGPU is opportunistic and
requires the standalone Node runtime to initialize a Dawn adapter; when that
or another selected provider cannot initialize, Autochart reports the reason
and completes the job on CPU.

- Chart generation is delivered as one verified chart generation package: Demucs separation, Beat This timing, Fretformer transcription, and the local ONNX Runtime support files.
- Importing a Clone Hero song reuses its human-charted sync track by default: generation keeps the imported tempo map and time signatures instead of detecting timing from the audio. Switch the Advanced detector to Beat-This to detect timing instead.
- WAV generation correctly validates the cached audio copy, including mono-to-stereo normalization and repeated generation from the same file.
- CPU fallback can finish successfully when no WebGPU adapter is available; the engine drains its result events before exiting to avoid a native runtime shutdown crash.
- Browser mode can import a Clone Hero song folder through the browser picker and stores the project in IndexedDB. Generation and native filesystem export remain Electron-only.
- The highway remains a visual chart preview with note animation, transport, lyrics, and visual perspective settings; playable guitar, keyboard, HID, gamepad, scoring, and hit/miss controls are not included.
- Highway sustains remain visible through streamed chart updates, seeking clears old hit effects, and starting playback holds the preview in place until scheduled audio begins. Reduced motion disables sustain shimmer.
- The library detail panel uses a simpler background and updated export/save action layout.
- `npm run release:verify` runs package, runtime, license, path/media safety, direct engine, WebGPU parity, and packaged-generation gates before release and writes release checksums after verification.

Videos that Electron cannot decode, including HEVC phone recordings, receive a
cached compatible video preview with their rotation preserved. This applies to
new selections and saved project backgrounds. Video preparation and thumbnail
extraction run in the background so importing, opening projects, and starting
generation do not wait for conversion. Highway videos fit the full frame rather
than cropping portrait recordings to fill the stage.

FFmpeg is an LGPL build from pinned sources, with libogg/libvorbis
for Ogg export, libvpx for video conversion and dav1d for software AV1 decoding.
Release verification automatically packages its matching source
archive beside the app. Users do not need to install FFmpeg separately.
