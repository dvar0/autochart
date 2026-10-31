# Before Publishing the Next Update

Checks for changes made since the last public release. Clear every item before
publishing, then delete the section once the update ships. The general release
gates are in [release-checklist.md](release-checklist.md).

## Library queue

- [ ] Queue ten songs of mixed length, some already separated, with two
  difficulties, and let it finish: the percent climbs steadily and the songs that
  have stems skip separating.
- [ ] Drop more songs on the Library with the queue open while it runs.
- [ ] Start a project's Generate during a queue run: it goes next and the queue
  carries on afterwards.
- [ ] Save all, then play the songs in Clone Hero and YARG. Check Export all too.
- [ ] Open the song being charted from the queue: progress and notes catch up and keep coming, and Stop stops the queue.
- [ ] Quit with songs waiting and reopen: the queue comes back and waits for Generate.
- [ ] Leave a long queue running with the screen off on Windows, macOS and Linux:
  the computer doesn't sleep until it finishes.

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
  projects start on Fretformer 2, and Generate's button reads **Download
  Fretformer 2** with its size. It downloads right there, then turns into
  **Generate chart**. Projects from 0.1.0 open on Fretformer 2 too. Picking
  Fretformer 1 in Settings, in a project's picker, or with **Use settings** on an
  old take still works, and a project keeps that pick after it's reopened. The
  download copies the shared files instead of fetching them again.
- [ ] Start that download on Generate or in What's new, then open Settings: it shows
  the same download's progress and doesn't offer a second one.
- [ ] Release notes give the new download size and say that Fretformer v1 stays
  available in Settings.
- [ ] Fretformer 2 Lite (`fretformer-2-lite` pack, experimental) downloads from
  Settings, generates with separation skipped, and fills in its own takes;
  Fretformer 2's Fill-in on a Lite take separates first. Decide whether it
  ships in this update or comes out of the catalog.
- [ ] On a slow machine, a run whose separation is projected past twice the
  song's length offers Lite once; Switch to Lite downloads it and reruns, Keep
  going never offers it again. Lite stays out of the Generate picker until
  it's downloaded.

## First-run setup

Setup is now one screen (`src/pages/Setup.jsx`): it names Fretformer 2, shows its
size and the free space, downloads it, and opens Generate. Fretformer v1 and Lite
aren't listed on Generate until they're downloaded.

- [ ] On each platform, on a clean install: **Download Fretformer 2** finishes and
  opens Generate on Fretformer 2, and the model picker offers nothing else.
- [ ] **Change location** opens the folder picker, and the free space updates for
  the new drive (Windows, macOS and Linux report it differently).
- [ ] Quit during the download and reopen: it offers **Finish download** and only
  fetches what's missing.
- [ ] Unplug the network during the download: the error shows, and **Try again**
  keeps the finished files.

## App updates and What's new

This is the first release that checks for updates (`electron/appUpdates.cjs`).
Copies of 0.1.0 can't, so they only hear about it from the release itself.

- [ ] Bump `package.json` to the release version; `src/data/whatsNew.js` has
  its entry (What's new only shows entries up to the running version).
- [ ] Update from 0.1.0 with setup done: What's new opens once, and
  **Download Fretformer 2** opens Settings and starts the download.
- [ ] Clean install: no What's new after setup.
- [ ] Publish `update.json` with the release (see
  [github-release.md](github-release.md)). Before that, test with a feed
  signed by the real key and served from a test release or local HTTPS:
  `AUTOCHART_UPDATE_FEED_URL=https://… ` makes a dev build check it.
- [ ] Per platform, a version older than the feed shows the rail notice, and
  the update installs: AppImage swaps in place and reopens on the new version
  (no "Cannot mount AppImage" message, which means it was started with
  no_new_privs; don't use `app.relaunch` for it), the Windows
  installer updates and reopens, the macOS DMG opens and the app closes.
  Portable Windows (zip) only offers the download page.

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
  final-chart message says the take was made with **older timing**.
- An old take's chart keeps the tempo map it was made with. Nothing rewrites it.

Check before publishing:

- [ ] Open projects made with the last public release. Old takes play, compare
  and export exactly as before, and show **old smooth**.
- [ ] Generate a new take in one of them. It shows **smooth**, gets a new beat
  map, and old takes are untouched.
- [ ] Put an old take and a new take in the final chart. It refuses with the
  "made with older timing … Generate it again" message, not a broken
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
