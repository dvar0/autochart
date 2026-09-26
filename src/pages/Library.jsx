import { useCallback, useEffect, useRef, useState } from "react";
import { AlbumArt } from "../components/index.jsx";
import LibraryFolderPrompt from "../components/LibraryFolderPrompt.jsx";
import { DIFF } from "../data/difficultyMetadata.js";
import {
  GAME_LIBRARY_NAME,
  GAME_LIBRARY_SAVE_LABEL,
  GAME_LIBRARY_SAVING_LABEL,
} from "../data/gameLibrary.js";
import {
  accentForTint,
  cachedCoverColor,
  extractCoverColor,
  normalizeAccent,
  tintIsDark,
} from "../lib/coverColor.js";
import { I } from "../icons.jsx";
import useLibraryFolderGate, { isMissingLibraryFolderError } from "../hooks/useLibraryFolderGate.js";
import {
  FINAL_ARRANGEMENT_ID,
  FINAL_SLOT_DISPLAY_ORDER,
  FINAL_VERSION_ID,
  buildFinalArrangementList,
  buildFinalChartVersion,
  buildFinalSlotVersions,
  finalSlotsFromRecord,
  finalValidationMessage,
} from "../services/finalChart.js";
import { exportChart, saveChartToCloneHeroLibrary } from "../services/generation.js";
import { importSongFolder } from "../services/songImport.js";
import {
  deleteProjectRecord,
  getAllSongRecords,
  getProjectDeletionDetails,
  getSongRecord,
  recordFromImport,
  recordToCard,
  recordToImported,
  revokeCoverUrl,
  saveSongRecord,
  setSongFavorite,
  updateSongRecord,
} from "../services/songLibrary.js";
import { DEFAULT_DEMUCS_ID } from "../services/songSchema.js";

// Effective card surface per theme (mirrors --surface in styles.css). Used to
// decide whether the accent-tinted card reads as dark, so text can flip ink.
const CARD_SURFACE = { light: "#f7f7ff", dark: "#313a52" };
const SLOT_LETTERS = { easy: "E", medium: "M", hard: "H", expert: "X" };

// Resolve a song's accent color: the generated palette's vivid shape color is
// always available immediately; a real cover image upgrades to its sampled
// dominant color once extracted (cached, so it's instant on later renders).
// Also reports whether the tinted card is dark, so text picks readable ink.
function useAccent(song, theme = "light") {
  const fallback = song.art?.shape || "#6860b5";
  // Store the raw extracted/palette color; normalize per theme below so a theme
  // toggle re-tames the accent without re-sampling the cover.
  const [raw, setRaw] = useState(
    () => (song.cover && cachedCoverColor(song.cover)) || fallback
  );
  useEffect(() => {
    let alive = true;
    if (song.cover) {
      extractCoverColor(song.cover).then((c) => {
        if (alive && c) setRaw(c);
      });
    } else {
      setRaw(fallback);
    }
    return () => {
      alive = false;
    };
  }, [song.cover, fallback]);
  const accent = normalizeAccent(raw, theme);
  const surface = CARD_SURFACE[theme] || CARD_SURFACE.light;
  const dark = tintIsDark(accent, surface) ?? theme === "dark";
  // A chroma-floored accent for tinting the detail rail's plane and tiles, so
  // pale/pastel covers still read as color instead of muddy grey. Cards keep
  // using the tamer `accent`.
  const tint = accentForTint(raw, theme);
  return { accent, dark, tint };
}

function Cover({ song, showLabel }) {
  if (song.cover) {
    return (
      <div className="art" style={{ overflow: "hidden" }}>
        <img
          src={song.cover}
          alt=""
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        {showLabel && (
          <div className="art-tag" style={{ fontSize: showLabel === "big" ? 19 : 11 }}>
            {song.artist}
          </div>
        )}
      </div>
    );
  }
  return <AlbumArt art={song.art} label={song.artist} showLabel={showLabel} />;
}

function fmtProjectDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const now = new Date();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function compactVersionName(version) {
  if (!version) return "Empty";
  if (version.source === "imported-chart") return "Source";
  const label = String(version.settings?.model || version.name || "Take").trim();
  const token = label.match(/\bV\d+[A-Z]?\b/i)?.[0];
  const run = version.meta?.runNumber ? ` #${version.meta.runNumber}` : version.name?.match(/#\d+/)?.[0] || "";
  if (token) return `${token.toUpperCase()}${run}`;
  return version.name || label || "Take";
}

function versionDate(version) {
  return Number(version?.updatedAt || version?.createdAt || 0);
}

function latestVersion(versions) {
  return versions.reduce((latest, version) => (versionDate(version) > versionDate(latest) ? version : latest), null);
}

function hasStemPaths(artifact) {
  return Object.values(artifact?.stems || {}).some((stem) => stem?.path);
}

function demucsSnapshot(sourceArtifacts = {}) {
  const demucs = sourceArtifacts?.demucs || {};
  const items = Array.isArray(demucs.items) ? demucs.items.filter(Boolean) : [];
  const storedDefault = items.find((item) => item.id === DEFAULT_DEMUCS_ID);
  const artifacts = [
    {
      id: DEFAULT_DEMUCS_ID,
      name: storedDefault?.name || "Default separation",
      stems: storedDefault?.stems || {},
      status: storedDefault?.status || "on-demand",
    },
    ...items.filter((item) => item.id !== DEFAULT_DEMUCS_ID),
  ];
  const activeId = demucs.activeId || DEFAULT_DEMUCS_ID;
  const active = artifacts.find((item) => item.id === activeId) || artifacts[0];
  return {
    count: artifacts.length,
    activeName: active?.name || "Default separation",
    readyLabel: hasStemPaths(active) ? "Stems ready" : "On demand",
  };
}

function countValidationWarnings(value) {
  if (!value) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value !== "object") return 0;
  let count = 0;
  if (Array.isArray(value.warnings)) count += value.warnings.length;
  if (Array.isArray(value.errors)) count += value.errors.length;
  if (value.ok === false || value.valid === false) count += 1;
  return count;
}

function hasValidation(value) {
  return Boolean(value && typeof value === "object");
}

function versionNoteLabel(version) {
  const count = Number(version?.meta?.noteCount ?? version?.noteCount);
  return Number.isFinite(count) && count > 0 ? `${Math.round(count)} notes` : "-";
}

function versionValidationState(version) {
  const chartValidation = version?.metrics?.chartValidation;
  const packageValidation = version?.metrics?.packageValidation;
  if (!hasValidation(chartValidation) && !hasValidation(packageValidation)) {
    return null;
  }
  const warningCount = countValidationWarnings(chartValidation) + countValidationWarnings(packageValidation);
  return warningCount ? { label: `${warningCount} warning${warningCount === 1 ? "" : "s"}` } : null;
}

function buildProjectSummary(record) {
  const versions = Array.isArray(record?.versions) ? record.versions : [];
  const sourceVersions = versions.filter((version) => version.id !== FINAL_VERSION_ID);
  const generatedVersions = sourceVersions.filter((version) => version.source === "generated");
  const finalSlots = finalSlotsFromRecord(record, sourceVersions);
  const finalSlotVersions = buildFinalSlotVersions(finalSlots, sourceVersions, FINAL_SLOT_DISPLAY_ORDER);
  const finalAssignedCount = Object.values(finalSlotVersions).filter(Boolean).length;
  const finalIssue = finalValidationMessage(finalSlotVersions, FINAL_SLOT_DISPLAY_ORDER);
  const latestGenerated = latestVersion(generatedVersions);
  const separations = demucsSnapshot(record?.sourceArtifacts);

  return {
    updated: fmtProjectDate(record?.updatedAt || record?.createdAt),
    finalSlots,
    finalSlotVersions,
    finalAssignedCount,
    totalTakes: sourceVersions.length,
    latestTakeDate: fmtProjectDate(versionDate(latestGenerated) || record?.updatedAt || record?.createdAt),
    latestTakeName: latestGenerated?.name || "-",
    separations,
    canExportFinal: finalAssignedCount > 0 && !finalIssue,
    finalBlocker: finalIssue || "Assign a difficulty first",
  };
}

