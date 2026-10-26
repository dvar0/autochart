---
license: cc-by-nc-sa-4.0
tags:
  - onnx
  - audio
  - music
  - clone-hero
  - yarg
model-index:
  - name: Fretformer 2
    results: []
  - name: Fretformer 2 Lite
    results: []
  - name: Fretformer v1
    results: []
---

# Autochart models — Fretformer 2 and Fretformer v1

This repository contains the FP32 ONNX model packs used by **Autochart** to
generate five-fret guitar charts for Clone Hero and YARG. Inference runs
locally on the user's computer.

| Folder | Model | Used for |
| --- | --- | --- |
| `fretformer-v2/` | Fretformer 2 | Writing charts (recommended) |
| `fretformer-v2-inpaint/` | Fretformer 2 Fill-in | Redoing the bars you pick, comes with Fretformer 2 |
| `fretformer-v2-lite/` | Fretformer 2 Lite | Experimental: faster, less accurate, with its own fill-in |
| `fretformer-v1/` | Fretformer v1 | The first model |

Each folder is complete on its own. Folders share some graphs byte for byte
(Beat This and the transcriber's mel features); Autochart downloads each
shared file once and copies it.

## Intended use

Generate draft charts for personal play, including additional difficulty
levels and music with limited chart availability. Generated charts need
human review and may benefit from timing, note, or playability edits.

Fretformer supports Easy, Medium, Hard, and Expert difficulty conditioning.
Fretformer v1 has controls for speed, chords, technique, movement, and
repetition; Fretformer 2 for speed, chords, HOPOs, taps, and movement, and it
also places solo and section markers. Fill-in rewrites picked bars to fit the
chart around them. These controls guide generation; they do not guarantee a
particular result.

## Pipeline and contents

```text
audio → Demucs source separation → Beat This timing → Fretformer → .chart
```

Fretformer 2 separates with Demucs' six-source `htdemucs_6s` model (piano is
summed into other) and reads six channels: the full mix, drums, bass, vocals,
guitar, and other. Demucs' STFT runs in Autochart's code, so the Fretformer 2
folders hold only Demucs' core network.

`fretformer-v2/` holds 9 files (approximately 501 MB); `fretformer-v2-inpaint/`
holds the same kinds of files plus `fim_decoder_fp32.onnx`, the fill-in
decoder (10 files, approximately 666 MB). Downloaded together they come to
about 952 MB, since shared files download once.

`fretformer-v2-lite/` reads only the full mix, so it has no Demucs graphs and
skips separation. It holds Beat This, the transcriber's mel features, an
encoder, a decoder, a fill-in decoder and its prefix tables (9 files,
approximately 555 MB; about 452 MB beyond Fretformer 2's shared files).

The `fretformer-v1/` directory contains 11 files (approximately 693 MB):

| Component | Files | Purpose |
| --- | --- | --- |
| Demucs | `demucs_analysis_stft.onnx`, `demucs_core_network.onnx`, `demucs_synthesis_istft.onnx` | Instrument separation |
| Beat This | `beat_this_mel_fp32.onnx`, `beat_this_core_fp32.onnx` | Beat and downbeat detection |
| Fretformer | `transcriber_mel_fp32.onnx`, `encoder_fp32.onnx`, `decoder_step_fp32.onnx`, `prefix_tables.npz` | Features, chart tokens, and conditioning |
| Descriptors | `manifest.json`, `transcriber_manifest.json` | Graph and model configuration |

`SHA256SUMS.txt` records the file hashes. Attribution and full license texts
are in `licenses/`.

## Usage

Use this pack through Autochart's model setup. Autochart downloads the files,
checks their sizes and SHA-256 hashes against its bundled catalog, and runs
the pipeline using ONNX Runtime. Audio stays on the local machine during
generation. A Hugging Face account is not required to download this public,
ungated pack.

The pack requires application-side audio preparation, chunking, timing
postprocessing, autoregressive decoding, and chart writing. The primary
runtime contract is each folder's `manifest.json`; the transcriber export
descriptor is supplementary. This is a custom pipeline rather than a
Transformers `from_pretrained` model.

For integrations, preserve the primary manifest's input names, shapes,
normalization, fixed chunk sizes, and conditioning contract. Use a pinned
repository commit with the matching application catalog.

## Limitations

- Timing detection can select an unsuitable metrical level or miss changes.
- Generated notes can omit musical details or produce awkward patterns.
- Difficulty conditioning does not replace human difficulty assessment.
- Results and runtime depend on the audio, settings, and execution provider.
- GPU acceleration depends on ONNX Runtime and driver support; Autochart
  supports CPU fallback.

## Licenses and attribution

**Fretformer 2, Fretformer 2 Fill-in, Fretformer 2 Lite, and Fretformer v1
weights and ONNX exports:** Autochart contributors, CC BY-NC-SA 4.0. Noncommercial use,
attribution, and share-alike conditions apply to the Fretformer materials.
See `licenses/cc-by-nc-sa-4.0.txt`.

**Demucs / Hybrid Transformer Demucs:** Meta Platforms, Inc. and affiliates,
MIT. Released htdemucs and htdemucs_6s weights were adapted into split ONNX
graphs.
Upstream: <https://github.com/facebookresearch/demucs>.

**Beat This!:** Institute of Computational Perception, JKU Linz, Austria,
MIT. The published checkpoint and subsequent Autochart fine-tuning were
exported to ONNX. Upstream: <https://github.com/CPJKU/beat_this>.

The repository's license tag describes Fretformer. Demucs and Beat This
retain their component-specific MIT licenses. See
`licenses/fretformer-2-attribution.txt` (Fretformer 2 and Lite) and
`licenses/model-pack-attribution.txt` (Fretformer v1) for file coverage,
modification notices, and upstream citations. The Autochart application is separately licensed
under AGPL-3.0-or-later.

No upstream author or institution endorses Autochart.
