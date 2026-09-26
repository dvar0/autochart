import { useEffect, useRef } from "react";
import { drawStageSignal, inkIsLight, parseInk } from "./stageSignal.js";

// These visuals are purely decorative — they never touch real audio, so they
// add zero latency to the engine work running behind them.

const MODES = {
  prep: { split: 0, grid: 0, prep: true },
  split: { split: 1, grid: 0 },
  beat: { split: 0, grid: 1 },
};

// One picture for every pre-note wait. `prep` brings the song in to the prism
// (reading audio); `split` fans it out into stems (separation); `beat` turns
// the prism into a metronome (timing and model warm-up). Keep the same element
// mounted across mode changes and the new state flows out of the gate. The
// beam colour comes from CSS `color`.
export function StageSignal({ mode = "split", size = "board", className = "" }) {
  const canvasRef = useRef(null);
  const clockRef = useRef({ born: null, history: [] });
  const redrawRef = useRef(null);

  useEffect(() => {
    const clock = clockRef.current;
    const t = clock.born === null ? 0 : (performance.now() - clock.born) / 1000;
    clock.history = [...clock.history, { t, ...(MODES[mode] || MODES.split) }];
    redrawRef.current?.();
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return undefined;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const clock = clockRef.current;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
    };

    const draw = (now) => {
      if (clock.born === null) clock.born = now;
      if (width <= 0 || height <= 0) return;
      const ink = parseInk(getComputedStyle(canvas).color);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawStageSignal(ctx, {
        width,
        height,
        size,
        // Reduced motion: one settled frame of the current mode.
        time: reduced ? 20 : (now - clock.born) / 1000,
        history: reduced ? [{ ...clock.history[clock.history.length - 1], t: -Infinity }] : clock.history,
        ink,
        dark: inkIsLight(ink),
      });
    };

    const loop = (now) => {
      draw(now);
      raf = requestAnimationFrame(loop);
    };

    resize();
    const observer = new ResizeObserver(() => {
      resize();
      if (reduced) draw(performance.now());
    });
    observer.observe(canvas);
    if (reduced) {
      redrawRef.current = () => draw(performance.now());
      draw(performance.now());
    } else {
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      redrawRef.current = null;
    };
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      className={`stage-signal stage-signal-${size}${className ? " " + className : ""}`}
      aria-hidden="true"
    />
  );
}

// Standalone separation (busyAction === "separating"): the split signal plus
// its own status footer.
export function StemSeparationStage() {
  return (
    <div className="live-gen-stage">
      <div className="live-stage-board">
        <StageSignal mode="split" />
      </div>
      <div className="live-stage-status">
        <div className="live-stage-status-row">
          <span className="live-rec"><i aria-hidden="true" />SPLIT</span>
          <div className="live-stage-status-main">
            <b>Separating stems</b>
          </div>
        </div>
        <div className="gen-progressbar sm" aria-hidden="true">
          <i className="indeterminate" />
        </div>
      </div>
    </div>
  );
}
