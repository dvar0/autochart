# Release Checklist

This checklist distinguishes a private smoke build, the supported free
public-unsigned release, and an optional paid signed release. Public unsigned
artifacts still pass every source, licensing, integrity, checksum, and
target-native launch gate. They will trigger platform trust warnings; signing
and notarization improve installation UX but are not required for this project.

## Release Gates

These are hard blockers, not reminders:

- [ ] **Noncommercial model distribution:** the release, model download,
  hosting, promotion, and any bundled service are not primarily intended for
  commercial advantage or monetary compensation. If the planned use is
  commercial or ambiguous, do not publish the Fretformer pack or an installer
  that offers it until separate permission is documented.
- [ ] App license is AGPL-3.0-or-later (top-level `LICENSE`).
- [ ] The packaged application contains that `LICENSE`, and the standalone
  Node runtime contains the exact upstream `LICENSE` and bundled notices beside
  its executable.
- [ ] Fretformer is identified as CC-BY-NC-SA-4.0; Demucs and Beat This
  derivatives retain MIT notices. The packaged app contains the four legal
  files under `engine/licenses/`; setup copies and verifies their catalog-pinned
  size and SHA-256 into the selected model installation.
- [ ] The asset host contains every `source: "remote"` path pinned by the
  shipped `engine/catalog.json` with exactly its declared byte size and
  SHA-256. Bundled legal files are never requested from the host. A remote
  `catalog.json` is not trusted and cannot change a released app's file set.
- [ ] **Public artifact transparency:** release notes and download pages label
  Windows and macOS artifacts as unsigned, link their SHA-256 checksums, and
  explain the expected operating-system warning. Do not imply that Apple or
  Microsoft verified the publisher or scanned the release.
- [ ] `npm run release:verify -- --public-release` passes
  on every matching target. Paid signatures are checked only when the optional
  `--require-signing` flag is present.

Independent legal review is optional for this hobby project. Seek qualified
advice if a specific licensing question remains unresolved; this checklist
does not establish an external review requirement or provide legal approval.
The source-publication and attribution requirements above still apply.

For the next release, record actual results in [testing-status.md](testing-status.md).
User installation instructions are in [install.md](install.md); FFmpeg build and source packaging instructions are in [ffmpeg-source-status.md](ffmpeg-source-status.md).

## Supported target and fallback matrix

Verify every release against the same target matrix used by Electron, the
engine, packaging scripts, and the Settings UI:

| Target | Package | CPU baseline | Accelerated providers | Fallback requirement | FFmpeg |
| --- | --- | --- | --- | --- | --- |
| Linux x64 | AppImage | Required | WebGPU; CUDA where available | Provider initialization failure reports and reruns on CPU | 9.0.1 |
| Windows x64 | NSIS/zip | Required | WebGPU; CUDA where available | Provider initialization failure reports and reruns on CPU | 9.0.1 |
| macOS Apple Silicon | DMG | Required | WebGPU; experimental Core ML | Provider initialization failure reports and reruns on CPU | 9.0.1 |

The CPU path is the supported generation baseline. WebGPU, CUDA, and Core ML
are opportunistic accelerators; no release may make an accelerated provider a
generation prerequisite. Mark macOS Intel, Windows ARM, and Linux ARM as
unsupported rather than offering a Generate or setup CTA for them.

### Fallback verification

- [ ] Automatic/WebGPU mode reports the provider initialization result and
  completes on CPU when no adapter is available.
- [ ] Explicit CUDA and Core ML provider failures report the reason and
  complete on CPU where the target supports that provider.
- [ ] The UI identifies the selected target and does not present generation
  setup or Generate actions for an unsupported platform/architecture pair.
- [ ] Release notes and download pages repeat this matrix without claiming
  that GPU acceleration is guaranteed.

## Source Publication Beside Every Binary

The public release has six uploaded assets: three native installers, the Windows
portable ZIP, `Autochart-${version}-sources.zip`, and `SHA256SUMS.txt`. GitHub also
displays its two automatic repository source downloads; those do not replace the
matching source bundle. Place a direct source-bundle link beside the installer
links. Keep the unsigned warning and platform opening steps in the release text.

Run `npm run release:stage -- /new/output /linux/artifacts /windows/artifacts /mac/artifacts`
after all three native public-unsigned verification jobs pass. This preserves
every target's original files inside the source bundle, grouped by target:

