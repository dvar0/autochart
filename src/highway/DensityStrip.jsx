import { useEffect, useRef } from "react";

// Note-activity histogram drawn behind a seekbar. Each lane is a chart
// version: bars show notes-per-bin over the song so dense passages (solos,
// spam sections) read at a glance, mirroring what the highway shows up close.
//
// Bins follow the rendered width (one bar per ~4px) instead of a fixed
// musical unit, so the strip stays readable at any timeline size.

function laneBins(notes, duration, binCount, offset = 0) {
  const bins = new Float32Array(binCount);
  if (!notes?.length || !duration) return bins;
  const scale = binCount / duration;
  const laneOffset = Math.max(0, Number(offset) || 0);
  for (const note of notes) {
    const time = note.time + laneOffset;
    if (!Number.isFinite(time) || time < 0) continue;
    const index = Math.min(binCount - 1, Math.floor(time * scale));
    bins[index] += note.frets?.length || 1;
  }
  return bins;
}

function drawLaneBars(ctx, bins, binCount, barWidth, y0, bandHeight, max, color, alpha) {
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  const drawableHeight = Math.max(1, bandHeight - 1);
  for (let i = 0; i < binCount; i++) {
    if (!bins[i]) continue;
    const h = Math.max(1, (bins[i] / max) * drawableHeight);
    ctx.fillRect(i * barWidth + 0.5, y0 + bandHeight - h, Math.max(1, barWidth - 1), h);
  }
}

export default function DensityStrip({ lanes = [], duration = 0, layout = "auto", className = "" }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const drawable = lanes.filter((lane) => lane?.notes?.length);
      if (!drawable.length || !duration) return;

      const binCount = Math.max(24, Math.floor(rect.width / 4));
      const laneData = drawable.map((lane) => laneBins(lane.notes, duration, binCount, lane.offset));
      let max = 0;
      for (const bins of laneData) {
        for (let i = 0; i < bins.length; i++) if (bins[i] > max) max = bins[i];
      }
      if (!max) return;

      const barWidth = rect.width / binCount;
      const themePurple = getComputedStyle(canvas).getPropertyValue("--purple").trim() || "#4a4585";
      const stacked =
        layout === "stacked" || (layout === "auto" && drawable.length > 1);
      const laneGap = stacked ? 1 : 0;
      const laneCount = stacked ? drawable.length : 1;
      const bandHeight = (rect.height - laneGap * (laneCount - 1)) / laneCount;

      laneData.forEach((bins, laneIndex) => {
        const color = drawable[laneIndex].color || themePurple;
        const y0 = stacked ? laneIndex * (bandHeight + laneGap) : 0;
        const alpha = stacked ? 0.82 : 0.7;
        drawLaneBars(ctx, bins, binCount, barWidth, y0, bandHeight, max, color, alpha);
      });
      ctx.globalAlpha = 1;
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [lanes, duration, layout]);

  return (
    <canvas
      ref={canvasRef}
      className={"density-strip" + (className ? ` ${className}` : "")}
      aria-hidden="true"
    />
  );
}
