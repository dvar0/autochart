# Getting a useful chart

Start with the default settings and a song you know. Listen and preview before
changing several controls at once: it is easier to judge a new take when you
know what changed.

## Generate from audio

Import your audio, choose Easy, Medium, Hard, or Expert, and generate. Notes
appear in the preview as transcription progresses. Once the take is ready,
preview several sections and assign it to a final difficulty slot. Export uses
the assigned final difficulties, so choose the takes you want to play first.

A difficulty setting guides the model; it does not guarantee that every passage
will suit a player at that level. Check chord size, note density, and awkward
transitions, especially when preparing something for a new player.

## Add an easier difficulty to an existing chart

1. Import a song folder containing `notes.chart` and audio. MIDI chart import
   is not supported in this version.
2. Keep **Imported chart sync** as the timing detector. Autochart selects it
   by default for imported charts and reuses their tempo map and time signatures.
3. Choose the difficulty you want to add and generate a take.
4. Compare it with the original. Keep the imported Expert chart assigned to
   Expert, for example, and assign your new take to Medium.
5. Export the combined final chart and scan the song in your game.

The new difficulty is generated from audio using the imported timing. It is
not a note-by-note reduction of the original Expert chart. Original imported
difficulties remain available; assigning a new take to a final slot changes
which version is exported in that slot.

Imported chart sync preserves the existing timing rather than running Beat This.
Lead-in silence and timing smoothing are disabled in that mode. Change the
detector only if you deliberately want to detect timing again; a different
timing basis may not be suitable for combining takes with the original chart.

## If the music starts immediately

For songs with sound right at 0:00, try a small amount of **Lead-in silence**
if the opening timing is poor. The maintainer has found this useful on some
songs; it is an experiment, not a guaranteed fix.

Changing lead-in reruns separation and detected timing against the padded audio,
so allow additional processing time. It affects the generated take's playback
and exported audio, not just the visible preview. This control is unavailable
with Imported chart sync.

## If a take misses the music you wanted

Try another take or a different audio separation and compare the result. The
separation chooser lets you prepare and audition stems and select the separation
used by a new chart. Different separations can change what transcription picks
up; they do not guarantee an improvement.

Beat This reads the input audio directly in the current implementation. Changing
only the separation does not mean its detected beat grid changes. Changing the
lead-in changes the timing input; importing a sync track bypasses detection.

Sparse passages can be model behavior, but do not assume every missing section
is intentional. Listen to the audio and preview the start, middle, and ending.
An early last note alone does not prove an error: the song may have an outro
with nothing useful to chart.

## Current limits

- The model can omit musical details, leave long gaps, or generate patterns
  that need note edits. Automatic timing can choose the wrong pulse or miss
  tempo changes.
- Transcription currently uses at most **1,280 beat intervals** and has an
  **8,192-token decoding budget**. A long or densely timed song can produce
  an incomplete chart even when generation finishes. These are not fixed
  minute limits: tempo and chart density matter. Check coverage before export.
- The in-app highway is a visual preview. Test actual playability in your game.
- Existing-song import selects one audio file and a subset of metadata. It
  does not preserve arbitrary multistem arrangements or all custom INI options.
- Minimum RAM and representative full-song generation times across computers
  have not been established. CPU is supported, but performance varies.

If GPU generation fails and **Retry using CPU** is offered, that retry keeps
the song and options without changing your saved hardware preference. Hardware
mode is also available in Settings.

## Sharing a result

Listen and playtest before sharing. Keep original charter credit and generated
difficulty labels, and follow the site's rules about generated content.
Autochart adds [provenance metadata](chart-metadata.md) to exports containing
generated notes; it does not upload charts to a chart-sharing service.
