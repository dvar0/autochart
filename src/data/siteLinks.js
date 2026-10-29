// Where the browser version links out to: the hub site, the code, and the
// privacy page that lists what the usage counts send.
// VITE_AUTOCHART_HUB_URL points them at another copy of the hub (a preview).
const HUB = (import.meta.env?.VITE_AUTOCHART_HUB_URL || "https://autochart.org").replace(/\/+$/, "");

export const SITE_LINKS = Object.freeze({
  hub: HUB || "/",
  repo: "https://github.com/dvar0/autochart",
  privacy: `${HUB}/privacy`,
});
