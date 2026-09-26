import { useEffect, useState } from "react";

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export default function useResolvedTheme(preference) {
  const [systemTheme, setSystemTheme] = useState(() =>
    typeof window !== "undefined" && window.matchMedia?.(SYSTEM_DARK_QUERY).matches
      ? "dark"
      : "light"
  );

  useEffect(() => {
    if (preference !== "system" || !window.matchMedia) return;
    const query = window.matchMedia(SYSTEM_DARK_QUERY);
    const update = () => setSystemTheme(query.matches ? "dark" : "light");
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, [preference]);

  return preference === "light" || preference === "dark" ? preference : systemTheme;
}