- `Autochart-${version}-source.tar.gz` and
  `Autochart-${version}-source.tar.gz.sha256`: the exact preferred AGPL source
  for that release, including the release commit/tag, `package-lock.json`,
  Electron/Vite packaging configuration, installer/archive validation code,
  and every script required to build and install the application.
- `Autochart-${version}-${os}-${arch}-ffmpeg-corresponding-source.tar.gz` and
  `Autochart-${version}-${os}-${arch}-ffmpeg-corresponding-source.tar.gz.sha256`:
  Corresponding Source for the exact bundled FFmpeg executable on that target.
  Generated automatically from the same pinned FFmpeg, libogg, libvorbis, libvpx and dav1d
  sources used to build the bundled executable, with its offline build recipe.
- The target's original `SHA256SUMS.txt` verification record.
- For `public-unsigned`, `UNSIGNED-RELEASE.txt`, generated by the verifier with
  the platform-warning and supported override instructions.

The staging command verifies native checksums and source sidecars, requires the
same Git archive commit on all targets, and verifies the bundle after writing it.
It preserves platform-specific source bytes, including Windows line endings.
`manifest.json` inside the bundle maps every binary and its hash to the exact
application and FFmpeg archives. An inner checksum list covers all bundle files;
the outer `SHA256SUMS.txt` covers the four app downloads and the source bundle.
The command refuses an existing output directory and does not modify its inputs.
Unused `.blockmap` update files are omitted from public downloads. Native CI
records remain unchanged; their checksum lists can still mention those files.

Do not substitute a Git repository home page, a tag without submodule/vendor
sources, or a source bundle for a different FFmpeg build. Verify the published
archives can be downloaded without authentication or additional charge for as
long as the corresponding binary remains available.

Public verification creates the application source archive directly from a
clean Git commit carrying the exact `v<package.json version>` tag. It refuses
dirty or untracked source.
The verifier builds FFmpeg and creates its source archive automatically. No
separately hosted archive, custom per-file manifest, or manual source-bundle
metadata is required. The ordinary `.tar.gz` contains the five upstream
archives, build script, source pins, configure log, configuration header,
README and build information. Its SHA-256 and executable SHA-256 are recorded
in the generated build receipt; the release gate checks both and inspects the
source entries without extracting them. Altered inputs, unexpected entries,
and target/recipe mismatches fail verification.

Install native build tools before running the verifier; see
[ffmpeg-source-status.md](ffmpeg-source-status.md). The GitHub workflow installs
them automatically. Build Linux public artifacts on Ubuntu 24.04 so newer host
libc requirements do not accidentally exclude the supported baseline.

## Clean Install Smoke

Run the unified target-native verifier on each target you plan to publish:

```bash
npm run release:verify -- --clean-install
```

The app and target-native GitHub workflow use the pinned public Hugging Face
source by default and install into isolated test paths. A custom mirror can
be supplied through `AUTOCHART_ASSETS_BASE_URL` (an optional repository or
protected-environment secret in CI). Keep private/tokenized URLs in that
environment variable rather than command arguments or logs.

The verifier creates a unique, marked temporary root by default. Wipe mode can
delete only directories created and marked for that exact run. A caller-supplied
path must not already exist in wipe mode; real Autochart settings, cache,
models, and projects are never selected as defaults or removed. Successful
runs clean their marked scratch data, while failed runs retain it and print the
diagnostic location.

Expected result:

- Setup downloads the hash-pinned ONNX model pack from the supplied asset host.
- Hardware mode is selected correctly, with WebGPU, CUDA, or Core ML falling back to CPU when provider initialization fails.
- Generation emits at least one `partial_chart` event with note lines.
- The final generated chart has note lines and a readable report path.
- All three direct engine gates run. A WebGPU-less runner may emit the gate's
  explicit `SKIP` result; the verifier itself never silently omits the gate.

## Manual App QA

- Launch the packaged app from a clean user data folder.
- Complete first-run setup with default folders.
- Import a Clone Hero `.chart` song folder.
- Generate an Expert chart from audio.
- Confirm live generation preview updates during chart generation.
- Save the project, quit, relaunch, and confirm it persists.
- Assign at least one final difficulty and export a Clone Hero folder.
- Configure a Clone Hero/YARG library folder and save an Autochart copy.
- Play back the exported folder in Clone Hero or YARG.
- Try a missing-model setup path and confirm the error points back to setup/download source.
- Import a multi-gigabyte background video and confirm saving streams it
  disk-to-disk without a renderer memory spike; reopen it and seek through playback.

