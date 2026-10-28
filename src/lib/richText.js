// Unity rich text, as Clone Hero and YARG read it in song.ini fields: charters
// often write their name as <color=#FFDE2B>R</color><color=#...>... Parsed
// into styled runs for display; the stored string is never changed.

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NAMED_COLORS = new Set([
  "aqua", "black", "blue", "brown", "cyan", "darkblue", "fuchsia", "green", "grey", "gray",
  "lightblue", "lime", "magenta", "maroon", "navy", "olive", "orange", "purple", "red",
  "silver", "teal", "white", "yellow",
]);
const STYLE_TAGS = { b: "b", i: "i", u: "u", s: "s" };
// Tags the games understand but that change nothing we draw: dropped, text kept.
const IGNORED_TAGS = new Set([
  "size", "font", "material", "quad", "sprite", "align", "alpha", "cspace", "indent",
  "line-height", "line-indent", "link", "lowercase", "uppercase", "smallcaps", "allcaps",
  "mark", "mspace", "nobr", "page", "pos", "rotate", "space", "sub", "sup", "voffset",
  "width", "gradient", "style", "margin", "margin-left", "margin-right", "font-weight",
]);
const TAG = /<(\/?)(#[0-9a-f]+|[a-z][a-z-]*)(?:=("[^"]*"|'[^']*'|[^>]*))?>/gi;

function colorValue(raw) {
  const value = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (HEX.test(value)) return value;
  if (NAMED_COLORS.has(value.toLowerCase())) return value.toLowerCase();
  return null;
}

// [{ text, color, b, i, u, s }], adjacent runs with the same look merged.
// Unknown tags stay as text, like the games show them ("<3", "Name <Team>").
export function parseRichText(input) {
  const source = String(input ?? "");
  const runs = [];
  const colors = [];
  const depth = { b: 0, i: 0, u: 0, s: 0 };
  let noparse = false;

  const push = (text) => {
    if (!text) return;
    const run = {
      text,
      color: colors.length ? colors[colors.length - 1] : null,
      b: depth.b > 0, i: depth.i > 0, u: depth.u > 0, s: depth.s > 0,
    };
    const last = runs[runs.length - 1];
    if (last && last.color === run.color && last.b === run.b && last.i === run.i && last.u === run.u && last.s === run.s) {
      last.text += text;
    } else {
      runs.push(run);
    }
  };

  let at = 0;
  for (const match of source.matchAll(TAG)) {
    const [whole, slash, rawName, value] = match;
    const name = rawName.toLowerCase();
    const closing = slash === "/";
    if (noparse && !(closing && name === "noparse")) continue;
    push(source.slice(at, match.index));
    at = match.index + whole.length;

    if (name === "noparse") {
      noparse = !closing;
    } else if (name === "br") {
      push(" ");
    } else if (name === "color" || name.startsWith("#")) {
      if (closing) colors.pop();
      else colors.push(colorValue(name === "color" ? value : name));
    } else if (STYLE_TAGS[name]) {
      if (value !== undefined) push(whole);
      else depth[name] = Math.max(0, depth[name] + (closing ? -1 : 1));
    } else if (!IGNORED_TAGS.has(name)) {
      push(whole);
    }
  }
  push(source.slice(at));
  return runs;
}

export function plainText(input) {
  return parseRichText(input).map((run) => run.text).join("");
}
