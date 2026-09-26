import labels from "../../config/human-labels.json" with { type: "json" };

export const COMPONENT_LABELS = Object.freeze({ ...(labels.components || {}) });
export const GENERATOR_LABELS = Object.freeze({ ...(labels.generators || {}) });
export const STATUS_LABELS = Object.freeze({ ...(labels.statuses || {}) });

export function humanLabel(group, key, fallback = key) {
  return String(labels[group]?.[key] || fallback);
}
