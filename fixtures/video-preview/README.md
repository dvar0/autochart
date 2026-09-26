# Video preview conversion fixture

`source-mpeg4-aac.mp4` is ten seconds of synthetic moving test patterns and a
440 Hz sine tone. It contains no third-party media. MPEG-4 Part 2 video requires
the real compatibility conversion in the tested Windows Electron build, while
AAC audio can initialize the comparison player before that conversion finishes.
The moving, nonblank image and duration support thumbnail and delayed-seek checks.

Run `npm run test:video-preview` to use this fixture. An explicit video path is
still accepted. The harness rejects natively playable inputs before running its
conversion assertions; it never forces the decoder check to fail artificially.

Generated with FFmpeg 7.1 from imageio-ffmpeg 0.6.0's Windows wheel:

```sh
ffmpeg -nostdin -hide_banner -loglevel error -n \
  -f lavfi -i 'testsrc2=size=160x90:rate=12:duration=10' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=10' \
  -map_metadata -1 -c:v mpeg4 -q:v 6 -pix_fmt yuv420p \
  -c:a aac -b:a 48k -shortest -movflags +faststart source-mpeg4-aac.mp4
```

The generation-only tool is not shipped with Autochart. Running the regression
uses Autochart's bundled LGPL FFmpeg to create and decode the VP8 preview.
