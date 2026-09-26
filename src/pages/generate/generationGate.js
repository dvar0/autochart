export function isUnsupportedGenerationTarget(status = {}) {
  return status?.supportedPlatform === false && status?.platform !== "browser";
}

export function generationGateState(status = {}) {
  const unsupported = isUnsupportedGenerationTarget(status);
  const ready = Boolean(status?.ready);
  return {
    unsupported,
    showSetupCta: !unsupported && !ready,
    message: status?.message || status?.error || "Chart generation needs setup before it can run.",
  };
}
