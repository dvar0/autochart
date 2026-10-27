// Draws generated covers off the main thread so a full library grid stays
// responsive while its placeholders render.
import { renderCoverArt } from "./render.js";

self.onmessage = async ({ data }) => {
  const { id, seed, size } = data;
  try {
    const { canvas, accent } = renderCoverArt(seed, size);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.92 });
    self.postMessage({ id, blob, accent });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
