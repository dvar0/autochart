// Padded, accented English: any text that still reads plainly wasn't sent
// through t(), and the extra length shows where Spanish and Portuguese would
// clip. Placeholders ({name}) and tags (<b>) are kept as they are.
const ACCENTS = {
  a: "á", e: "é", i: "í", o: "ó", u: "ú", n: "ñ", c: "ç", y: "ý",
  A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú", N: "Ñ", C: "Ç", Y: "Ý",
};

export function pseudo(text) {
  const parts = String(text).split(/(\{\w+\}|<\/?\w+>)/);
  let letters = 0;
  const body = parts.map((part, index) => {
    if (index % 2) return part;
    letters += part.replace(/\s/g, "").length;
    return part.replace(/[a-zA-Z]/g, (char) => ACCENTS[char] || char);
  }).join("");
  // Spanish and Portuguese run 20-30% longer than English.
  const pad = "~".repeat(Math.ceil(letters * 0.3));
  return `[${body}${pad}]`;
}
