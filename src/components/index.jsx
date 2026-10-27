import { I } from "../icons.jsx";
import { isWebApp } from "../services/runtimeBridge.js";
import useCoverArt from "../hooks/useCoverArt.js";

// Generated cover for a song without album art: a seeded print drawn off the
// main thread (see lib/coverArt), faded in once it is ready.
export function AlbumArt({ seed, label, showLabel }) {
  const art = useCoverArt(seed);
  return (
    <div className="art art-gen">
      {art && (
        <img
          src={art.url}
          alt=""
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      {showLabel && (
        <div
          className="art-tag"
          style={{ fontSize: showLabel === "big" ? 19 : 11 }}
        >
          {label}
        </div>
      )}
    </div>
  );
}

// Five-fret color strip — the app's signature mark (G R Y B O).
export function FretStrip({ className = "" }) {
  return (
    <span className={"fret-strip" + (className ? ` ${className}` : "")} aria-hidden="true">
      <i /><i /><i /><i /><i />
    </span>
  );
}

const LIB_FILTERS = [
  { id: "all", name: "Projects" },
  { id: "favorites", name: "Favorites" },
];

export function Rail({
  theme,
  setTheme,
  page,
  onNav,
  libFilter,
  onLibFilter,
  libCounts,
  collapsed,
  onToggleCollapse,
  songTitle = "",
}) {
  // The browser version has no library and works on one song at a time:
  // Start takes the library's place, and the open song gets its own slot.
  const web = isWebApp();
  const home = web
    ? { id: "start", name: "Start", icon: <I.home /> }
    : { id: "library", name: "Library", icon: <I.music /> };
  const pages = [
    home,
    ...(web ? [] : [{ id: "generate", name: "Generate", icon: <I.bolt /> }]),
    { id: "settings", name: "Settings", icon: <I.gear /> },
  ];
  const themeLabel = theme === "system" ? "System theme" : theme === "light" ? "Light mode" : "Dark mode";
  return (
    <aside className={"rail" + (collapsed ? " collapsed" : "")} aria-label="Primary navigation">
      <div className="brand">
        <button
          type="button"
          className="brand-row"
          onClick={() => onNav(home.id)}
          title={`Autochart — ${home.name}`}
          aria-label={`Autochart — ${home.name}`}
        >
          <span className="logo-star">
            <I.star />
          </span>
          <span className="wordmark">AUTOCHART</span>
        </button>
        {/* the signature fret strip doubles as the collapse handle */}
        <button
          type="button"
          className="brand-strip-btn"
          onClick={onToggleCollapse}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          <FretStrip className="brand-strip" />
        </button>
      </div>
      <nav className="rail-nav" aria-label="Sections">
        {pages.map((it) => (
          <button
            key={it.id}
            type="button"
            className={"rail-item" + (page === it.id ? " active" : "")}
            onClick={() => onNav(it.id)}
            title={it.name}
            aria-current={page === it.id ? "page" : undefined}
          >
            {it.icon}
            <span className="rail-item-label">{it.name}</span>
          </button>
        ))}
      </nav>

      {page === "library" && (
        <div className="rail-section">
          <div className="rail-label">COLLECTION</div>
          {LIB_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={"rail-item sub" + (libFilter === f.id ? " active" : "")}
              onClick={() => onLibFilter(f.id)}
              title={f.name}
              aria-pressed={libFilter === f.id}
            >
              <span className="rail-item-label">{f.name}</span>
              <span className="rail-count">{libCounts?.[f.id] ?? 0}</span>
            </button>
          ))}
        </div>
      )}

      {web && (
        <div className="rail-section">
          <div className="rail-label">SONG</div>
          <button
            type="button"
            className={"rail-item rail-song" + (page === "generate" ? " active" : "")}
            onClick={() => onNav("generate")}
            disabled={!songTitle}
            title={songTitle || "No song open"}
            aria-current={page === "generate" ? "page" : undefined}
          >
            <I.music />
            <span className="rail-item-label">{songTitle || "No song open"}</span>
          </button>
        </div>
      )}

      <div className="rail-spacer" />
      <label className="rail-item quiet rail-theme" title={`Color theme: ${themeLabel}`}>
        {theme === "system" ? <I.monitor aria-hidden="true" /> : theme === "light" ? <I.sun aria-hidden="true" /> : <I.moon aria-hidden="true" />}
        <span className="rail-item-label" aria-hidden="true">{themeLabel}</span>
        <span className="rail-item-label rail-theme-chevron" aria-hidden="true"><I.chev /></span>
        <select
          className="rail-theme-select"
          aria-label="Color theme"
          value={theme}
          onChange={(event) => setTheme(event.target.value)}
        >
          <option value="system">System theme</option>
          <option value="light">Light mode</option>
          <option value="dark">Dark mode</option>
        </select>
      </label>
    </aside>
  );
}
