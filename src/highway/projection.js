// Projection geometry for the five-lane note highway.
import { FRET_COLORS } from "../data/notePalette.js";

export const LANE_COUNT = FRET_COLORS.length;
export const LANE_COLORS = FRET_COLORS;
// Builds a projector for a given canvas size. Returns geometry helpers in CSS
// pixels. `lookAhead` is how many seconds of chart are visible from the strike
// line to the horizon — effectively the scroll speed.
export function createProjection(width, height, lookAhead = 1.4, zMax = 1.75) {
  // Cap the board's *design* size. On a large/fullscreen canvas the raw
  // dimensions would make the board both oversized and steeply raked (it would
  // span 20%→90% of a 1080p+ height). Clamping to a comfortable design area and
  // centering it keeps the highway a sane size and angle on big screens, while
  // smaller embedded canvases (below the caps) are left exactly as before.
  const designH = Math.min(height, 720);
  // Keep the board from stretching too wide on landscape canvases. A wide board
  // fans the outer lanes far from the vanishing point, so notes sweep diagonally
  // (down *and* outward) and read as faster — even though the actual timing is
  // fixed by lookAhead and never changes with resolution. Capping the width to a
  // modest multiple of the runway height holds the steeper, calmer proportion at
  // any size, the same look you get by hand when narrowing the window. The board
  // stays centered automatically since it's built around centerX = width / 2.
  const maxAspect = 1.25;
  const designW = Math.min(width, 1000, designH * maxAspect);
  const offsetY = (height - designH) / 2;

  const centerX = width / 2;
  const horizonY = offsetY + designH * 0.2;

  // Half-width of the playable board at the strike line.
  const halfWidthNear = designW * 0.35;
  const laneSpacingNear = (halfWidthNear * 2) / LANE_COUNT;
  const gemRadiusNear = laneSpacingNear * 0.4;

  const baseStrikeY = offsetY + designH * 0.8;
  const maxStrikeY = height - gemRadiusNear * 0.75;
  const strikeY =
    maxStrikeY > baseStrikeY ? baseStrikeY + (maxStrikeY - baseStrikeY) * 0.6 : baseStrikeY;

  // Distance into the scene at the horizon (passed in). Larger = more dramatic
  // perspective: notes accelerate harder as they near the strike line. The speed
  // ratio between the strike line and the horizon is (1 + zMax)^2 — at the old
  // 4.5 a note whipped through the hit zone ~30x faster than it crawled at the
  // horizon, which read as too fast. The default 1.75 flattens the rake to a
  // ~7.6x ratio so notes approach at a much more even pace. Lower it further to
  // flatten more; raise it for a steeper, more dramatic (faster-feeling) board.
  const focal = 1;
  const scaleFar = focal / (focal + zMax);

  // Lane center x at the near (strike) plane, before perspective scaling.
  function laneCenterNear(lane) {
    return centerX + (lane + 0.5 - LANE_COUNT / 2) * laneSpacingNear;
  }

  // depth (seconds ahead of playhead, normalized by lookAhead) -> screen scale + y.
  function project(d) {
    const z = d * zMax;
    const scale = focal / (focal + z);
    const y = horizonY + ((strikeY - horizonY) * (scale - scaleFar)) / (1 - scaleFar);
    return { scale, y };
  }

  // Inverse of project()'s y mapping (y is linear in scale). Used to extend the
  // board/lanes below the strike line to the bottom edge of the canvas so the
  // highway runs off-screen instead of ending in a visible horizontal cut.
  function scaleForY(y) {
    return scaleFar + ((y - horizonY) * (1 - scaleFar)) / (strikeY - horizonY);
  }

  // Convenience: seconds-ahead-of-now -> depth fraction.
  function depthForTime(noteTime, songTime) {
    return (noteTime - songTime) / lookAhead;
  }

  // Screen position + size for a note at the given lane and depth.
  function place(lane, d) {
    const { scale, y } = project(d);
    const x = centerX + (laneCenterNear(lane) - centerX) * scale;
    return { x, y, scale };
  }

  return {
    width,
    height,
    centerX,
    horizonY,
    strikeY,
    lookAhead,
    laneSpacingNear,
    halfWidthNear,
    scaleFar,
    laneCenterNear,
    project,
    scaleForY,
    depthForTime,
    place,
    // Note gem radius at the near plane (scaled by perspective at draw time).
    gemRadiusNear,
  };
}
