# Clone Hero export compatibility

Reviewed 2026-09-21 against the Clone Hero wiki and FireFox's chart-format
specification. Generated five-fret guitar exports follow the documented
formats. This is a source/code audit plus automated export testing; an actual
Clone Hero scan and playthrough has not been performed in this review.

## Format audit

| Area | Autochart behavior | Reference |
| --- | --- | --- |
| Song folder | Writes `notes.chart`, `song.ini`, and `song.ogg`; rejects missing audio. Library save creates a song subfolder. | [Adding Custom Songs](https://wiki.clonehero.net/books/clone-hero-manual/page/adding-custom-songs) |
| Metadata | Writes `[song]` and a nonempty `name`, flattens line breaks in values, uses milliseconds for duration, and omits optional difficulty intensity ratings. | [song.ini Guide](https://wiki.clonehero.net/books/guides-and-tutorials/page/songini-guide) |
| Chart | Uses `EasySingle` through `ExpertSingle`, resolution, BPM × 1000, integer note ticks/sustains, and conventional force/tap/open markers. Final-chart assembly retains the shared timing map. | [Chart File Format Specifications](https://docs.google.com/document/d/1v2v0U-9HQ5qHeccpExDOLJ5CMPZZ3QytPmAG5WF0Kzs/mobilebasic) |
| Images | Preserves PNG/JPEG; converts WebP/GIF album art and backgrounds to a first-frame JPEG. | [Other Custom Content](https://wiki.clonehero.net/books/clone-hero-manual/page/other-custom-content) |
| Video | Transcodes to `video.webm` with VP8 and no audio track, including on Linux. | [Clone Hero's FFmpeg guide](https://wiki.clonehero.net/books/guides-and-tutorials/page/converting-mp4-to-webm-using-ffmpeg) |
| Video timing | Padded generated audio uses negative `video_start_time` to delay the unpadded video by the lead-in duration. | [Custom Content](https://wiki.clonehero.net/books/guides-and-tutorials/page/custom-content) |

Audio conversions produce Vorbis in Ogg. Existing `.ogg` sources are copied;
their contents are assumed to be valid game audio. The test checks an actual
WAV-to-Vorbis export and decodes it to verify duration and lead-in silence.

## Fixes and verification

This review fixed WebP/GIF bytes being copied unchanged or renamed to PNG,
missing `name` on blank titles, multiline INI values, and successful exports
without audio. The bundled LGPL FFmpeg recipe now includes the image codecs
needed by export. It also includes statically linked dav1d for software AV1
decoding, so AV1 backgrounds can be converted to VP8 without GPU support.
The original project video is retained; existing charts need no regeneration.
Conversion failures identify the source file, keep codec diagnostics in the
main-process log, and preserve any previous complete export.

For an existing development checkout, rebuild its cached runtime with
`npm run ffmpeg:prepare -- --rebuild` before testing or packaging this change.
The Linux runtime was rebuilt during this audit.

`npm run test:clone-hero-export` exercises the real exporter with the bundled
FFmpeg: all four selected difficulties, metadata, both image formats in both
roles, Vorbis bytes and decoded duration, VP9/AV1-to-VP8 conversion (8-bit WebM
and 10-bit MP4 AV1 inputs), decoding every exported frame, cache reuse, and padded
audio/video timing. It also runs in `npm run release:verify`.

The export, chart interoperability, source timing, final-chart assembly,
application security, bundled audio, and FFmpeg source-integrity checks passed
on Linux x64, as did the production UI build. This does not establish runtime
behavior on Windows/macOS or inside Clone Hero, and the full release gate was
not run for this audit.

## Scope limits

Existing-song import is not a lossless round trip of arbitrary Clone Hero song
folders. `src/services/songImport.js` selects one audio file and a subset of INI
metadata. It does not mix/preserve a multistem song or retain custom INI options
such as `delay`, HOPO settings, or the original video offset. MIDI-only import
is explicitly unsupported. These limitations also matter when re-exporting an
imported song; the generated-chart checks do not certify those cases.

## Save performance

Project staging and exported media now request independent copy-on-write clones,
falling back to ordinary copies when the filesystem cannot clone. Export staging
skips managed files that will be replaced while retaining custom files and the
existing rollback protection. Export only replaces managed files in a folder whose
`song.ini` marks it as a previous Autochart export; a same-named folder holding
any other song is refused and left untouched. Refreshing saved takes parses chart data without
reloading the audio. Export cache timestamps are rounded consistently with
project copies, preventing fractional-millisecond changes from causing needless
re-encoding. The export harness verifies cache reuse with the encoder unavailable,
custom-file preservation, and isolation of edited export media from the cache.

A local Linux comparison using a synthetic 30-second 1080p/30 H.264 clip and
unchanged VP8 export settings measured median conversion time of 12.7 seconds
before the CPU-optimized FFmpeg build and 3.0 seconds after (three runs each).
A separate backend save/export comparison, including 30 seconds of WAV audio,
took 13.6 seconds before and 3.1 seconds after on its first save. Cached saves
were already fast in this small fixture (21–38 ms across both builds). These
figures exclude renderer work and are not predictions for arbitrary songs or
Mac/Windows hardware. Native Mac/Windows validation remains required.

## Remaining in-game check

1. Export a generated song, including a final chart with multiple difficulties,
   to a fresh folder inside a configured Clone Hero songs directory.
2. Use **Settings → General → Scan Songs** and check `badsongs.txt` if the scan
   reports errors. See [Scanning Songs](https://wiki.clonehero.net/books/clone-hero-manual/page/scanning-songs).
3. Play each included difficulty; check chords, sustains, forced/tap/open notes,
   synchronization, and the ending. Repeat with lead-in silence enabled.
4. Enable song backgrounds/videos and check the artwork and video timing.

Clone Hero also provides bot previews, for example:

```sh
"/path/to/Clone Hero" --song "/path/to/exported/song" --player Guitar,Expert
```

See [Chart Previews via the Command Line](https://wiki.clonehero.net/books/clone-hero-manual/page/chart-previews-via-the-command-line).
