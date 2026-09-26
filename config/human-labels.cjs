"use strict";

const labels = require("./human-labels.json");

function humanLabel(group, key, fallback = key) {
  return String(labels[group]?.[key] || fallback);
}

module.exports = {
  COMPONENT_LABELS: Object.freeze({ ...(labels.components || {}) }),
  GENERATOR_LABELS: Object.freeze({ ...(labels.generators || {}) }),
  STATUS_LABELS: Object.freeze({ ...(labels.statuses || {}) }),
  humanLabel,
};
