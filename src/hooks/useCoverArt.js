import { useEffect, useState } from "react";
import { peekCoverArt, requestCoverArt } from "../lib/coverArt/index.js";

// The generated cover ({ url, accent }) for a seed, or null while it draws.
// Pass a null seed to skip generation (e.g. when the song has a real cover).
export default function useCoverArt(seed) {
  const [art, setArt] = useState(() => (seed == null ? null : peekCoverArt(seed)));
  useEffect(() => {
    if (seed == null) {
      setArt(null);
      return undefined;
    }
    let alive = true;
    const hit = peekCoverArt(seed);
    setArt(hit);
    if (!hit) {
      requestCoverArt(seed).then(
        (next) => alive && setArt(next),
        () => {}
      );
    }
    return () => {
      alive = false;
    };
  }, [seed]);
  return art;
}
