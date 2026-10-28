// The cover written into Clone Hero / YARG song folders. The games stretch
// album art to a square, so a wide cover (a video's frame) is center-cropped
// the way the library shows it, and a song without one gets its generated
// cover instead of a blank tile.
import { coverArtSeed, renderCoverArt } from "./render.js";

const GENERATED_SIZE = 512;
const MAX_SIZE = 1024;

// Returns { name, blob } for the song folder, or null when the song's own
// cover is already square (or can't be decoded) and goes in unchanged.
export async function exportCover(albumBlob, meta = {}) {
  if (!albumBlob) {
    const { canvas } = renderCoverArt(coverArtSeed(meta.title, meta.artist), GENERATED_SIZE);
    return { name: "album.png", blob: await encode(canvas, "image/png") };
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(albumBlob);
  } catch {
    return null;
  }
  const { width, height } = bitmap;
  const side = Math.min(width, height);
  if (!side || Math.abs(width - height) <= side * 0.01) {
    bitmap.close();
    return null;
  }
  const size = Math.min(side, MAX_SIZE);
  const canvas = makeCanvas(size);
  canvas.getContext("2d").drawImage(bitmap, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  const png = albumBlob.type === "image/png";
  return {
    name: png ? "album.png" : "album.jpg",
    blob: await encode(canvas, png ? "image/png" : "image/jpeg"),
  };
}

function makeCanvas(size) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(size, size);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  return canvas;
}

function encode(canvas, type) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality: 0.92 });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Cover encode failed."))), type, 0.92);
  });
}
