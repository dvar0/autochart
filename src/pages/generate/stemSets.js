// The stems each separation model makes, as the Separation tab shows them.
//   htdemucs (Fretformer 1): four stems, guitar inside "other";
//   htdemucs_6s (Fretformer 2): guitar split out, piano inside "other".
import { msg } from "../../i18n/index.js";
import { STEM_COLORS } from "../../data/notePalette.js";

const GUITAR = { id: "guitar", label: msg("Guitar"), color: STEM_COLORS.guitar };
const OTHER = { id: "other", label: msg("Other"), color: STEM_COLORS.other };
const DRUMS = { id: "drums", label: msg("Drums"), color: STEM_COLORS.drums };
const BASS = { id: "bass", label: msg("Bass"), color: STEM_COLORS.bass };
const VOCALS = { id: "vocals", label: msg("Vocals"), color: STEM_COLORS.vocals };

const ROWS = {
  htdemucs: [{ ...OTHER, label: msg("Guitar / other"), color: STEM_COLORS.guitar }, DRUMS, BASS, VOCALS],
  htdemucs_6s: [GUITAR, OTHER, DRUMS, BASS, VOCALS],
};

export function stemRowsFor(stemSetId) {
  return ROWS[stemSetId] || ROWS.htdemucs_6s;
}

export { stemParts } from "./stemTables.js";

// Several stems heard together go by their ids joined with "+", in row order.
export function stemCombo(ids, rows) {
  return rows.filter((row) => ids.includes(row.id)).map((row) => row.id).join("+");
}
