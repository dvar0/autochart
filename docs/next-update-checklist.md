# Before Publishing the Next Update

Checks for changes made since the last public release. Clear every item before
publishing, then delete the section once the update ships. The general release
gates are in [release-checklist.md](release-checklist.md).

## Fretformer 2 download

Fretformer 2 and its Fill-in model are in `engine/catalog.json` as the
`fretformer-2` pack and are the catalog default. They aren't on the model host
yet, so setup can't download them until this is done:

- [ ] Prepare and audit the payload (`uv run scripts/prepare-huggingface.py`,
  see [huggingface-release.md](huggingface-release.md)), review it, and upload
  it to the model repository.
- [ ] Point `DEFAULT_ASSET_BASE_URL` in `electron/assetInstaller.cjs` at the new
  revision; run `npm run smoke:generate -- --wipe` and the release gates.
- [ ] Clean install: setup downloads about 952 MB, and Fretformer 2 is the
  default for new projects.
- [ ] Update from the last public release with only Fretformer v1 installed: new
  projects stay on Fretformer v1 until Fretformer 2 is downloaded in Settings;
  the download copies the shared files instead of fetching them again.
- [ ] Release notes give the new download size and say that Fretformer v1 stays
  available in Settings.

## Beat map smoother replaced

The damped smoother is gone. Beat This grids now go through spurious/missed-beat
cleanup, double-time burst folding, glitch repair and a local line fit, and the
`[SyncTrack]` tempo rounding no longer drifts (see
[engine-integration.md](engine-integration.md#timing-detectors)). On 76 songs,
beats within 20 ms of a drum hit went from 56% to 89%.

How it stays compatible:

- Cached beat maps are keyed `smoothgrid3`, so no old grid is reused.
- New takes record `timingSmoothing.method: "line-fit"`. Takes without it were
  made with the old smoother: their take chip reads **old smooth**, and the
  final-chart mismatch message says **old smoothing**.
- An old take's chart keeps the tempo map it was made with. Nothing rewrites it.

Check before publishing:

- [ ] Open projects made with the last public release. Old takes play, compare
  and export exactly as before, and show **old smooth**.
- [ ] Generate a new take in one of them. It shows **smooth**, gets a new beat
  map, and old takes are untouched.
- [ ] Put an old take and a new take in the final chart. It refuses with the
  "needs one shared beatmap … old smoothing … smoothed" message, not a broken
  export. Decide whether that message should offer to regenerate the other
  difficulty.
- [ ] Projects using imported chart sync are unaffected (no smoother runs).
- [ ] Release notes say timing is tighter and that regenerating a take gets the
  new beat map. Don't call it a "new smoother".
- [ ] Spot-check a few songs in Beat Lab (`scripts/dev/beat-lab.html`, open
  through a local web server): tap along and compare with the generated chart.

Known leftovers, decide before or after this update:

- Fretformer v1's `manifest.json` still lists `damped_smooth`,
  `dampedSmoothGain` and `dampedSmoothWindow` (the Fretformer 2 manifests no
  longer do). The engine ignores them. It is hash-pinned in
  `engine/catalog.json` and already published, so it stays as is.
- Songs where Beat This climbs in steps (for example 125 → 250 → 500 BPM around
  a fill) keep their fast stretch; burst folding needs a steady tempo on both
  sides. Fixing this means choosing one tempo level per song.
- With smoothing off, the chart is offset by the first detected beat (no
  lead-in beats are added). Pre-existing.
- The transcriber reads at most 1280 beats; anything later gets no notes. A
  song only hits this at about 200 BPM for 6.5+ minutes. Pre-existing.
