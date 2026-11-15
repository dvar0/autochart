// Shared chart-note colors. Keep visual chart surfaces aligned: live generation,
// editing, stage animation, and the highway all use this palette.
export const FRET_COLORS = Object.freeze([
  "#21d07a", // green
  "#e2464a", // red
  "#f2c531", // yellow
  "#3a8ee6", // blue
  "#f08a3c", // orange
]);

export const OPEN_NOTE_COLOR = "#a66be3";

// Each stem's color wherever stems are drawn (the live board, the Separation
// stage's stem graphs), from the fret colors.
export const STEM_COLORS = Object.freeze({
  vocals: FRET_COLORS[1],
  guitar: FRET_COLORS[4],
  other: FRET_COLORS[2],
  bass: FRET_COLORS[0],
  drums: FRET_COLORS[3],
});
export const MIX_GRAPH_COLOR = "#c3cbe6";
