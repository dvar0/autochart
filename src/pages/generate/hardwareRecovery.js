// Only a failed accelerated run can offer CPU recovery. A failed disk read,
// download, model validation, or an already-fallback CPU run needs its own fix.
export function canRetryUsingCpu(run) {
  if (!run?.finishedAt || run.ok || run.canceled || run.hardwareMode === "cpu" || run.runtimeFallback) return false;
  const message = String(run.error || "");
  if (/\b(?:ENOENT|EACCES|ENOSPC|checksum|download)\b|\b(?:audio|model|chart|file|directory)\b[^\n]*(?:missing|not found|unavailable|corrupt)/i.test(message)) return false;
  const provider = /\b(?:webgpu|cuda|cudnn|core\s?ml|metal|dawn|execution provider)\b/i;
  const failure = /\b(?:failed|failure|error|unavailable|unsupported|not available|out of memory|device lost|device was lost)\b/i;
  return provider.test(message) && failure.test(message);
}
