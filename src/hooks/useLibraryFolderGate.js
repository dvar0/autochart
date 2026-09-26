import { useCallback, useRef, useState } from "react";
import { chooseCloneHeroLibraryFolder, getAppSettings } from "../services/appSettings.js";

// Matches the main process refusal when no Clone Hero / YARG folder is set.
export function isMissingLibraryFolderError(err) {
  return /library folder in Settings/i.test(err?.message || "");
}

// Shared by every "Save to Clone Hero / YARG" entry point. When the songs
// folder is missing, the save is parked and LibraryFolderPrompt asks for the
// folder; choosing one resumes the parked save.
export default function useLibraryFolderGate() {
  const [state, setState] = useState({ open: false, error: "" });
  // Bumped after a resumed save; the prompt refocuses Save once React has
  // committed (the button is disabled until then).
  const [refocusToken, setRefocusToken] = useState(0);
  const pendingSaveRef = useRef(null);
  const triggerRef = useRef(null);

  const request = useCallback((save) => {
    pendingSaveRef.current = save;
    setState({ open: true, error: "" });
  }, []);

  // Run `save` now, or park it behind the prompt if no folder is set yet.
  const run = useCallback(async (save, trigger) => {
    triggerRef.current = trigger || document.activeElement;
    const settings = await getAppSettings().catch(() => null);
    if (settings && !settings.cloneHeroLibraryFolder) {
      request(save);
      return;
    }
    await save();
  }, [request]);

  // Put focus back on the Save button unless the user has moved it elsewhere.
  const restoreFocus = useCallback(() => {
    const trigger = triggerRef.current;
    const active = document.activeElement;
    if (trigger?.isConnected && (!active || active === document.body)) trigger.focus();
  }, []);

  const dismiss = useCallback(() => {
    pendingSaveRef.current = null;
    setState({ open: false, error: "" });
  }, []);

  const chooseFolderAndSave = useCallback(async () => {
    let result;
    try {
      result = await chooseCloneHeroLibraryFolder();
    } catch (err) {
      // Electron prefixes IPC exceptions with the internal channel name.
      const message = String(err?.message || "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
      setState({ open: true, error: message || "Could not set the songs folder." });
      return;
    }
    if (result?.canceled || !result?.settings?.cloneHeroLibraryFolder) return;
    const save = pendingSaveRef.current;
    pendingSaveRef.current = null;
    setState({ open: false, error: "" });
    await save?.();
    setRefocusToken((token) => token + 1);
  }, []);

  return { ...state, refocusToken, run, request, dismiss, chooseFolderAndSave, restoreFocus };
}
