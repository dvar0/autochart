/** Ignore Windows leave-full-screen noise while a setFullscreen(true) is in flight. */
export const PENDING_ENTER_MS = 500;
/** Re-query window fullscreen before treating a leave event as real. */
export const LEAVE_CONFIRM_MS = 50;

/**
 * DOM fullscreenchange must not clobber Electron overlay state.
 * Apply it only when this surface is the HTML fullscreen element, or when
 * this hook previously called requestFullscreen and is now exiting.
 */
export function shouldApplyBrowserFullscreenChange({ targetIsFullscreen, browserOwned } = {}) {
  if (targetIsFullscreen) return true;
  return Boolean(browserOwned);
}

/** Spurious Windows leave-full-screen must not drop overlay or ownership. */
export function shouldIgnoreElectronLeave({ pendingEnter, windowStillFullscreen } = {}) {
  return Boolean(pendingEnter || windowStillFullscreen);
}

/** If a leave event raced the overlay off, restore it once enter is confirmed. */
export function shouldRestoreOverlayOnElectronEnter({ electronOwned, overlayActive } = {}) {
  return Boolean(electronOwned) && !overlayActive;
}
