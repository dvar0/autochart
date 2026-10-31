import { useEffect, useState } from "react";
import useCoverArt from "./useCoverArt.js";
import {
  accentForTint,
  cachedCoverColor,
  extractCoverColor,
  normalizeAccent,
  tintIsDark,
} from "../lib/coverColor.js";

// Effective card surface per theme (mirrors --surface in styles.css). Used to
// decide whether the accent-tinted card reads as dark, so text can flip ink.
const CARD_SURFACE = { light: "#f7f7ff", dark: "#313a52" };

// Resolve a song's accent color: a real cover image gives its sampled dominant
// color once extracted (cached, so it's instant on later renders); a song
// without one uses its generated cover's main ink once that has drawn.
// Also reports whether the tinted card is dark, so text picks readable ink.
export default function useCoverAccent(song, theme = "light") {
  const generated = useCoverArt(song.cover ? null : song.artSeed);
  const fallback = generated?.accent || "#6860b5";
  // Store the raw extracted/palette color; normalize per theme below so a theme
  // toggle re-tames the accent without re-sampling the cover.
  const [raw, setRaw] = useState(
    () => (song.cover && cachedCoverColor(song.cover)) || fallback
  );
  useEffect(() => {
    let alive = true;
    if (song.cover) {
      extractCoverColor(song.cover).then((c) => {
        if (alive && c) setRaw(c);
      });
    } else {
      setRaw(fallback);
    }
    return () => {
      alive = false;
    };
  }, [song.cover, fallback]);
  const accent = normalizeAccent(raw, theme);
  const surface = CARD_SURFACE[theme] || CARD_SURFACE.light;
  const dark = tintIsDark(accent, surface) ?? theme === "dark";
  // A chroma-floored accent for tinting a plane and its tiles, so pale/pastel
  // covers still read as color instead of muddy grey. Cards keep using the
  // tamer `accent`.
  const tint = accentForTint(raw, theme);
  return { accent, dark, tint };
}
