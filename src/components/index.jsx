import { I } from "../icons.jsx";

export function AlbumArt({ art, label, showLabel }) {
  const grad = `linear-gradient(150deg, ${art.bg[0]}, ${art.bg[1]})`;
  let inner = null;
  const s = art.shape;
  switch (art.style) {
    case "wave":
      inner = (
        <div
          style={{
            position: "absolute",
            inset: "22% 12%",
            display: "flex",
            alignItems: "center",
            gap: "7%",
          }}
        >
          {[45, 80, 60, 95, 35, 70, 88, 50, 75, 40].map((h, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: `${h}%`,
                background: `${s}${i % 2 ? "dd" : "88"}`,
                borderRadius: 2,
              }}
            />
          ))}
        </div>
      );
      break;
    case "aurora":
      inner = (
        <>
          <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 75% 26% at 45% 32%, ${s}cc, transparent 70%)`, filter: "blur(7px)" }} />
          <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 90% 22% at 55% 58%, ${s}77, transparent 70%)`, filter: "blur(7px)" }} />
          <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 65% 20% at 40% 80%, ${s}aa, transparent 70%)`, filter: "blur(5px)" }} />
        </>
      );
      break;
    case "neon":
      inner = (
        <div
          style={{
            position: "absolute",
            inset: "22%",
            border: `2px solid ${s}`,
            borderRadius: 6,
            boxShadow: `0 0 12px ${s}aa`,
          }}
        />
      );
      break;
    case "hex":
      inner = (
        <div
          style={{
            position: "absolute",
            inset: "16%",
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gridAutoRows: "1fr",
            gap: "10%",
          }}
        >
          {["cc", "55", "88", "33", "aa", "66", "99", "44", "77"].map((a, i) => (
            <div
              key={i}
              style={{
                background: `${s}${a}`,
                clipPath:
                  "polygon(25% 5%, 75% 5%, 100% 50%, 75% 95%, 25% 95%, 0 50%)",
              }}
            />
          ))}
        </div>
      );
      break;
    case "horizon":
      inner = (
        <>
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: "40%",
              background: `${s}33`,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "34%",
              transform: "translateX(-50%)",
              width: "18%",
              aspectRatio: "1",
              borderRadius: "50%",
              background: `${s}cc`,
            }}
          />
        </>
      );
      break;
    case "flare":
      inner = (
        <>
          <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 35% 35%, ${s}, transparent 28%)` }} />
          <div style={{ position: "absolute", left: "35%", top: "35%", width: "14%", aspectRatio: "1", borderRadius: "50%", background: s, boxShadow: `0 0 22px ${s}, 0 0 42px ${s}88` }} />
          <div style={{ position: "absolute", left: "63%", top: "60%", width: "8%", aspectRatio: "1", borderRadius: "50%", background: `${s}cc`, boxShadow: `0 0 12px ${s}` }} />
          <div style={{ position: "absolute", inset: 0, background: `linear-gradient(125deg, transparent 44%, ${s}66 49%, ${s}99 50%, ${s}66 51%, transparent 56%)`, opacity: 0.6 }} />
        </>
      );
      break;
    case "strata":
      inner = (
        <>
          {[28, 44, 60, 74].map((y, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: `${y}%`,
                height: `${8 + (i % 2) * 5}%`,
                background: `${s}${["66", "aa", "44", "88"][i]}`,
              }}
            />
          ))}
        </>
      );
      break;
    case "diamond":
      inner = (
        <>
          <div style={{ position: "absolute", left: "50%", top: "50%", width: "44%", aspectRatio: "1", transform: "translate(-50%,-50%) rotate(45deg)", background: `${s}66`, border: `2px solid ${s}` }} />
          <div style={{ position: "absolute", left: "50%", top: "50%", width: "20%", aspectRatio: "1", transform: "translate(-50%,-50%) rotate(45deg)", background: s }} />
        </>
      );
      break;
    case "burst":
      inner = (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%,-50%)",
            width: "60%",
            height: "60%",
            background: `conic-gradient(from 0deg, ${s}, transparent, ${s}, transparent, ${s})`,
            borderRadius: "50%",
            filter: "blur(1px)",
          }}
        />
      );
      break;
    case "mesh":
      inner = (
        <>
          <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 22% 28%, ${s}cc, transparent 42%)`, filter: "blur(6px)" }} />
          <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 78% 30%, ${s}77, transparent 38%)`, filter: "blur(6px)" }} />
          <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 60% 85%, ${s}99, transparent 45%)`, filter: "blur(6px)" }} />
        </>
      );
      break;
    case "beam":
      inner = (
        <>
          <div style={{ position: "absolute", inset: 0, background: `linear-gradient(135deg, transparent 35%, ${s}aa 45%, ${s}dd 50%, ${s}aa 55%, transparent 65%)` }} />
          <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 30% 30%, ${s}55, transparent 55%)` }} />
        </>
      );
      break;
    case "prism":
      inner = (
        <>
          <div style={{ position: "absolute", inset: 0, clipPath: "polygon(0 0, 65% 0, 30% 100%, 0 100%)", background: `${s}55` }} />
          <div style={{ position: "absolute", inset: 0, clipPath: "polygon(70% 0, 100% 0, 100% 70%, 50% 100%)", background: `${s}88` }} />
          <div style={{ position: "absolute", inset: 0, clipPath: "polygon(0 60%, 35% 100%, 0 100%)", background: `${s}aa` }} />
        </>
      );
      break;
    case "orbit":
      inner = (
        <>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                width: `${52 + i * 22}%`,
                height: `${30 + i * 14}%`,
                transform: `translate(-50%,-50%) rotate(${i * 20 - 20}deg)`,
                borderRadius: "50%",
                border: `2px solid ${s}`,
                opacity: 0.85 - i * 0.18,
              }}
            />
          ))}
        </>
      );
      break;
    case "peak":
      inner = (
        <>
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "55%", background: `${s}44`, clipPath: "polygon(0 100%, 0 55%, 25% 20%, 50% 60%, 75% 15%, 100% 50%, 100% 100%)" }} />
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "38%", background: `${s}99`, clipPath: "polygon(0 100%, 0 60%, 20% 30%, 45% 70%, 70% 25%, 90% 55%, 100% 40%, 100% 100%)" }} />
        </>
      );
      break;
    case "grid":
      inner = (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: `linear-gradient(${s}66 1px, transparent 1fr), linear-gradient(90deg, ${s}66 1px, transparent 1fr)`,
            backgroundSize: "22% 22%",
            maskImage: "radial-gradient(circle at 50% 58%, black, transparent 78%)",
            WebkitMaskImage: "radial-gradient(circle at 50% 58%, black, transparent 78%)",
          }}
        />
      );
      break;
    case "arc":
      inner = (
        <>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: "50%",
                bottom: "28%",
                transform: "translateX(-50%)",
                width: `${48 + i * 18}%`,
                aspectRatio: "1",
                borderRadius: "50%",
                border: `2px solid ${s}`,
                opacity: 0.85 - i * 0.2,
                clipPath: "inset(0 0 50% 0)",
              }}
            />
          ))}
        </>
      );
      break;
    case "comet":
      inner = (
        <>
          <div style={{ position: "absolute", inset: 0, background: `linear-gradient(125deg, transparent 30%, ${s}55 45%, ${s}dd 52%, transparent 60%)` }} />
          <div style={{ position: "absolute", left: "60%", top: "28%", width: "13%", aspectRatio: "1", borderRadius: "50%", background: s, boxShadow: `0 0 18px ${s}` }} />
        </>
      );
      break;
    default:
      inner = null;
  }
  return (
    <div className="art" style={{ background: grad }}>
      <div className="art-band">{inner}</div>
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
}) {
  const pages = [
    { id: "library", name: "Library", icon: <I.music /> },
    { id: "generate", name: "Generate", icon: <I.bolt /> },
    { id: "settings", name: "Settings", icon: <I.gear /> },
  ];
  const themeLabel = theme === "system" ? "System theme" : theme === "light" ? "Light mode" : "Dark mode";
  return (
    <aside className={"rail" + (collapsed ? " collapsed" : "")} aria-label="Primary navigation">
      <div className="brand">
        <button
          type="button"
          className="brand-row"
          onClick={() => onNav("library")}
          title="Autochart — Library"
          aria-label="Autochart — Library"
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
