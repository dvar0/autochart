# Export media fixtures

These are synthetic 16×16 red frames, with no third-party media. Generated with
FFmpeg's `color=c=red:s=16x16:r=10` lavfi source:

- `image.gif`: `-frames:v 1`
- `image.webp`: `-frames:v 1 -c:v libwebp -lossless 1`
- `source-vp9.webm`: `-t 0.5 -c:v libvpx-vp9 -pix_fmt yuv420p`
- `source-av1.webm`: `-t 0.5 -c:v libaom-av1 -cpu-used 8 -pix_fmt yuv420p`
- `source-av1-10bit.mp4`: `-t 0.5 -c:v libaom-av1 -cpu-used 8 -pix_fmt yuv420p10le`

The export harness checks actual conversion of GIF/WebP to JPEG and VP9/AV1 to VP8
using the bundled FFmpeg. Fixture generation uses a system FFmpeg; running the
test requires only the bundled build, not these generation encoders.
