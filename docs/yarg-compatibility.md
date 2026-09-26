# YARG export compatibility

Reviewed 2026-09-21 against [YARG v0.15.0](https://github.com/YARC-Official/YARG/releases/tag/v0.15.0):

- Game revision: `f5bfbe6996b4af35722d4204a93c6cc5c8f52a45`.
- Its exact YARG.Core submodule: `3beb94e526558134145bcd3e409428f759001a40`.

Autochart's generated song folders successfully scan and load through that
release's actual Core code. This review builds Core and runs its scanner and
chart loader; it does not run Unity gameplay, BASS audio playback, or the
platform video/image decoders.

## Source audit

| Area | Finding | Upstream implementation |
| --- | --- | --- |
| Folder scanning | Recognizes `song.ini`, `notes.chart`, and `song.ogg`; checks audio presence and playable notes. MIDI filenames take priority over `.chart`. | [CacheHandler.ScanIniEntry](https://github.com/YARC-Official/YARG.Core/blob/3beb94e526558134145bcd3e409428f759001a40/YARG.Core/Song/Cache/CacheHandler.cs#L804) |
| Audio | `song` is a supported stem and `.ogg` is a supported extension. Autochart converts other sources to Vorbis and uses one mixed backing track. | [IniAudio and chart settings](https://github.com/YARC-Official/YARG.Core/blob/3beb94e526558134145bcd3e409428f759001a40/YARG.Core/Song/Entries/Ini/SongEntry.IniBase.cs) |
| Metadata | Our exported keys are accepted; duration and video offsets use milliseconds. A chart's `Offset` is read as seconds and becomes the song offset. Difficulty availability comes from notes, independently of optional intensity ratings. | [SongMetadata](https://github.com/YARC-Official/YARG.Core/blob/3beb94e526558134145bcd3e409428f759001a40/YARG.Core/Song/Entries/Types/SongMetadata.cs), [chart metadata reader](https://github.com/YARC-Official/YARG.Core/blob/3beb94e526558134145bcd3e409428f759001a40/YARG.Core/IO/YARGChartFileReader.cs) |
| Notes | The loader interprets our chords, sustains, force/tap/open markers, resolution, and tempo changes correctly. | [chart note processing](https://github.com/YARC-Official/YARG.Core/blob/3beb94e526558134145bcd3e409428f759001a40/YARG.Core/MoonscraperChartParser/IO/Chart/ChartReader.ProcessLists.cs) |
| Images/video | PNG/JPEG album art and backgrounds are recognized, as is `video.webm`. Unlike Clone Hero's documented image list, YARG also lists GIF; our conversion remains compatible with both. | [media extensions](https://github.com/YARC-Official/YARG.Core/blob/3beb94e526558134145bcd3e409428f759001a40/YARG.Core/Song/Entries/SongEntry.cs), [media selection](https://github.com/YARC-Official/YARG.Core/blob/3beb94e526558134145bcd3e409428f759001a40/YARG.Core/Song/Entries/Ini/SongEntry.UnpackedIni.cs) |
| Video delay | A negative start offset delays playback. The game's start and seek calculations agree with our `-2000` ms value for two seconds of lead-in. | [BackgroundManager](https://github.com/YARC-Official/YARG/blob/f5bfbe6996b4af35722d4204a93c6cc5c8f52a45/Assets/Script/Gameplay/BackgroundManager.cs#L339) |
| Ending | Gameplay considers chart length, audio length and an optional end event; `song_length` is not by itself the gameplay cutoff. | [GameManager.FinalizeChart](https://github.com/YARC-Official/YARG/blob/f5bfbe6996b4af35722d4204a93c6cc5c8f52a45/Assets/Script/Gameplay/GameManager.Loading.cs#L364) |

## Confirmed bug and fix

Exporting over a folder with an old `notes.mid` or `notes.midi` left that file
in place. YARG tries it before `notes.chart` and does not fall back if it is
invalid. The regression reproduced six rejected song folders before the fix.

Export now removes competing MIDI charts and case variants of managed export
files in the staging copy. Promotion remains transactional: failed exports
preserve the original destination, including its MIDI files. Unrelated files
remain intact. The ordinary transactional-export harness covers this fix in
the release gate without requiring .NET.

## Reproducible upstream test

`npm run test:yarg-export` requires .NET SDK 10, Git, the prepared bundled
FFmpeg, and a clean checkout of the pinned Core revision. NuGet access may be
needed for the first build. It adds no runtime dependency to Autochart and
does not bundle YARG's code. For example, using an unused checkout path:

```sh
git clone https://github.com/YARC-Official/YARG.Core.git /tmp/autochart-yarg-core
git -C /tmp/autochart-yarg-core checkout --detach 3beb94e526558134145bcd3e409428f759001a40
AUTOCHART_YARG_CORE_PATH=/tmp/autochart-yarg-core npm run test:yarg-export
```

The test uses Autochart's real exporter and final-chart assembler, then runs
YARG's `CacheHandler.RunScan` and each entry's `LoadChart`. All seven cases
passed on Linux x64: Easy/Medium/Hard/Expert, a combined final chart, 480-PPQ
timing with a negative offset, and padded audio with a delayed video. Assertions
cover metadata with Unicode/quotes/backslashes, durations, offsets, note types,
chord frets, sustain ticks, tempo-map times, and video selection. Every case
starts with conflicting MIDI files in the destination.

The Clone Hero media-conversion harness, transactional export, application
security, chart interoperability, and imported final-chart checks also passed.
The .NET test is an explicit integration check, separate from the default
release gate. The full release gate was not run for this audit.

## Limits and remaining playtest

Maintainer update, 2026-09-24: exported songs have been playtested repeatedly
in YARG on Linux over several months, with satisfactory playback and sync.
This is hands-on use reported by the maintainer, separate from the versioned
Core harness above. It does not establish every difficulty/media combination
or Windows/macOS gameplay. See [testing status](testing-status.md).

The [import limitations from the Clone Hero audit](clone-hero-compatibility.md#scope-limits)
also apply here: arbitrary multistem audio and custom INI options are not
preserved through import/re-export. One `song.ogg` cannot provide separate
instrument muting. Existing `.ogg` sources are assumed to contain valid audio.

For end-to-end confidence, scan an exported song in YARG, play each included
difficulty, check the ending and synchronization, and enable song backgrounds
to check artwork/video rendering. Repeat with lead-in silence. The Core tests
verify data interpretation; they do not establish platform-specific decoder,
device, or rendering behavior, or compatibility with other YARG revisions.
