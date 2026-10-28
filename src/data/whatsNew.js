// Shown once after an update, newest first, in the release window
// (components/ReleaseCard.jsx). Written for people who use the app, not the
// release notes. Most important first:
//   headline, sub   the big thing, and one line under it
//   image           optional hero picture (an imported file); else the highway
//   features        { icon, title, text, image? } as short rows; icon names
//                   come from src/icons.jsx
//   fixes           smaller changes and fixes, one line each, folded after four
//   notesUrl        where "Full release notes" goes
//   action          the window's one button; "install-model" downloads that
//                   model family right there, or say it's ready
// The update notice before updating shows the same parts from update.json.
export const WHATS_NEW = Object.freeze([
  {
    version: "0.2.0",
    headline: "Fretformer 2 is here",
    sub: "A new model that charts more like a person, with solos and sections.",
    features: [
      { icon: "spark", title: "Inpaint", text: "Pick some bars and generate just those again." },
      { icon: "pencil", title: "Edit by hand", text: "Move, add and delete notes on the Edit tab." },
      { icon: "music", title: "Tighter timing", text: "Beats land on the drums far more often. Old takes keep theirs." },
      { icon: "folder", title: "Projects come back", text: "Exports carry the project, so a song opens again with all its takes." },
      { icon: "image", title: "Covers for every song", text: "Songs without album art get one of their own." },
    ],
    fixes: [
      "Style faders and more settings on Generate.",
      "Drop song folders on the Library to bring them in.",
      "Space plays and pauses on the Generate page.",
      "Separations take far less room. Keep separated stems in Settings keeps them.",
      "Exports use square album art.",
      "Opening a project no longer shows a black screen.",
      "The Library shows what's selected in light mode again.",
    ],
    notesUrl: "https://github.com/dvar0/autochart/releases/tag/v0.2.0",
    action: { kind: "install-model", familyId: "fretformer-2", packId: "fretformer-2" },
  },
]);

function versionParts(value) {
  return String(value || "").split("-")[0].split(".").map((part) => Number(part) || 0);
}

function compare(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0) ? -1 : 1;
  }
  return 0;
}

// Entries after `since`, up to and including `current`.
export function whatsNewBetween(since, current) {
  return WHATS_NEW.filter((entry) => compare(entry.version, since) > 0 && compare(entry.version, current) <= 0);
}