## Unified Release Verification

The default command is fail-fast and has no `--skip-*` options:

```bash
npm run release:verify
```
It runs, in order: production dependency audit; installer/archive, FFmpeg
Corresponding Source, application-security, path-backed-media, final-container
readiness, and smoke deletion-boundary tests; transactional-export and
path-generation behavioral harnesses; engine exit/event draining;
frontend/backend contracts, highway,
chart interoperability, release-documentation, notice-path and package-allowlist
regressions; one production renderer build; real
Electron media-protocol/CSP and preload/IPC harnesses; generation smoke;
`engine/test/generate-onnx-smoke.cjs`,
`engine/test/transcribe-cfg-batch-parity.cjs`, and
`engine/test/webgpu-parity.cjs`; one native package build; the packaged-content
allowlist; packaged generation through the artifact's bundled Node, engine,
ONNX Runtime, and FFmpeg; and release checksums. Electron Builder's `afterPack`
allowlist also
checks the unpacked app during package creation. The verifier calls Electron
Builder directly after the one Vite build, passes `--publish never`, and does
not rebuild the renderer through `dist:*`. Publishing is a separate deliberate
step after every checklist gate is complete.

On Linux, before packaging, the verifier also runs a separate WebGPU-requested
generation with an unavailable Vulkan driver list in that subprocess's
environment. It requires an explicit GPU-to-CPU fallback event, a completed CPU
result, and streamed notes. This covers native shutdown after failed adapter
initialization even when the runner normally has a working GPU.

Node binaries are pinned per target in `scripts/runtime-artifacts.json`.
FFmpeg source archives are pinned in `scripts/ffmpeg-sources.json`; its generated
build receipt records the executable and source archive hashes. The
`beforePack`/`afterPack` path verifies those bytes before optional signing. Linux
and Windows artifacts must retain those exact bytes. On Windows,
`build.win.signExts` excludes the separately executed `node.exe` and
`ffmpeg.exe` from optional Autochart publisher re-signing. In
`--require-signing` mode, `Autochart.exe` and the installer must pass the
Authenticode gates. macOS signing rewrites Mach-O code-signature data, so only
that optional target-native signed mode permits changed runtime executable
bytes after strict `codesign` validation and an exact runtime version check.
Windows and macOS native CI remain required even for unsigned releases.

Useful strengthening options are documented by `--help`:

```bash
# Recommended clean-install verification using the public default source.
# All scratch paths are isolated automatically.
npm run release:verify -- --clean-install

# Reuse an existing model installation without granting wipe authority.
npm run release:verify -- --models-folder /existing/autochart-models

# Public unsigned form, from a clean commit tagged v<package.json version>.
npm run release:verify -- --public-release

# Optional paid signed form; adds Authenticode or Developer ID/notarization gates.
npm run release:verify -- --public-release --require-signing
```

The target-native workflow is `.github/workflows/release-smoke.yml`. Its matrix
uses `ubuntu-24.04` x64, `windows-2025` x64, and `macos-15` arm64 and asserts
`process.platform` and `process.arch` before doing work. Each job performs
`npm ci`, runs the unified clean-install verifier, then exercises the final
container: AppImage execution, a silent NSIS install, or a mounted DMG launch.
Each launch must write a version/target renderer-ready marker after React has
mounted and the packaged preload bridge completes a sender-bound IPC round
trip; process liveness alone is not accepted. The job uploads only that target's
verified release artifacts, sources, and checksums. Configure:

- `AUTOCHART_ASSETS_BASE_URL` only when overriding the public default source.
- `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` only for optional
  `public-signed` Windows runs.
