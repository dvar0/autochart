# FFmpeg build and source packaging

Autochart now builds FFmpeg 9.0.1 from the same pinned sources on Linux x64,
Windows x64 and macOS Apple Silicon. The LGPL build includes libogg 1.3.6,
libvorbis 1.3.7, libvpx 1.16.0 and dav1d 1.5.4. It supports audio conversion and silent VP8
video previews/exports, including H.264, HEVC and software AV1 input decoding and phone-video
rotation. GPL, nonfree and network components are disabled. Users receive
FFmpeg inside the app.

The codec build uses x64 optimizations on Linux/Windows and ARM/NEON on Apple
Silicon. libvpx retains runtime CPU detection; the recipe does not use
`-march=native`, so a build is not restricted to the build machine's CPU.
The x64 builds require NASM for optimized assembly. Changes to this recipe
require rebuilding the executable and its corresponding source archive together.

## Build once locally

Install prerequisites:

- Linux: C compiler, make, pkg-config, tar, xz, Meson, Ninja and NASM. On Ubuntu 24.04:
  `sudo apt-get install build-essential pkg-config xz-utils meson ninja-build nasm`.
- macOS: Xcode command-line tools and `brew install pkgconf meson ninja`.
  If the default SDK is incompatible with the installed linker, select a compatible
  installed SDK for the build, for example
  `SDKROOT="$(xcrun --sdk macosx26.5 --show-sdk-path)" npm run release:verify -- --clean-install`.
  This affects only that command; it does not change the system's selected tools.
- Windows: MSYS2 at `C:\msys64`, with UCRT64 packages
  `mingw-w64-ucrt-x86_64-gcc`, `mingw-w64-ucrt-x86_64-pkgconf`, `make`, `tar`, `xz`.
  Also install `mingw-w64-ucrt-x86_64-meson`, `mingw-w64-ucrt-x86_64-ninja`
  and `mingw-w64-ucrt-x86_64-nasm` for dav1d.
  Set `AUTOCHART_MSYS2_BASH` if its bash.exe is installed elsewhere.

Run `npm run ffmpeg:prepare`. Packaging and `npm run release:verify` also run
this automatically. Downloads and builds are cached under
`node_modules/.cache/autochart-ffmpeg/`; rebuilding requires
`npm run ffmpeg:prepare -- --rebuild`. A changed recipe or altered cached file
fails verification and asks for a rebuild. `npm ci` clears the cache.
Public-release verification always compiles a fresh binary from verified source
inputs, rather than trusting a previously generated local build receipt.

Build public Linux artifacts on Ubuntu 24.04, as the workflow does. A binary
built on a newer distribution can require a newer libc. macOS sets a 12.0
minimum for FFmpeg; the Electron app's supported OS requirements still apply.
Windows/macOS builds need their native workflow and machine tests before being
published; a Linux test does not verify those platforms.

## What is automatic

`scripts/ffmpeg-sources.json` pins five upstream source archives by SHA-256.
The FFmpeg release signature was verified against upstream release key
`FCF986EA15E6E293A5644F10B4322F04D67658D8` when pinning 9.0.1.
`scripts/ffmpeg-build.sh` is the offline build recipe. It links the Xiph, WebM and dav1d codec
libraries statically and uses ordinary operating-system libraries dynamically.

The builder creates the executable, a generated `build.json` receipt, and an
ordinary `corresponding-source.tar.gz`. The source archive contains the original
upstream tarballs and licenses, the exact script and source pins, configure log,
configuration header, build information and offline rebuilding instructions.
Build tools receive a minimal environment because FFmpeg records it in the
configure log; release credentials and model-host secrets are not inherited.
Compiler versions can change the resulting binary hash; this is source/input
pinning and build-to-package integrity, not a claim of bit-identical builds.

Every successful release verification copies the matching source archive and
checksum into `release/`, including local test builds. Publish that archive
beside the installer. There is no external FFmpeg source host to configure and
no hand-authored SOURCE-BUNDLE.json or per-file manifest to maintain.

The source gate checks the executable/archive hashes, upstream archive bytes,
recipe and target, and rejects unexpected entries without extracting them.
The audio harness exercises actual Ogg export, PCM decoding and lead-in FLAC.
The Clone Hero export harness converts synthetic 8-bit AV1 WebM and 10-bit AV1
MP4 inputs to VP8 using the bundled software decoder and decodes all output
frames. It also checks cache reuse and preservation of prior exports on failure.
`npm run test:video-preview -- /absolute/path/to/video.mp4` uses a video requiring
conversion (such as HEVC on Linux) to exercise selected files and saved backgrounds
through the production Electron handlers. It checks nonblocking import/source
replacement, asynchronous thumbnails, uncropped video in both highway layouts,
late-ready seeking, stale-result handling, cache reuse and streaming.

The old ffmpeg-static binaries have been replaced. Their missing matching source
archives no longer block releases made with this build path. LGPL source and
license publication still apply; see [FFmpeg's license page](https://ffmpeg.org/legal.html)
and the bundled notices. Autochart's own AGPL license is unchanged.
