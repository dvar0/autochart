import { useCallback, useEffect, useRef, useState } from "react";
import { electronWindow } from "../services/runtimeBridge.js";
import {
  LEAVE_CONFIRM_MS,
  PENDING_ENTER_MS,
  shouldApplyBrowserFullscreenChange,
  shouldIgnoreElectronLeave,
  shouldRestoreOverlayOnElectronEnter,
} from "./ownedFullscreenPolicy.js";

/**
 * Owns browser/Electron fullscreen transitions for preview surfaces.
 * Overlay state is the highway-fullscreen source of truth. Electron window
 * fullscreen only fills the monitor, and is only exited when this surface
 * turned it on; an already-fullscreen window is never stolen back.
 */
export function useOwnedFullscreen({ targetRef, onResize, label = "preview" } = {}) {
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(false);
  const electronOwnedRef = useRef(false);
  const browserOwnedRef = useRef(false);
  const pendingEnterRef = useRef(false);
  const pendingEnterTimerRef = useRef(0);
  const leaveConfirmGenRef = useRef(0);
  const transitionRef = useRef(0);
  const resizeRef = useRef(onResize);
  resizeRef.current = onResize;

  const updateState = useCallback((active) => {
    const next = Boolean(active);
    fullscreenRef.current = next;
    setFullscreen(next);
    resizeRef.current?.();
  }, []);

  const clearPendingEnter = useCallback(() => {
    pendingEnterRef.current = false;
    if (pendingEnterTimerRef.current) {
      clearTimeout(pendingEnterTimerRef.current);
      pendingEnterTimerRef.current = 0;
    }
  }, []);

  const markPendingEnter = useCallback(() => {
    pendingEnterRef.current = true;
    if (pendingEnterTimerRef.current) clearTimeout(pendingEnterTimerRef.current);
    pendingEnterTimerRef.current = setTimeout(() => {
      pendingEnterRef.current = false;
      pendingEnterTimerRef.current = 0;
    }, PENDING_ENTER_MS);
  }, []);

  const invalidateLeaveConfirms = useCallback(() => {
    leaveConfirmGenRef.current += 1;
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const node = targetRef?.current;
    if (!node) return;
    const next = !fullscreenRef.current;
    const electronBridge = electronWindow();

    if (electronBridge?.setFullscreen) {
      const transition = ++transitionRef.current;
      invalidateLeaveConfirms();
      if (next) {
        updateState(true);
        let alreadyFullscreen = false;
        try {
          alreadyFullscreen = Boolean(await electronBridge.isFullscreen?.());
        } catch (error) {
          console.warn(`[${label}] Could not read Electron fullscreen state:`, error);
        }
        // A second click or navigation may have cancelled this asynchronous enter.
        if (transition !== transitionRef.current) return;
        if (alreadyFullscreen) {
          electronOwnedRef.current = false;
          clearPendingEnter();
        } else {
          electronOwnedRef.current = true;
          markPendingEnter();
        }
        if (!alreadyFullscreen) {
          try {
            await electronBridge.setFullscreen(true);
          } catch (error) {
            if (transition !== transitionRef.current) return;
            clearPendingEnter();
            electronOwnedRef.current = false;
            updateState(false);
            console.warn(`[${label}] Electron fullscreen failed:`, error);
          }
        }
        return;
      }

      invalidateLeaveConfirms();
      clearPendingEnter();
      updateState(false);
      if (electronOwnedRef.current) {
        electronOwnedRef.current = false;
        try {
          await electronBridge.setFullscreen(false);
        } catch (error) {
          console.warn(`[${label}] Electron fullscreen exit failed:`, error);
        }
      }
      return;
    }
    if (document.fullscreenElement === node) {
      await document.exitFullscreen?.();
      return;
    }
    if (!next) {
      updateState(false);
      return;
    }
    if (!node.requestFullscreen) {
      updateState(true);
      return;
    }
    try {
      await node.requestFullscreen({ navigationUI: "hide" });
      browserOwnedRef.current = true;
    } catch (error) {
      browserOwnedRef.current = false;
      console.warn(`[${label}] Browser fullscreen failed; using window fill:`, error);
      updateState(true);
    }
  }, [clearPendingEnter, invalidateLeaveConfirms, label, markPendingEnter, targetRef, updateState]);

  useEffect(() => {
    const onBrowserFullscreenChange = () => {
      const node = targetRef?.current;
      const targetIsFullscreen = Boolean(node && document.fullscreenElement === node);
      if (!shouldApplyBrowserFullscreenChange({
        targetIsFullscreen,
        browserOwned: browserOwnedRef.current,
      })) {
        return;
      }
      if (!targetIsFullscreen) browserOwnedRef.current = false;
      else browserOwnedRef.current = true;
      updateState(targetIsFullscreen);
    };
    document.addEventListener("fullscreenchange", onBrowserFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onBrowserFullscreenChange);
  }, [targetRef, updateState]);

  useEffect(() => {
    const electronBridge = electronWindow();
    if (!electronBridge?.onFullscreenChange) return undefined;
    let disposed = false;
    Promise.resolve(electronBridge.isFullscreen?.()).then((active) => {
      if (!disposed && active) resizeRef.current?.();
    }).catch(() => {});
    const off = electronBridge.onFullscreenChange((active) => {
      if (disposed) return;
      if (active) {
        invalidateLeaveConfirms();
        clearPendingEnter();
        if (shouldRestoreOverlayOnElectronEnter({
          electronOwned: electronOwnedRef.current,
          overlayActive: fullscreenRef.current,
        })) {
          updateState(true);
        } else {
          resizeRef.current?.();
        }
        return;
      }
      // Defer leaves during enter, but still confirm them if no enter follows.
      // Dropping the event entirely can strand the overlay after a cancelled enter.
      const delay = pendingEnterRef.current ? PENDING_ENTER_MS + LEAVE_CONFIRM_MS : LEAVE_CONFIRM_MS;
      const token = ++leaveConfirmGenRef.current;
      setTimeout(() => {
        if (disposed || token !== leaveConfirmGenRef.current) return;
        Promise.resolve(electronBridge.isFullscreen?.())
          .then((still) => {
            if (disposed || token !== leaveConfirmGenRef.current) return;
            if (shouldIgnoreElectronLeave({
              pendingEnter: pendingEnterRef.current,
              windowStillFullscreen: Boolean(still),
            })) {
              return;
            }
            electronOwnedRef.current = false;
            if (fullscreenRef.current) updateState(false);
          })
          .catch(() => {
            if (disposed || token !== leaveConfirmGenRef.current) return;
            if (pendingEnterRef.current) return;
            electronOwnedRef.current = false;
            if (fullscreenRef.current) updateState(false);
          });
      }, delay);
    });
    return () => {
      disposed = true;
      invalidateLeaveConfirms();
      clearPendingEnter();
      off?.();
    };
  }, [clearPendingEnter, invalidateLeaveConfirms, updateState]);

  useEffect(() => () => {
    transitionRef.current += 1;
    const node = targetRef?.current;
    const electronBridge = electronWindow();
    if (electronOwnedRef.current && electronBridge?.setFullscreen) {
      electronOwnedRef.current = false;
      Promise.resolve(electronBridge.setFullscreen(false)).catch((error) => {
        console.warn(`[${label}] Electron fullscreen cleanup failed:`, error);
      });
    }
    if (browserOwnedRef.current && document.fullscreenElement === node) {
      browserOwnedRef.current = false;
      document.exitFullscreen?.().catch?.(() => {});
    }
  }, [label, targetRef]);

  return { fullscreen, fullscreenRef, toggleFullscreen };
}
