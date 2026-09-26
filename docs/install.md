# Install Autochart

Autochart is a free hobby project. The first public beta is being prepared;
the instructions below apply once verified downloads are available. See
[testing status](testing-status.md) for the current evidence.

Download the app from this repository's
GitHub Releases page and choose the package for your computer:

| Computer | Download |
| --- | --- |
| Windows x64 | `.exe` installer, or `.zip` portable folder |
| macOS Apple Silicon (M-series) | `arm64.dmg` |
| Linux x64 | `.AppImage` |

macOS Intel, Windows ARM, and Linux ARM generation are unsupported.
Only use platforms listed as tested in the release you download.

## Verify your download

Download `SHA256SUMS.txt` from the same release. Calculate the SHA-256 of the
installer and compare it with the line for that exact filename:

```powershell
# Windows PowerShell; substitute the downloaded filename.
Get-FileHash .\Autochart-0.1.0-win-x64.exe -Algorithm SHA256
```

```bash
# macOS
shasum -a 256 Autochart-0.1.0-arm64.dmg

# Linux
sha256sum Autochart-0.1.0-linux-x86_64.AppImage
```

The complete hash must match (letter case does not matter).

## Open the app

- **Windows:** run the installer, or extract the entire ZIP before opening
  `Autochart.exe`. These releases are unsigned. If SmartScreen shows
  “Windows protected your PC,” and you trust the verified download, select
  **More info → Run anyway**. Smart App Control or a managed computer's policy
  may prevent this override.
- **macOS:** open the DMG, drag Autochart into Applications, and open it there.
  These releases have a local ad-hoc signature for bundle integrity, but no
  Apple Developer ID signature or notarization. If macOS blocks the initial
  launch, open **System Settings → Privacy & Security → Open Anyway** only if
  you trust the verified download.
- **Linux:** mark the AppImage executable in its file properties or with
  `chmod +x Autochart-0.1.0-linux-x86_64.AppImage`, then open it. If the system
  reports missing FUSE support, try launching it with
  `./Autochart-0.1.0-linux-x86_64.AppImage --appimage-extract-and-run`.
  See the [AppImage FUSE instructions](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).

Do not disable system-wide security protections to install Autochart.
See [Microsoft's SmartScreen guidance](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation)
and [Apple's supported override instructions](https://support.apple.com/102445).

## First run

1. Choose folders for projects, models, and cache in setup. Use writable local
   folders with room for your songs and generated audio.
2. Download the chart generation package. Version 0.1.0's model files total
   **693,298,686 bytes (about 693 MB / 661 MiB)**, excluding the app download.
   Installation also needs temporary staging space. Projects and separation
   caches require additional disk space that grows with song length and use.
3. Hardware mode defaults to **Automatic**; there is no hardware-selection
   step during setup. Advanced users can change it in **Settings**. CPU
   generation is supported; acceleration depends on your computer and drivers.
   Provider initialization failures are reported and fall back to CPU. No Python
   installation is needed.
4. Import audio, generate a chart, assign a final difficulty, and export a song
   folder. Open the exported folder in Clone Hero or YARG to play it.

To add easier difficulties to an existing chart or experiment with lead-in
silence and separation, see [generation tips](generation-tips.md).

After setup, generation runs locally without uploading your songs. Internet
access is needed for the initial model download. See [privacy.md](privacy.md).

Setup uses the public [Autochart model repository](https://huggingface.co/Dvaro/autochart-models)
on Hugging Face automatically, at a fixed revision verified by the app's
catalog. No account or token is required. For a custom mirror, use
**Advanced: change download source** in setup and click **Save Source**, or
use **Settings > Download source**. When launching from a terminal,
`AUTOCHART_ASSETS_BASE_URL` can override the source.

Minimum RAM and typical full-song generation times have not yet been established
across machines. CPU generation can take time; use a short song for your first
attempt. Release notes will identify the hardware actually tested.

## Known limitations and updates

Charts are generated suggestions and may need timing or note edits. The highway
inside Autochart is a visual preview; gameplay and scoring happen in Clone Hero
or YARG. Browser preview mode cannot generate or export to the native filesystem.

To update, download a newer release and install it or replace the portable app
folder. Keep your projects and model folders. Back up projects before testing
a new version. Include the app version, OS/architecture, hardware mode, and
reproduction steps when reporting a problem; attach logs only after reviewing
them for personal file paths.
