import { useSyncExternalStore } from "react";

function subscribe(onChange) {
  const app = document.querySelector(".ac-app");
  if (!app) return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(app, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

const read = () => document.querySelector(".ac-app")?.dataset.theme || "";

// The theme on screen, for canvases: they keep their pixels until redrawn, so
// one drawn in theme colors lists this among the things that redraw it.
export default function useAppTheme() {
  return useSyncExternalStore(subscribe, read, read);
}
