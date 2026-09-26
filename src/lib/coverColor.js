// Pull a single representative accent color out of an album cover image.
// Used to tint library cards with their art color. Results are cached per URL
// so a grid of covers samples each image at most once.

const cache = new Map(); // url -> "#rrggbb" | null

function toHex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Synchronous peek: returns the cached color if we've already sampled this URL,
// else null. Lets a component render the right color immediately on revisit.
export function cachedCoverColor(url) {
  return url ? cache.get(url) ?? null : null;
}

// Parse #rgb / #rrggbb into [r,g,b] (0..255), or null for anything else
// (e.g. a "var(--purple)" fallback).
export function parseHex(hex) {
  if (typeof hex !== "string") return null;
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// hue 0..1, sat 0..1, light 0..1 -> [r,g,b] 0..255.
function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}

// Tame an accent for dark surfaces: cap saturation (so vivid hues don't read as
// neon) and clamp lightness into a mid band (pulls bright green/pink *down* and
// lifts too-dark hues *up*) so every hue tints the dark card with a consistent,
// muted intensity. Light mode mixes into white and needs no taming, so it's
// returned unchanged.
export function normalizeAccent(hex, theme) {
  if (theme !== "dark") return hex;
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  let [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  s = Math.min(s * 0.85, 0.6);
  l = Math.max(0.36, Math.min(l, 0.55));
  const [r, g, b] = hslToRgb(h, s, l);
  return toHex(r, g, b);
}

// A punchier accent purpose-built for tinting surfaces (the detail rail's plane
// and tonal tiles), as opposed to `normalizeAccent` which only *tames* vivid
// hues for small card washes. The problem it solves: pale, low-chroma covers
// (pastel pink, cream) have so little saturation that mixing them into a surface
// yields a muddy grey — invisible in light mode, murky in dark. So here we floor
// the chroma (guaranteeing real color to mix) and pull lightness into a band
// that reads against the theme's base: a touch deeper than white in light mode,
// mid-toned against the dark plane in dark. Returns the hex unchanged if it
// can't be parsed (e.g. a "var(--purple)" fallback).
export function accentForTint(hex, theme) {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  let [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  // floor chroma so pastels still carry color once diluted into a surface;
  // cap it so an already-neon cover doesn't tint harshly.
  s = Math.max(0.45, Math.min(s, 0.9));
  // pull lightness into a tint-friendly band per theme (mixing into near-white
  // vs the dark plane); this also deepens over-bright pastels so they show.
  l = theme === "dark" ? Math.max(0.42, Math.min(l, 0.6)) : Math.max(0.46, Math.min(l, 0.64));
  const [r, g, b] = hslToRgb(h, s, l);
  return toHex(r, g, b);
}

// WCAG relative luminance (0..1) of a hex color, or null if unparseable.
// Callers use it to choose readable ink over a known background color.
export function relLuminanceHex(hex) {
  const rgb = parseHex(hex);
  return rgb ? relLuminance(rgb) : null;
}

// WCAG relative luminance (0..1) for an [r,g,b] in 0..255.
function relLuminance([r, g, b]) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Given an accent and the surface it's tinted into (at fraction `t`), is the
// resulting card background dark enough to want light text? Returns null when
// the colors can't be parsed, so the caller can fall back to the theme default.
export function tintIsDark(accentHex, surfaceHex, t = 0.25) {
  const a = parseHex(accentHex);
  const s = parseHex(surfaceHex);
  if (!a || !s) return null;
  const mix = a.map((av, i) => s[i] * (1 - t) + av * t);
  return relLuminance(mix) < 0.45;
}

// RGB (0..255) -> hue 0..1, saturation 0..1, lightness 0..1.
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

// Find the cover's dominant *hue*, then a vivid representative of it. Averaging
// raw RGB (or even RGB buckets) loses when one color spans many shades — e.g.
// pink hair ranging from pale highlight to deep magenta scatters across buckets
// and gets out-voted by a concentrated block of near-white skin. Binning by hue
// makes all the pinks vote together. Grey/near-white/near-black pixels carry no
// hue and are excluded; pixels are weighted by chroma² (= how far the color sits
// from the grey axis) so that a *little* white/pastel can't drag the accent toward
// white: chroma peaks on vivid mid-tones and collapses to ~0 for both near-white
// and near-black, where plain saturation would still let a high-lightness pastel
// score points and wash the card out. Truly greyscale covers fall back to a plain
// average. Resolves null on load/CORS failure, so the caller can use the palette
// color.
export function extractCoverColor(url) {
  if (!url) return Promise.resolve(null);
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      let result = null;
      try {
        const N = 32;
        const canvas = document.createElement("canvas");
        canvas.width = N;
        canvas.height = N;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, N, N);
        const { data } = ctx.getImageData(0, 0, N, N);

        const BINS = 30;
        const bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
        let coloredWeight = 0;
        let ar = 0, ag = 0, ab = 0, an = 0; // plain-average fallback

        for (let i = 0; i < data.length; i += 4) {
          const R = data[i], G = data[i + 1], B = data[i + 2], A = data[i + 3];
          if (A < 128) continue;
          ar += R; ag += G; ab += B; an++;
          const [h, s, l] = rgbToHsl(R, G, B);
          // ignore pixels with no meaningful hue
          if (s < 0.18 || l < 0.12 || l > 0.9) continue;
          // chroma (0..1) = how vivid the pixel actually is. Unlike raw
          // saturation it falls off toward white *and* black, so pastels and
          // highlights stop out-voting a deep, fully-saturated hue.
          const chroma = (Math.max(R, G, B) - Math.min(R, G, B)) / 255;
          const w = chroma * chroma; // strongly favor vivid pixels
          const bin = Math.min(BINS - 1, Math.floor(h * BINS));
          const bk = bins[bin];
          bk.w += w; bk.r += R * w; bk.g += G * w; bk.b += B * w;
          coloredWeight += w;
        }

        // Enough colored signal? Use the winning hue bin's chroma-weighted
        // average. Otherwise the cover is essentially greyscale — plain average.
        // (Threshold is lower than for saturation² weighting since chroma² ≤ s².)
        if (coloredWeight > 0.2) {
          let best = bins[0];
          for (const bk of bins) if (bk.w > best.w) best = bk;
          result = toHex(best.r / best.w, best.g / best.w, best.b / best.w);
        } else if (an > 0) {
          result = toHex(ar / an, ag / an, ab / an);
        }
      } catch {
        result = null; // tainted canvas (cross-origin) — fall back to palette
      }
      cache.set(url, result);
      resolve(result);
    };
    img.onerror = () => {
      cache.set(url, null);
      resolve(null);
    };
    img.src = url;
  });
}
