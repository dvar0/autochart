# Beta testing status

Updated 2026-09-26. This summarizes automated release verification and maintainer
playtesting. Automated results and hands-on checks are recorded separately below.

## Game compatibility

| Game | Evidence | Limits |
| --- | --- | --- |
| YARG on Linux | The maintainer reports repeated export and in-game playtesting over several months, with satisfactory playback and synchronization. | Reported hands-on experience, not a versioned matrix of every difficulty, device, and media combination. |
| YARG v0.15.0 loader | Seven export cases passed against the release's actual scanner and chart loader, including combined difficulties and lead-in timing. | Loader integration does not exercise Unity gameplay or platform media decoders. |
| Clone Hero | Automated chart-format, audio/video conversion, and export checks pass in the recorded audit. | No in-game Clone Hero playtest is recorded. YARG success is useful evidence, not a guarantee of identical behavior. |

See the [YARG](yarg-compatibility.md) and [Clone Hero](clone-hero-compatibility.md)
audits. Extensive Clone Hero playtesting is not a prerequisite for this first
beta; its untested status should remain visible.

## Native development builds

This table preserves the earlier development evidence. The September 26 release
results below supersede its outstanding automated-verification items.

| Target | Recorded evidence before the public snapshot | Outstanding at that stage |
| --- | --- | --- |
| Linux x64 | Full clean-install release gate, packaged generation, AppImage launch, CPU fallback, and maintainer YARG playtesting. | Repeat native verification on the final tagged source and published artifact. |
| Windows x64 | September 21 clean-install release gate; interactive installer, model-download recovery, CPU fixture and full-song WebGPU generation, persistence/export checks. | Final tagged artifact; downloaded-file SmartScreen flow and outstanding manual checks. |
| macOS Apple Silicon | September 21 clean-install release gate; CPU/WebGPU checks, full-song generation, Finder installation, persistence/export; follow-up ad-hoc signing and quarantined-download opening checks. | Final full gate including the signing follow-up; remaining offline/download-recovery checks. |

Recorded Windows hardware was a Ryzen 5 5600H with approximately 16 GB RAM and
an RTX 3050 Laptop GPU; the Mac was an M2 with 16 GB RAM. These are tested
machines, not minimum requirements. Existing timings were not collected as a
controlled cross-platform benchmark.

## Known generation limitations

Timing and note quality vary. A recorded Windows full-song run exceeded the
1,280-beat transcription limit and left part of the ending uncharted. This is
not established as platform-specific. The model's length limits remain a
documented beta limitation; extending them is outside the public-source and
documentation preparation pass. See [generation tips](generation-tips.md).

## v0.1.0 release verification

The September 26 native release checks passed on Linux x64 (Ubuntu 24.04),
Windows x64 (Windows Server 2025 runner), and macOS Apple Silicon (macOS 15),
using `public-unsigned` distribution. The release source bundle records the
original build revision and preserves the exact source archives for each target.

Each target passed the full clean-install release gate, packaged generation,
and final installer/app launch. The gate ran the direct ONNX, CFG, and WebGPU
parity checks; WebGPU parity may explicitly skip on hosts without usable GPU
acceleration. Windows reported a display-adapter inventory timeout, selected
CPU, completed separation in approximately 49 seconds, and produced a chart.

The four application downloads are:

- `Autochart-0.1.0-win-x64.exe`
- `Autochart-0.1.0-win-x64.zip`
- `Autochart-0.1.0-arm64.dmg`
- `Autochart-0.1.0-linux-x86_64.AppImage`

Release `SHA256SUMS.txt` records the exact application and source-bundle hashes.
`Autochart-0.1.0-sources.zip` preserves each target's matching application and
FFmpeg sources, notices, and original checksum records.

The maintainer reported successful installation and song generation on all
three platforms for the preceding builds, including the unsigned-app opening
steps. A hands-on check of the September 26 downloads has not yet been recorded.
Those earlier checks should not be read as manual verification of these exact
bytes. Offline/download-recovery and game-playback coverage remains limited to
the evidence described above; no additional manual coverage is implied by CI.

See the [release checklist](release-checklist.md) for the full automated gates
and manual QA suggestions.
