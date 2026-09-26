import { useEffect, useLayoutEffect, useRef } from "react";
import { GAME_LIBRARY_NAME } from "../data/gameLibrary.js";
import { I } from "../icons.jsx";

const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex='-1'])";

// Blocking prompt for "Save to Clone Hero / YARG" when no songs folder is set.
// A native modal <dialog> keeps the rest of the page inert; `gate` comes from
// useLibraryFolderGate and owns the parked save.
export default function LibraryFolderPrompt({ gate, onOpenSettings }) {
  const dialogRef = useRef(null);
  const primaryRef = useRef(null);
  const { open, error, refocusToken, dismiss, chooseFolderAndSave, restoreFocus } = gate;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      primaryRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      restoreFocus();
    }
  }, [open, restoreFocus]);

  useEffect(() => {
    if (refocusToken) restoreFocus();
  }, [refocusToken, restoreFocus]);

  // Keep keys away from page-level shortcuts (editor Space/Delete/Undo), and
  // wrap Tab / Shift+Tab so focus never leaves the dialog.
  const onKeyDown = (event) => {
    event.stopPropagation();
    if (event.key !== "Tab") return;
    const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="lib-prompt"
      aria-labelledby="lib-prompt-title"
      aria-describedby="lib-prompt-body"
      onKeyDown={onKeyDown}
      // Escape: let React state close the dialog so focus is restored.
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      // Closed natively (not via state). `close` is queued, so ignore a late
      // one that arrives after the prompt has already been reopened.
      onClose={() => {
        if (open && !dialogRef.current?.open) dismiss();
      }}
      // A click on the dialog element itself is a click on the backdrop.
      onClick={(event) => {
        if (event.target === dialogRef.current) dismiss();
      }}
    >
      {open && (
        <div className="lib-prompt-panel">
          <div className="lib-prompt-icon" aria-hidden="true"><I.folder /></div>
          <h2 id="lib-prompt-title" className="lib-prompt-title">Set your songs folder</h2>
          <p id="lib-prompt-body" className="lib-prompt-body">
            Pick your {GAME_LIBRARY_NAME} songs folder to save this chart. You only need to do this once.
          </p>
          {error && <p className="lib-prompt-error" role="alert">{error}</p>}
          <div className="lib-prompt-actions">
            {onOpenSettings && (
              <button
                type="button"
                className="btn-quiet lib-prompt-settings"
                onClick={() => {
                  dismiss();
                  onOpenSettings();
                }}
              >
                <I.gear /> Open Settings
              </button>
            )}
            <button type="button" className="btn-quiet" onClick={dismiss}>
              Cancel
            </button>
            <button type="button" ref={primaryRef} className="btn-primary" onClick={chooseFolderAndSave}>
              <I.folder /> Choose Folder &amp; Save
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
