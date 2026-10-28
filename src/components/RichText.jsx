import { memo } from "react";
import { parseRichText, plainText } from "../lib/richText.js";

// A song.ini field drawn the way the games draw it (charter names in color).
// Colors are nudged lighter or darker in CSS so they stay readable on either
// theme; see .rich-text in styles.css.
const RichText = memo(function RichText({ value, className = "" }) {
  const runs = parseRichText(value);
  return (
    <span className={"rich-text" + (className ? ` ${className}` : "")} title={plainText(value) || undefined}>
      {runs.map((run, index) => {
        const classes = [run.b && "rt-b", run.i && "rt-i", run.u && "rt-u", run.s && "rt-s"].filter(Boolean).join(" ");
        return (
          <span
            key={index}
            className={classes || undefined}
            data-color={run.color ? "" : undefined}
            style={run.color ? { "--rt-color": run.color } : undefined}
          >
            {run.text}
          </span>
        );
      })}
    </span>
  );
});

export default RichText;
