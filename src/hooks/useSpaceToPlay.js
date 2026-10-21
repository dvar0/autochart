import { useEffect, useRef } from "react";

// Space plays or pauses wherever the page is, full screen included. Typing
// fields keep their Space; a focused button doesn't get clicked by it as well
// (that used to be the only way Space played anything: re-pressing the Play
// button that still had focus).
const TYPING_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && TYPING_INPUTS.has(target.type);
}

export default function useSpaceToPlay(enabled, toggle) {
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (e.key !== " " || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || isTyping(e.target)) return;
      e.preventDefault();
      if (!e.repeat) toggleRef.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
