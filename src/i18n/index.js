// Translations. The English text is the key, so code reads as it shows:
//
//   t("Generate chart")
//   t("Saved to {folder}", { folder })
//   tn(count, "{count} song", "{count} songs")
//
// es.js and pt-BR.js map English to each language; a missing entry shows the
// English. Text kept in data files is marked with msg("...") so the checker
// (scripts/test-i18n.cjs) finds it, and translated with t(label) where it's
// shown. Run `npm run test:i18n` after changing any English text.
import { Fragment, createElement, useSyncExternalStore } from "react";
import es from "./es.js";
import ptBR from "./pt-BR.js";
import { pseudo } from "./pseudo.js";

// Each language is listed in its own name.
export const LANGUAGES = Object.freeze([
  { id: "en", name: "English" },
  { id: "es", name: "Español" },
  { id: "pt-BR", name: "Português (Brasil)" },
]);
export const LANGUAGE_PREFERENCES = Object.freeze(["system", ...LANGUAGES.map((language) => language.id)]);

// "xx" is a padded, accented English for spotting untranslated or clipped
// text. Development builds only: open with ?lang=xx.
const PSEUDO = "xx";
const DICTIONARIES = { es, "pt-BR": ptBR };
const CACHE_KEY = "autochart.language";

export function systemLanguage(languages = globalThis.navigator?.languages || []) {
  for (const tag of languages) {
    const base = String(tag).toLowerCase().split("-")[0];
    if (base === "en") return "en";
    if (base === "es") return "es";
    if (base === "pt") return "pt-BR";
  }
  return "en";
}

function resolve(preference) {
  if (preference === PSEUDO && import.meta.env?.DEV) return PSEUDO;
  return LANGUAGES.some((language) => language.id === preference) ? preference : systemLanguage();
}

function readCachedPreference() {
  try {
    const fromUrl = import.meta.env?.DEV && new URLSearchParams(globalThis.location?.search || "").get("lang");
    if (fromUrl) return fromUrl;
    return globalThis.window?.localStorage?.getItem(CACHE_KEY) || "system";
  } catch {
    return "system";
  }
}

// The saved setting lives with the other settings; this copy in
// localStorage only lets the first frame show the right language.
// The state is shared on globalThis: a dev-server hot reload loads a second
// copy of this module, and both copies must agree on the language.
const state = (globalThis.__autochartLanguage ||= (() => {
  const preference = readCachedPreference();
  return { preference, current: resolve(preference), listeners: new Set() };
})());

function applyDocumentLanguage() {
  if (globalThis.document) document.documentElement.lang = state.current === PSEUDO ? "en" : state.current;
}
applyDocumentLanguage();

export function languagePreference() {
  return state.preference;
}

export function currentLanguage() {
  return state.current;
}

export const PSEUDO_AVAILABLE = Boolean(import.meta.env?.DEV);

// `fromSettings` is the saved setting arriving at launch; it doesn't replace
// the padded test language picked in a development build.
export function setLanguagePreference(next, { fromSettings = false } = {}) {
  if (fromSettings && state.preference === PSEUDO) return;
  const value = LANGUAGE_PREFERENCES.includes(next) || (next === PSEUDO && PSEUDO_AVAILABLE) ? next : "system";
  try {
    globalThis.window?.localStorage?.setItem(CACHE_KEY, value);
  } catch {
    // Only the first frame after a restart depends on it.
  }
  if (value === state.preference) return;
  state.preference = value;
  state.current = resolve(value);
  applyDocumentLanguage();
  state.listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

function fill(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

function lookup(key) {
  if (state.current === "en") return undefined;
  if (state.current === PSEUDO) return undefined;
  return DICTIONARIES[state.current]?.[key];
}

export function t(text, vars) {
  if (text == null || text === "") return text;
  const found = lookup(text);
  const out = typeof found === "string" ? found : text;
  return fill(state.current === PSEUDO ? pseudo(out) : out, vars);
}

// Plurals: the key is "one|other". Spanish and Portuguese use the same two
// forms; Intl picks which one a count takes in each language.
export function tn(count, one, other, vars) {
  const all = { count, ...vars };
  const found = lookup(`${one}|${other}`);
  const forms = Array.isArray(found) ? found : [one, other];
  const rule = new Intl.PluralRules(state.current === PSEUDO ? "en" : state.current).select(Number(count));
  const out = rule === "one" ? forms[0] : forms[1];
  return fill(state.current === PSEUDO ? pseudo(out) : out, all);
}

// Text with markup, kept as one sentence so it can be reordered:
//   rich("Turn it on in <code>about:config</code>", { code: (text) => <code>{text}</code> })
export function rich(text, tags = {}, vars) {
  const parts = t(text, vars).split(/<(\w+)>(.*?)<\/\1>/s);
  const children = [];
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i]) children.push(parts[i]);
    if (i + 1 < parts.length) {
      const render = tags[parts[i + 1]];
      children.push(render ? render(parts[i + 2]) : parts[i + 2]);
    }
  }
  return createElement(Fragment, null, ...children);
}

// Marks English kept in data files for translation where it's shown.
export const msg = (text) => text;

// Components call this to redraw when the language changes.
export function useLanguage() {
  return useSyncExternalStore(subscribe, currentLanguage, currentLanguage);
}

// Number and date formatting in the current language.
export function formatNumber(value, options) {
  return new Intl.NumberFormat(state.current === PSEUDO ? "en" : state.current, options).format(value);
}

export function formatDate(value, options) {
  return new Date(value).toLocaleString(state.current === PSEUDO ? "en" : state.current, options);
}