- `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `MACOS_API_KEY_P8`,
  `MACOS_API_KEY_ID`, and `MACOS_API_ISSUER_ID` only for optional
  `public-signed` macOS runs.

Select `public-unsigned` for the project's normal free distribution. Select
`public-signed` only if paid credentials are intentionally available, or
`personal` for an unpublished smoke artifact. Each operating-system job verifies
only its own native package and cannot substitute for another target.

## Public Unsigned Distribution — Supported Default

Unsigned does not mean untested: use the target-native `public-unsigned`
workflow artifacts only after every public source and integrity gate passes.
Publish `SHA256SUMS.txt` beside them, put the exact digest in the release notes,
and state plainly that the publisher is not platform-verified.

- Windows will commonly show Microsoft Defender SmartScreen's “Windows
  protected your PC” warning. A user who independently trusts the download may
  choose **More info → Run anyway**. Smart App Control or organizational policy
  can prevent that override; do not advise users to disable system-wide
  protection. See [Microsoft's SmartScreen guidance](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation).
- macOS will report an unidentified developer or that Apple cannot check the
  app for malicious software. After attempting to open it, a user who has
  independently verified the download may use **System Settings → Privacy &
  Security → Open Anyway**. Do not recommend disabling Gatekeeper globally.
  See [Apple's supported override steps](https://support.apple.com/102445).
- Linux users should verify the checksum before making the AppImage executable.

These warnings are an expected tradeoff of the free release path, not a failed
build. They must be reproduced during manual QA and documented on the download
page.

## Optional Signed Windows Distribution

When `--require-signing` is deliberately selected, use an Authenticode
code-signing certificate whose subject is the actual publisher. CI supplies
the password-protected PFX/PKCS#12 as
`WINDOWS_CSC_LINK` (Electron Builder accepts a protected URL, file, data URL,
or base64 value) and its password as `WINDOWS_CSC_KEY_PASSWORD`; local
certificate-store builds may use a deliberately selected `CSC_NAME`. Never
print, persist, or upload these secret values. SHA-256 signing is enforced in
the package configuration, and the signing service/certificate must timestamp
both the unpacked application executable and NSIS installer.

The signed verifier runs `Get-AuthenticodeSignature` over
`release/win-unpacked/Autochart.exe` and every generated installer `.exe` and
requires `Status = Valid` plus a non-null timestamp certificate. Before
publishing, independently repeat with the Windows SDK:

```powershell
signtool verify /pa /all /v release\win-unpacked\Autochart.exe
Get-ChildItem release\*.exe | ForEach-Object {
  signtool verify /pa /all /v $_.FullName
}
```

In `--require-signing` mode, an unsigned, unknown, expired, untrusted, or
untimestamped executable is a release blocker. This optional gate does not run
for the documented `public-unsigned` release mode.

## Optional Signed macOS Distribution

When `--require-signing` is deliberately selected, use a **Developer ID
Application** certificate for the publishing team, not an ad-hoc signature or
Mac App Store identity. Electron Builder reads
`MACOS_CSC_LINK`/`MACOS_CSC_KEY_PASSWORD` through the workflow's standard
`CSC_LINK`/`CSC_KEY_PASSWORD` environment. The package enables hardened runtime
and applies `build/entitlements.mac.plist` to the app and inherited helpers.
Those entitlements are limited to Electron JIT/unsigned executable memory and
library validation needed by the packaged ONNX native runtime; additions
require a fresh runtime review.

For CI notarization, store the App Store Connect API private key contents in
`MACOS_API_KEY_P8`, with `MACOS_API_KEY_ID` and `MACOS_API_ISSUER_ID`. The
workflow writes the key to an owner-only temporary file, exposes its path as
`APPLE_API_KEY` only to the verifier step, and removes it before launching the
final DMG. Local releases may instead provide
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.

`--public-release --require-signing` enables Electron Builder notarization for
the signed app, then submits the final DMG with `xcrun notarytool --wait`,
staples the DMG, and requires all of these checks:

```bash
codesign --verify --deep --strict --verbose=2 release/mac-arm64/Autochart.app
spctl --assess --type execute --verbose=2 release/mac-arm64/Autochart.app
xcrun stapler validate release/mac-arm64/Autochart.app
xcrun stapler validate release/Autochart-*.dmg
```

In `--require-signing` mode, do not publish on a pending/rejected notarization
result, failed staple, invalid Developer ID chain, missing hardened runtime, or
failed Gatekeeper assessment. Those optional paid checks do not run for the
documented `public-unsigned` release mode.

## Release Notes Template

```text
Autochart 0.1.0

Signature status:
- Windows and macOS downloads are unsigned. Expect the platform warning described on the release page.
- Verify the downloaded file against SHA256SUMS.txt before opening it.

Supported generation targets:
- Linux x64: CPU, NVIDIA CUDA where available
- Windows x64: CPU, NVIDIA CUDA where available
- macOS Apple Silicon: CPU, experimental Core ML

Known limitations:
- .chart import only; notes.mid import is not wired up yet.
- macOS Intel, Windows ARM, Linux ARM, and macOS CUDA are not generation targets in this build.
- First setup downloads the large ONNX model pack from the configured download source.
```
