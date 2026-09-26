# Generated-chart metadata

Autochart labels generated guitar charts automatically. The Details panel lets
users set the musical genre; AI generation is not a genre. Generated exports
use `Autochart` as their charter. Mixed exports preserve the imported credit
and add Autochart. The charter field is read-only in the app.

Exports containing generated guitar notes include these fields in `song.ini`
and the `[Song]` section of `notes.chart` (quoted values in `.chart`):

```ini
autochart_provenance_version = 1
autochart_ai_generated = true
autochart_generated_difficulties = easy,medium
autochart_generator = autochart.fretformer.v1-onnx
```

These are Autochart-specific fields, not a community standard. The difficulty
list identifies generated five-fret guitar difficulty sections in this export,
including sections subsequently edited by a person. It does not claim that the
audio, artwork, or other instrument tracks were generated. Generator IDs are
comma-separated when multiple generators contributed and omitted if unknown
(for example, some older saved takes).

`song.ini` also includes a readable `loading_phrase` explaining which guitar
difficulties contain generated notes. Handmade-only exports receive no AI
marker, including handmade charts edited or assembled in Autochart. Origin
information survives normal save, edit, final-chart assembly, export and
re-import operations. Older edited charts with missing lineage and no generator
information cannot always be classified.

These labels are editable metadata, not a watermark, signature, or proof of
authorship. Sites must explicitly support these custom fields to filter by
them. No registration, network requests, user identifiers, local paths, note
changes, or gameplay processing are added by this feature.

Run `npm run test:chart-metadata` for metadata, mixed difficulty, edit lineage,
export/re-import, and note/timing preservation regressions.
