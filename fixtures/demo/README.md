# Demo Audio Fixture

`autochart-demo-30s.wav` is an original 30-second procedural music fixture
created for Autochart: a 120 BPM arpeggiated synthesizer, bass, and synthesized
percussion. It contains no downloaded recordings, samples, or third-party
melodies. The score, synthesizer, and generated audio use the repository's
AGPL-3.0-or-later license; the complete preferred source is
[`scripts/create-demo-audio.cjs`](../../scripts/create-demo-audio.cjs).

Regenerate it without dependencies or an audio encoder:

```bash
node scripts/create-demo-audio.cjs
```

Format: 22,050 Hz mono PCM16 WAV. The short fixture keeps CPU smoke tests
manageable. Tests still require note-bearing streamed chart events and a
nonempty final chart. It exercises pipeline behavior, not musical quality;
full-song playtesting in Clone Hero/YARG remains a separate check.
