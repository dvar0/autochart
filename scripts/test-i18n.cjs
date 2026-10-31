#!/usr/bin/env node
// Checks the translations in src/i18n against the English text in the code:
//   - every t("..."), rich("..."), tn(n, "...", "...") and msg("...") has a Spanish and a
//     Portuguese entry
//   - no entry is left over after its English changed or went away
//   - {placeholders} and <tags> match the English
//   - t() only takes plain text (no `${...}`), and no file that uses t() also
//     names something else `t`
// `--report` also lists JSX text that isn't translated yet.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const LANGUAGES = { es: "src/i18n/es.js", "pt-BR": "src/i18n/pt-BR.js" };
const report = process.argv.includes("--report");

function listSources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "i18n" ? [] : listSources(full);
    return /\.(jsx?|mjs)$/.test(entry.name) ? [full] : [];
  });
}

// A JS string literal starting at `start` (a quote). Returns its value and end.
function readString(source, start) {
  const quote = source[start];
  let value = "";
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") {
      const next = source[i + 1];
      value += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i += 1;
    } else if (quote === "`" && char === "$" && source[i + 1] === "{") {
      return { dynamic: true, end: i };
    } else if (char === quote) {
      return { value, end: i + 1 };
    } else {
      value += char;
    }
  }
  return { dynamic: true, end: source.length };
}

function skipSpace(source, i) {
  while (i < source.length && /[\s]/.test(source[i])) i += 1;
  return i;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

const used = new Map(); // key -> [where]
const problems = [];

function use(key, where) {
  if (!used.has(key)) used.set(key, []);
  used.get(key).push(where);
}

for (const file of listSources(SRC)) {
  const source = fs.readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file);
  const call = /(?<![\w$.])(t|tn|msg|rich)\(/g;
  let match;
  while ((match = call.exec(source))) {
    const name = match[1];
    let i = skipSpace(source, match.index + match[0].length);
    const where = `${rel}:${lineOf(source, match.index)}`;
    if (name === "tn") {
      // tn(count, "one", "other")
      let depth = 0;
      for (; i < source.length; i += 1) {
        const char = source[i];
        if ("([{".includes(char)) depth += 1;
        else if (")]}".includes(char)) depth -= 1;
        else if (char === "," && depth === 0) break;
      }
      i = skipSpace(source, i + 1);
      const one = /["'`]/.test(source[i]) ? readString(source, i) : null;
      if (!one || one.dynamic) { problems.push(`${where}: tn() needs plain text for both forms`); continue; }
      i = skipSpace(source, one.end);
      if (source[i] !== ",") { problems.push(`${where}: tn() needs plain text for both forms`); continue; }
      i = skipSpace(source, i + 1);
      const other = /["'`]/.test(source[i]) ? readString(source, i) : null;
      if (!other || other.dynamic) { problems.push(`${where}: tn() needs plain text for both forms`); continue; }
      use(`${one.value}|${other.value}`, where);
      continue;
    }
    if (!/["'`]/.test(source[i])) {
      // t(label): text marked with msg() where it's defined.
      if (name === "msg") problems.push(`${where}: msg() needs plain text`);
      continue;
    }
    const literal = readString(source, i);
    if (literal.dynamic) {
      problems.push(`${where}: ${name}() can't take \`\${...}\`; use t("... {name} ...", { name })`);
      continue;
    }
    if (source[skipSpace(source, literal.end)] === "+") {
      problems.push(`${where}: ${name}() needs the whole text in one string, not "..." + "..."`);
      continue;
    }
    use(literal.value, where);
  }

  // A local `t` would hide the translation function.
  const imported = source.match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*\/i18n(?:\/index\.js)?["']/);
  if (imported && /(^|[\s,])t([\s,]|$)/.test(imported[1])) {
    const shadow = /(?:\b(?:const|let|var)\s+t\b\s*=|\(\s*t\s*[,)]|,\s*t\s*\)|\bt\s*=>|\bfor\s*\(\s*(?:const|let)\s+t\b)/g;
    let hit;
    while ((hit = shadow.exec(source))) {
      problems.push(`${rel}:${lineOf(source, hit.index)}: uses t() and also names something t; rename the local one`);
    }
  }

  if (report) {
    // JSX text with letters that isn't inside {...}: a rough list of what's left.
    const text = />\s*([^<>{}]*[A-Za-z]{2,}[^<>{}]*?)\s*</g;
    let hit;
    while ((hit = text.exec(source))) {
      const value = hit[1].trim();
      if (!value || /^[\w.-]+$/.test(value) && !/[A-Z]/.test(value[0])) continue;
      if (/=>|&&|\|\||===|\)\s*;/.test(value)) continue;
      console.log(`untranslated ${rel}:${lineOf(source, hit.index)}  ${value.slice(0, 70)}`);
    }
  }
}

function tokens(text) {
  return (String(text).match(/\{\w+\}|<\/?\w+>/g) || []).sort().join(" ");
}

(async () => {
  let missingTotal = 0;
  for (const [language, file] of Object.entries(LANGUAGES)) {
    const dictionary = (await import(path.join(ROOT, file))).default;
    const missing = [];
    for (const [key, where] of used) {
      const entry = dictionary[key];
      const plural = key.includes("|") && Array.isArray(entry);
      if (entry == null || entry === "") {
        missing.push(`${key}  (${where[0]})`);
        continue;
      }
      if (key.includes("|") && !plural) problems.push(`${file}: "${key}" is a plural and needs [one, other]`);
      if (!key.includes("|") && typeof entry !== "string") problems.push(`${file}: "${key}" should be text`);
      const english = key.includes("|") ? key.split("|") : [key];
      const forms = plural ? entry : [entry];
      forms.forEach((form, index) => {
        const expected = tokens(english[Math.min(index, english.length - 1)]);
        if (tokens(form) !== expected) problems.push(`${file}: "${key}" has ${tokens(form) || "no placeholders"}, English has ${expected || "none"}`);
      });
    }
    for (const key of Object.keys(dictionary)) {
      if (!used.has(key)) problems.push(`${file}: "${key}" isn't used anymore`);
    }
    missingTotal += missing.length;
    if (missing.length) {
      console.log(`${language}: ${missing.length} missing`);
      missing.forEach((line) => console.log(`  ${line}`));
    }
  }
  problems.forEach((line) => console.log(line));
  if (missingTotal || problems.length) {
    console.log(`i18n check failed: ${missingTotal} missing, ${problems.length} other problems (${used.size} texts in use)`);
    process.exit(1);
  }
  console.log(`i18n check passed (${used.size} texts in use)`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