async function ensureFinalVersionSaved(record) {
  const versions = Array.isArray(record?.versions) ? record.versions : [];
  const previousFinalVersion = versions.find((version) => version.id === FINAL_VERSION_ID) || null;
  const { slots, finalVersion, versionsWithFinal } = buildFinalChartVersion({
    versions,
    slots: finalSlotsFromRecord(record, versions.filter((version) => version.id !== FINAL_VERSION_ID && version.chart?.text)),
    previousVersion: previousFinalVersion,
  });
  await updateSongRecord(record.id, {
    versions: versionsWithFinal,
    arrangements: buildFinalArrangementList(record, slots, versionsWithFinal),
    settings: {
      ...(record.settings || {}),
      activeVersionId: finalVersion.id,
      activeArrangementId: FINAL_ARRANGEMENT_ID,
    },
    meta: {
      availableDifficulties: finalVersion.meta.availableDifficulties || [],
      noteCount: finalVersion.meta.noteCount || record.meta?.noteCount || 0,
      durationSec: finalVersion.meta.durationSec || record.meta?.durationSec || 0,
    },
  });
  return finalVersion;
}
function FavoriteButton({ song, onToggleFavorite, className = "" }) {
  const label = song.fav ? `Remove ${song.title} from favorites` : `Add ${song.title} to favorites`;
  return (
    <button
      type="button"
      className={`favorite-toggle${song.fav ? "" : " favorite-add"}${className ? ` ${className}` : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggleFavorite(song.id);
      }}
      aria-label={label}
      aria-pressed={Boolean(song.fav)}
      title={label}
    >
      {song.fav ? <I.star aria-hidden="true" /> : "Add to favorites"}
    </button>
  );
}

function GridTile({ song, selected, onSelect, onToggleFavorite }) {
  return (
    <div className={"tile" + (selected ? " sel" : "")}>
      <button
        type="button"
        className="tile-select"
        onClick={() => onSelect(song.id)}
        aria-label={`${song.title} by ${song.artist}`}
        aria-pressed={Boolean(selected)}
      >
        <div className="tile-art">
          <Cover song={song} />
        </div>
        <div className="tile-title">{song.title}</div>
        <div className="tile-sub">
          {song.artist}
          {song.year ? <span className="tile-year"> {song.year}</span> : null}
        </div>
      </button>
      {song.fav && <FavoriteButton song={song} onToggleFavorite={onToggleFavorite} className="tile-fav" />}
    </div>
  );
}

function ListRow({ song, selected, onSelect, onToggleFavorite, theme }) {
  const { accent } = useAccent(song, theme);
  return (
    <div className={"row" + (selected ? " sel" : "")} style={{ "--art-accent": accent }}>
      <button
        type="button"
        className="row-select"
        onClick={() => onSelect(song.id)}
        aria-label={`${song.title} by ${song.artist}`}
        aria-pressed={Boolean(selected)}
      >
        <div className="row-thumb">
          <Cover song={song} />
        </div>
        <div className="row-grid">
          <div>
            <div className="rt-title">
              <span className="ttl">{song.title}</span>
            </div>
            <div className="rt-sub">{song.artist}</div>
          </div>
          <div className="rcol">{song.charter}</div>
          <div className="rcol num">{song.year}</div>
          <div className="rcol num">{song.duration}</div>
        </div>
      </button>
      {song.fav && <FavoriteButton song={song} onToggleFavorite={onToggleFavorite} className="row-fav" />}
    </div>
  );
}

function DetailPanel({
  song,
  record,
  onOpen,
  onToggleFavorite,
  onDeleteProject,
  onExportFinal,
  onSaveFinal,
  actionBusy,
  theme,
}) {
  const { tint } = useAccent(song, theme);
  const summary = buildProjectSummary(record);
  const actionDisabled = Boolean(actionBusy) || !summary.canExportFinal;

  return (
    <div
      className="detail"
      style={{
        "--art-accent": tint,
      }}
    >
      <div className="detail-project-head">
        <div className="detail-thumb">
          <Cover song={song} />
        </div>
        <div className="detail-head-copy">
          <div className="detail-kicker">Project</div>
          <div className="detail-title-row">
            <div className="detail-title">{song.title}</div>
            {song.fav && <FavoriteButton song={song} onToggleFavorite={onToggleFavorite} />}
          </div>
          <div className="detail-artist">{song.artist}</div>
          <div className="detail-updated">Updated {summary.updated}</div>
          {!song.fav && <FavoriteButton song={song} onToggleFavorite={onToggleFavorite} />}
        </div>
      </div>

      <div className="detail-scroll">
        <section className="project-snapshot-final">
          <div className="snapshot-final-top">
            <div>
              <span>Final Chart</span>
              <b>{summary.finalAssignedCount}/{FINAL_SLOT_DISPLAY_ORDER.length}</b>
            </div>
          </div>
          <div className="snapshot-diff-list">
            {FINAL_SLOT_DISPLAY_ORDER.map((difficulty) => {
              const assigned = summary.finalSlotVersions[difficulty];
              const diff = DIFF[difficulty];
              const validation = versionValidationState(assigned);
              return (
                <div
                  key={difficulty}
                  className={`snapshot-diff tone-${diff?.color || "green"}` + (assigned ? " filled" : "")}
                  title={assigned?.name || "Empty"}
                >
                  <span className="snapshot-diff-key">{SLOT_LETTERS[difficulty]}</span>
                  <span className="snapshot-diff-main">
                    <span className="snapshot-diff-name">{diff?.name || difficulty}</span>
                    {assigned && <span className="snapshot-diff-version">{compactVersionName(assigned)}</span>}
                  </span>
                  <span className="snapshot-diff-value">
                    {assigned ? (
                      <>
                        <span>{versionNoteLabel(assigned)}</span>
                        {validation && <span className="snapshot-diff-check warn">{validation.label}</span>}
                      </>
                    ) : (
                      <span>Empty</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="snapshot-section">
          <div className="snapshot-section-title">Takes</div>
          <div className="snapshot-stat-grid">
            <div className="snapshot-stat primary">
              <b>{summary.totalTakes || 0}</b>
              <span>Total Takes</span>
            </div>
            <div className="snapshot-stat date">
              <b title={summary.latestTakeName}>{summary.latestTakeDate}</b>
              <span>Latest</span>
            </div>
          </div>
        </section>

        <section className="snapshot-section">
          <div className="snapshot-section-title">Separations</div>
          <div className="snapshot-line strong">
            <span>{summary.separations.count} saved</span>
            <b>{summary.separations.readyLabel}</b>
          </div>
          <div className="snapshot-muted" title={summary.separations.activeName}>
            {summary.separations.activeName}
          </div>
        </section>

      </div>

      <div className="detail-actions">
        <button
          className="act fill"
          onClick={() => onOpen(song.id)}
        >
          <I.open /> OPEN PROJECT
        </button>
        <div className="detail-action-row">
          <button
            className="act slim ghost"
            onClick={() => onExportFinal(song.id)}
            disabled={actionDisabled}
            title={summary.canExportFinal ? "Export final chart" : summary.finalBlocker}
          >
            <I.upload /> <span>{actionBusy === "exporting" ? "EXPORTING" : "EXPORT"}</span>
          </button>
          <button
            className="act slim purple"
            onClick={(event) => onSaveFinal(song.id, event.currentTarget)}
            aria-label={
              actionBusy === "saving-library"
                ? `Saving final chart to ${GAME_LIBRARY_NAME}`
                : `Save final chart to ${GAME_LIBRARY_NAME}`
            }
            disabled={actionDisabled}
            title={summary.canExportFinal ? `Save an Autochart copy to ${GAME_LIBRARY_NAME}` : summary.finalBlocker}
          >
            <I.check /> <span>{actionBusy === "saving-library" ? GAME_LIBRARY_SAVING_LABEL : GAME_LIBRARY_SAVE_LABEL}</span>
          </button>
        </div>
        <button
          className="act ghost"
          onClick={() => onDeleteProject(song.id)}
          title="Delete this project and move its directory to the operating system Trash"
        >
          <I.trash /> DELETE PROJECT
        </button>
      </div>
    </div>
  );
}

export default function Library({
  setPage,
  onImport,
  onCreate,
  refreshToken = 0,
  theme = "light",
  filter = "all",
  onCounts,
}) {
  const [view, setView] = useState("grid");
  const [selId, setSelId] = useState("");
  const [query, setQuery] = useState("");
  const [songs, setSongs] = useState([]);
  const [records, setRecords] = useState([]);
  const [importing, setImporting] = useState(false);
  const [detailAction, setDetailAction] = useState("");
  const libraryFolderGate = useLibraryFolderGate();
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const importMenuRef = useRef(null);
  const importButtonRef = useRef(null);
  const importInputRef = useRef(null);
  const [importError, setImportError] = useState(null);
  const [statusMsg, setStatusMsg] = useState("");

  const loadLibrary = useCallback(async (shouldCommit = () => true) => {
    const recs = await getAllSongRecords();
    const sorted = [...recs].sort(
      (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
    );
    const projects = await Promise.all(
      sorted.map(recordToCard)
    );
    if (!shouldCommit()) {
      return { records: sorted, songs: projects };
    }
    setRecords(sorted);
    setSongs(projects);
    setSelId((prev) =>
      projects.some((s) => s.id === prev) ? prev : projects[0]?.id ?? ""
    );
    return { records: sorted, songs: projects };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await loadLibrary(() => alive);
      } catch (err) {
        if (alive) setImportError(err.message || String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadLibrary, refreshToken]);

  useEffect(() => {
    if (!importMenuOpen) return undefined;
    const firstItem = importMenuRef.current?.querySelector('[role="menuitem"]');
    firstItem?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setImportMenuOpen(false);
        importButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [importMenuOpen]);

  const handleImportFolder = async (e) => {
    const input = e.target;
    const files = input.files;
    if (!files || !files.length) return;
    setImportError(null);
    setStatusMsg("");
    setImporting(true);
    try {
      const result = await importSongFolder(files);
      const rec = recordFromImport(result);
      const saved = await saveSongRecord(rec);
      await loadLibrary();
      setSelId(saved.id);
      const fullRecord = (await getSongRecord(saved.id)) || saved;
      const payload = await recordToImported(fullRecord);
      onImport?.(payload);
      setStatusMsg("Project imported and saved to library.");
    } catch (err) {
      setImportError(err.message || String(err));
    } finally {
      setImporting(false);
      input.value = "";
    }
  };

  const handleToggleFavorite = async (songId) => {
    const current = songs.find((song) => song.id === songId);
    if (!current) return;
    const next = !current.fav;
    setImportError(null);
    setSongs((items) => items.map((song) => (song.id === songId ? { ...song, fav: next } : song)));
    try {
      await setSongFavorite(songId, next);
    } catch (err) {
      setSongs((items) => items.map((song) => (song.id === songId ? { ...song, fav: !next } : song)));
      setImportError(err.message || "Could not update project favorite.");
    }
  };

  useEffect(() => {
    onCounts?.({
      all: songs.length,
      favorites: songs.filter((s) => s.fav).length,
    });
  }, [songs, onCounts]);

  let filtered = songs.filter((s) => {
    if (filter === "favorites") return s.fav;
    return true;
  });
  if (query.trim()) {
    const q = query.toLowerCase();
    filtered = filtered.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.artist.toLowerCase().includes(q) ||
        s.charter.toLowerCase().includes(q)
    );
  }

  const selected = filtered.find((s) => s.id === selId) || filtered[0] || null;
  const selectedId = selected?.id || "";
  const selectedRecord = records.find((r) => r.id === selected?.id) || null;

  const openImportedSong = async (songId) => {
    const rec = await getSongRecord(songId);
    if (!rec) throw new Error("Project not found in library storage.");
    const payload = await recordToImported(rec);
    onImport?.(payload);
  };

  const handleOpen = async (songId) => {
    try {
      await openImportedSong(songId);
    } catch (err) {
      setImportError(err.message || String(err));
    }
  };

  const handleDeleteProject = async (songId) => {
    const song = songs.find((item) => item.id === songId);
    if (!song) return;
    setImportError(null);
    setStatusMsg("");
    try {
      const details = await getProjectDeletionDetails(songId);
      const projectTitle = details.title || song.title || songId;
      const consequence = details.disposition === "trash"
        ? "The project directory will be moved to the operating system Trash."
        : "The project will be permanently deleted from browser storage.";
      const confirmed = window.confirm(
        `Delete project "${projectTitle}"?\n\nProject path:\n${details.path}\n\n${consequence}`
      );
      if (!confirmed) return;

      const result = await deleteProjectRecord(songId, details.path, details.title);
      revokeCoverUrl(songId);
      await loadLibrary();
      setStatusMsg(
        result.disposition === "trash"
          ? `Moved \"${projectTitle}\" to Trash from ${result.path}.`
          : `Deleted \"${projectTitle}\" from ${result.path}.`
      );
    } catch (err) {
      setImportError(err.message || String(err));
    }
  };

  const handleExportFinal = async (songId) => {
    setImportError(null);
    setStatusMsg("");
    setDetailAction("exporting");
    try {
      const rec = await getSongRecord(songId);
      if (!rec) throw new Error("Project not found in library storage.");
      const finalVersion = await ensureFinalVersionSaved(rec);
      const result = await exportChart(songId, finalVersion.id);
      if (result.canceled) {
        setStatusMsg(result.message || "Export canceled.");
      } else {
        setStatusMsg(result.message || `Exported final chart to ${result.path}`);
      }
      await loadLibrary();
    } catch (err) {
      setImportError(err.message || "Final chart export failed.");
    } finally {
      setDetailAction("");
    }
  };

  const saveFinalToLibrary = async (songId) => {
    setImportError(null);
    setStatusMsg("");
    setDetailAction("saving-library");
    try {
      const rec = await getSongRecord(songId);
      if (!rec) throw new Error("Project not found in library storage.");
      const finalVersion = await ensureFinalVersionSaved(rec);
      const result = await saveChartToCloneHeroLibrary(songId, finalVersion.id);
      setStatusMsg(result.message || `Saved final chart to ${result.path}`);
      await loadLibrary();
    } catch (err) {
      if (isMissingLibraryFolderError(err)) libraryFolderGate.request(() => saveFinalToLibrary(songId));
      else setImportError(err.message || `Could not save final chart to ${GAME_LIBRARY_NAME}.`);
    } finally {
      setDetailAction("");
    }
  };

  const handleSaveFinal = (songId, trigger) => {
    setImportError(null);
    setStatusMsg("");
    return libraryFolderGate.run(() => saveFinalToLibrary(songId), trigger);
  };

  const importBusy = importing;
  const filterNames = { all: "projects", favorites: "favorites" };

  return (
    <div className="ac-body library-body">
      <div className="main">
        <div className="browser-bar">
          <div className="search">
            <I.search aria-hidden="true" />
            <input
              aria-label="Search projects, artists, and charters"
              placeholder="Search projects, artists, charters"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="viewtoggle">
            <button
              type="button"
              className={view === "grid" ? "active" : ""}
              onClick={() => setView("grid")}
              title="Grid view"
              aria-label="Grid view"
              aria-pressed={view === "grid"}
            >
              <I.grid aria-hidden="true" />
            </button>
            <button
              type="button"
              className={view === "list" ? "active" : ""}
              onClick={() => setView("list")}
              title="List view"
              aria-label="List view"
              aria-pressed={view === "list"}
            >
              <I.list aria-hidden="true" />
            </button>
          </div>
          <div className="import-wrap">
            <button
              type="button"
              ref={importButtonRef}
              className="btn-quiet"
              onClick={() => setImportMenuOpen((v) => !v)}
              disabled={importBusy}
              aria-expanded={importMenuOpen}
              aria-haspopup="menu"
              aria-controls="library-import-menu"
            >
              <I.inbox aria-hidden="true" /> {importBusy ? "Importing…" : "Import"}
              <I.chev aria-hidden="true" />
            </button>
            {importMenuOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setImportMenuOpen(false)} />
                <div
                  className="import-menu"
                  id="library-import-menu"
                  role="menu"
                  ref={importMenuRef}
                  aria-label="Import project"
                >
                  <button
                    type="button"
                    className="import-menu-item"
                    role="menuitem"
                    title="Import an existing Clone Hero song folder"
                    onClick={() => {
                      importInputRef.current?.click();
                      setImportMenuOpen(false);
                    }}
                  >
                    <b>Clone Hero folder</b>
                    <small>song.ini + notes.chart + audio</small>
                  </button>
                </div>
              </>
            )}
            <input
              ref={importInputRef}
              type="file"
              webkitdirectory=""
              directory=""
              multiple
              onChange={(e) => {
                setImportMenuOpen(false);
                handleImportFolder(e);
              }}
              style={{ display: "none" }}
            />
            </div>
          <button
            className="btn-primary"
            onClick={onCreate || (() => setPage("generate"))}
          >
            <I.plus /> Create Project
          </button>
        </div>

        <div className="listregion">
          {filtered.length === 0 ? (
            <div className="empty-state">
              <span className="empty-ico">
                <I.search />
              </span>
              <div className="empty-title">No projects found</div>
              <div className="empty-sub">
                {query.trim()
                  ? `Nothing matches “${query.trim()}”.`
                  : filter === "favorites"
                    ? "You haven't starred any projects yet."
                    : "Nothing here yet. Import a folder or create a project."}
              </div>
            </div>
          ) : (
            <>
              {view === "grid" ? (
                <div className="grid">
                  {filtered.map((s) => (
                    <GridTile
                      key={s.id}
                      song={s}
                      selected={s.id === selectedId}
                      onSelect={setSelId}
                      onToggleFavorite={handleToggleFavorite}
                    />
                  ))}
                </div>
              ) : (
                <div className="list">
                  <div className="list-cols" aria-hidden="true">
                    <span />
                    <span>Title</span>
                    <span>Charter</span>
                    <span className="num">Year</span>
                    <span className="num">Length</span>
                  </div>
                  {filtered.map((s) => (
                    <ListRow
                      key={s.id}
                      song={s}
                      selected={s.id === selectedId}
                      onSelect={setSelId}
                      onToggleFavorite={handleToggleFavorite}
                      theme={theme}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="statusbar">
          <span className="status-chunk">
            {filtered.length} project{filtered.length !== 1 ? "s" : ""} · {filterNames[filter] || filter}
          </span>
          {query.trim() && <span className="status-chunk">match “{query.trim()}”</span>}
          <span className="statusbar-spacer" />
          {(importError || statusMsg) && (
            <span
              className={"status-msg" + (importError ? " err" : "")}
              role={importError ? "alert" : "status"}
              aria-live={importError ? "assertive" : "polite"}
            >
              {importError || statusMsg}
            </span>
          )}
        </div>
      </div>
      {selected && (
        <DetailPanel
          song={selected}
          record={selectedRecord}
          key={selected.id}
          theme={theme}
          onOpen={handleOpen}
          onToggleFavorite={handleToggleFavorite}
          onDeleteProject={handleDeleteProject}
          onExportFinal={handleExportFinal}
          onSaveFinal={handleSaveFinal}
          actionBusy={detailAction}
        />
      )}
      <LibraryFolderPrompt gate={libraryFolderGate} onOpenSettings={() => setPage?.("settings")} />
    </div>
  );
}
