---
license: cc-by-nc-sa-4.0
tags:
  - onnx
  - audio
  - music
  - clone-hero
  - yarg
model-index:
  - name: Fretformer v1
    results: []
---

# Autochart models — Fretformer v1

This repository contains the FP32 ONNX model pack used by **Autochart** to
generate five-fret guitar charts for Clone Hero and YARG. Inference runs
locally on the user's computer.

## Intended use

Generate draft charts for personal play, including additional difficulty
levels and music with limited chart availability. Generated charts need
human review and may benefit from timing, note, or playability edits.

Fretformer supports Easy, Medium, Hard, and Expert difficulty conditioning,
with controls for speed, chords, technique, movement, and repetition.
These controls guide generation; they do not guarantee a particular result.

## Pipeline and contents

```text
audio → Demucs source separation → Beat This timing → Fretformer → .chart
```

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
runtime contract is `fretformer-v1/manifest.json`; the transcriber export
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

**Fretformer v1 weights and ONNX export:** Autochart contributors,
CC BY-NC-SA 4.0. Noncommercial use, attribution, and share-alike conditions
apply to the Fretformer materials. See `licenses/cc-by-nc-sa-4.0.txt`.

**Demucs / Hybrid Transformer Demucs:** Meta Platforms, Inc. and affiliates,
MIT. Released htdemucs weights were adapted into split ONNX graphs.
Upstream: <https://github.com/facebookresearch/demucs>.

**Beat This!:** Institute of Computational Perception, JKU Linz, Austria,
MIT. The published checkpoint and subsequent Autochart fine-tuning were
exported to ONNX. Upstream: <https://github.com/CPJKU/beat_this>.

The repository's license tag describes Fretformer. Demucs and Beat This
retain their component-specific MIT licenses. See
`licenses/model-pack-attribution.txt` for file coverage, modification notices,
and upstream citations. The Autochart application is separately licensed
under AGPL-3.0-or-later.

No upstream author or institution endorses Autochart.
