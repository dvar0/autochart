import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { askConfirm } from "../components/ConfirmDialog.jsx";
import LibraryFolderPrompt from "../components/LibraryFolderPrompt.jsx";
import ProgressRing from "../components/ProgressRing.jsx";
import SongCover from "../components/SongCover.jsx";
import { DIFF } from "../data/difficultyMetadata.js";
import {
  GAME_LIBRARY_NAME,
  GAME_LIBRARY_SAVE_LABEL,
  GAME_LIBRARY_SAVING_LABEL,
} from "../data/gameLibrary.js";
import { I } from "../icons.jsx";
import { takeTitle } from "./generate/takeNames.js";
import { plainText } from "../lib/richText.js";
import useCoverAccent from "../hooks/useCoverAccent.js";
import useLibraryFolderGate, { isMissingLibraryFolderError } from "../hooks/useLibraryFolderGate.js";
import {
  FINAL_SLOT_DISPLAY_ORDER,
  FINAL_VERSION_ID,
  buildFinalSlotVersions,
  finalSlotsFromRecord,
  finalValidationMessage,
} from "../services/finalChart.js";
import { ensureFinalVersionSaved } from "../services/finalChartSave.js";
import { exportChart, saveChartToCloneHeroLibrary } from "../services/generation.js";
import {
  bulkImportBusy, dismissBulkImport, getBulkImport, getImportCoversMade, startBulkImport, stopBulkImport, subscribeBulkImport, undoBulkImport,
} from "../services/bulkImport.js";
import { dragHasFiles, dragLooksLikeSongs, readDrop } from "../services/droppedItems.js";
import {
  addToQueue, getQueue, queueMarks, queueSummary, removeFromQueue, setQueueOpen, subscribeQueue, toggleInQueue,
} from "../services/generationQueue.js";
import { SongArchiveError } from "../services/songArchives.js";
import QueuePanel from "./QueuePanel.jsx";
import {
  deleteProjectRecord,
  getAllSongRecords,
  getProjectDeletionDetails,
  getSongRecord,
  recordToCard,
  recordToImported,
  revokeCoverUrl,
  setSongFavorite,
} from "../services/songLibrary.js";
import { DEFAULT_DEMUCS_ID } from "../services/songSchema.js";
import { formatDate, t, tn, useLanguage } from "../i18n/index.js";

// Last loaded library. The page unmounts whenever another page opens, so a
// revisit renders this immediately and refreshes it from disk underneath.
let libraryCache = null;

const SLOT_LETTERS = { easy: "E", medium: "M", hard: "H", expert: "X" };

function fmtProjectDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const now = new Date();
  return formatDate(date, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function versionDate(version) {
  return Number(version?.updatedAt || version?.createdAt || 0);
}

function latestVersion(versions) {
  return versions.reduce((latest, version) => (versionDate(version) > versionDate(latest) ? version : latest), null);
}

// Separated: stems on disk, or (usually) only their mel tables.
function isSeparated(artifact) {
  if (Object.values(artifact?.stems || {}).some((stem) => stem?.path)) return true;
  return Object.values(artifact?.stemSets || {}).some((set) =>
    set?.melTables || Object.values(set?.stems || {}).some((stem) => stem?.path)
  );
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
  return Number.isFinite(count) && count > 0 ? tn(Math.round(count), "{count} note", "{count} notes") : "-";
}

function versionValidationState(version) {
  const chartValidation = version?.metrics?.chartValidation;
  const packageValidation = version?.metrics?.packageValidation;
  if (!hasValidation(chartValidation) && !hasValidation(packageValidation)) {
    return null;
  }
  const warningCount = countValidationWarnings(chartValidation) + countValidationWarnings(packageValidation);
  return warningCount ? { label: tn(warningCount, "{count} warning", "{count} warnings") } : null;
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

  return {
    updated: fmtProjectDate(record?.updatedAt || record?.createdAt),
    finalSlots,
    finalSlotVersions,
    finalAssignedCount,
    totalTakes: sourceVersions.length,
    latestTakeDate: latestGenerated ? fmtProjectDate(versionDate(latestGenerated)) : "",
    canExportFinal: finalAssignedCount > 0 && !finalIssue,
    finalBlocker: finalIssue || t("Assign a difficulty first"),
  };
}

function FavoriteButton({ song, onToggleFavorite, className = "" }) {
  const label = song.fav ? t("Remove {title} from favorites", { title: song.title }) : t("Add {title} to favorites", { title: song.title });
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
      {song.fav ? <I.star aria-hidden="true" /> : t("Add to favorites")}
    </button>
  );
}

function queueClass(mark) {
  return mark ? ` q-${mark.split(":")[0]}` : "";
}

// The ring around a song being charted fills with its percent.
function queueProgress(mark) {
  return mark?.startsWith("running:") ? { "--queue-progress": `${mark.split(":")[1]}%` } : undefined;
}

const NO_SONG = { artSeed: null };

// A song's place in the queue, on its cover: "waiting:3", "running:42", "done" or
// "failed". With the queue open, the other songs show an empty circle ("add").
function QueueBadge({ mark }) {
  if (!mark) return null;
  const [kind, value] = mark.split(":");
  return (
    <span key={kind} className={`queue-badge is-${kind}`} aria-hidden="true">
      {kind === "add" ? null : kind === "running" ? `${value}%` : kind === "done" ? <I.tick /> : kind === "failed" ? "!" : value}
    </span>
  );
}

const GridTile = memo(function GridTile({ song, selected, queueMark, onSelect, onToggleFavorite }) {
  useLanguage();
  return (
    <div className={"tile" + (selected ? " sel" : "") + queueClass(queueMark)} style={queueProgress(queueMark)} data-song-id={song.id}>
      <button
        type="button"
        className="tile-select"
        onClick={(event) => onSelect(song.id, event)}
        aria-label={t("{title} by {artist}", { title: song.title, artist: song.artist })}
        aria-pressed={Boolean(selected)}
      >
        <div className="tile-art">
          <SongCover song={song} />
          <QueueBadge mark={queueMark} />
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
});

const ListRow = memo(function ListRow({ song, selected, queueMark, onSelect, onToggleFavorite, theme }) {
  useLanguage();
  const { accent } = useCoverAccent(song, theme);
  return (
    <div className={"row" + (selected ? " sel" : "") + queueClass(queueMark)} style={{ "--art-accent": accent, ...queueProgress(queueMark) }} data-song-id={song.id}>
      <button
        type="button"
        className="row-select"
        onClick={(event) => onSelect(song.id, event)}
        aria-label={t("{title} by {artist}", { title: song.title, artist: song.artist })}
        aria-pressed={Boolean(selected)}
      >
        <div className="row-thumb">
          <SongCover song={song} />
          <QueueBadge mark={queueMark} />
        </div>
        <div className="row-grid">
          <div>
            <div className="rt-title">
              <span className="ttl">{song.title}</span>
            </div>
            <div className="rt-sub">{song.artist}</div>
          </div>
          <div className="rcol">{song.album}</div>
          <div className="rcol num">{song.year}</div>
          <div className="rcol num">{song.takes}</div>
        </div>
      </button>
      {song.fav && <FavoriteButton song={song} onToggleFavorite={onToggleFavorite} className="row-fav" />}
    </div>
  );
});

// A refresh that finds a project unchanged keeps its card object, so its tile
// doesn't render again.
function reuseUnchangedCards(next, prev = []) {
  const byId = new Map(prev.map((card) => [card.id, card]));
  return next.map((card) => {
    const old = byId.get(card.id);
    if (!old) return card;
    const keys = Object.keys(card);
    return keys.length === Object.keys(old).length && keys.every((key) => card[key] === old[key]) ? old : card;
  });
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
  const { tint } = useCoverAccent(song, theme);
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
          <SongCover song={song} />
        </div>
        <div className="detail-head-copy">
          <div className="detail-title-row">
            <div className="detail-title">{song.title}</div>
            {song.fav && <FavoriteButton song={song} onToggleFavorite={onToggleFavorite} />}
          </div>
          <div className="detail-artist">{song.artist}</div>
          <div className="detail-updated">{t("Updated {date}", { date: summary.updated })}</div>
          {!song.fav && <FavoriteButton song={song} onToggleFavorite={onToggleFavorite} />}
        </div>
      </div>

      <div className="detail-scroll">
        <section className="project-snapshot-final">
          <div className="snapshot-final-top">
            <div>
              <span>{t("Final chart")}</span>
              <b>{t("{count} of {total}", { count: summary.finalAssignedCount, total: FINAL_SLOT_DISPLAY_ORDER.length })}</b>
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
                  title={assigned?.name || t("Empty")}
                >
                  <span className="snapshot-diff-key">{SLOT_LETTERS[difficulty]}</span>
                  <span className="snapshot-diff-main">
                    <span className="snapshot-diff-name">{diff?.name || difficulty}</span>
                    {assigned && <span className="snapshot-diff-version">{takeTitle(assigned)}</span>}
                  </span>
                  <span className="snapshot-diff-value">
                    {assigned ? (
                      <>
                        <span>{versionNoteLabel(assigned)}</span>
                        {validation && <span className="snapshot-diff-check warn">{validation.label}</span>}
                      </>
                    ) : (
                      <span>{t("Empty")}</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <p className="snapshot-takes">
          {summary.totalTakes
            ? tn(summary.totalTakes, "{count} take", "{count} takes") + (summary.latestTakeDate ? ` · ${t("latest {date}", { date: summary.latestTakeDate })}` : "")
            : t("No takes yet")}
        </p>
      </div>

      <div className="detail-actions">
        <button
          className="act fill"
          onClick={() => onOpen(song.id)}
        >
          <I.open /> {t("Open project")}
        </button>
        <div className="detail-action-row">
          <button
            className="act slim ghost"
            onClick={() => onExportFinal(song.id)}
            disabled={actionDisabled}
            title={summary.canExportFinal ? t("Export final chart") : summary.finalBlocker}
          >
            <I.upload /> <span>{actionBusy === "exporting" ? t("Exporting…") : t("Export")}</span>
          </button>
          <button
            className="act slim purple"
            onClick={(event) => onSaveFinal(song.id, event.currentTarget)}
            aria-label={
              actionBusy === "saving-library"
                ? t("Saving final chart to {library}", { library: GAME_LIBRARY_NAME })
                : t("Save final chart to {library}", { library: GAME_LIBRARY_NAME })
            }
            disabled={actionDisabled}
            title={summary.canExportFinal ? t("Save an Autochart copy to {library}", { library: GAME_LIBRARY_NAME }) : summary.finalBlocker}
          >
            <I.check /> <span>{t(actionBusy === "saving-library" ? GAME_LIBRARY_SAVING_LABEL : GAME_LIBRARY_SAVE_LABEL)}</span>
          </button>
        </div>
        <button
          className="act slim quiet-danger"
          onClick={() => onDeleteProject(song.id)}
          title={t("Delete this project and move its folder to the Trash")}
        >
          <I.trash /> {t("Delete project")}
        </button>
      </div>
    </div>
  );
}

// The import's progress, then its result with Undo.
function ImportNotice({ bulk, onStop, onUndo, onDismiss }) {
  const { phase, imported = [], failed = [] } = bulk;
  let message;
  if (phase === "running") {
    message = bulk.stopping
      ? t("Stopping after this song… {count} imported", { count: imported.length })
      : t("Importing {number} of {total}", { number: Math.min(bulk.done + 1, bulk.total), total: bulk.total }) + (bulk.name ? ` · ${bulk.name}` : "");
  } else if (phase === "done") {
    message = imported.length === 1
      ? t("Imported “{title}”", { title: imported[0].title })
      : tn(imported.length, "Imported {count} song", "Imported {count} songs");
    if (bulk.stopped) message += ` · ${t("stopped with {count} left", { count: bulk.total - bulk.done })}`;
  } else if (phase === "undoing") {
    message = tn(imported.length, "Removing {count} imported project…", "Removing {count} imported projects…");
  } else {
    message = bulk.disposition === "trash"
      ? tn(bulk.removed, "Removed {count} imported project (moved to Trash)", "Removed {count} imported projects (moved to Trash)")
      : tn(bulk.removed, "Removed {count} imported project", "Removed {count} imported projects");
    if (bulk.kept) message += ` · ${tn(bulk.kept, "kept {count} that is open", "kept {count} that are open")}`;
  }
  const problems = phase === "undone" ? bulk.undoFailed || [] : failed;
  return (
    <div className="import-notice" role="status" aria-live="polite">
      <div className="import-notice-row">
        <span className="import-notice-msg">{message}</span>
        {phase === "running" && !bulk.stopping && (
          <button type="button" className="btn-quiet" onClick={onStop}>{t("Stop")}</button>
        )}
        {phase === "done" && imported.length > 0 && (
          <button type="button" className="btn-quiet" onClick={onUndo} title={t("Remove the projects this import created (Ctrl+Z)")}>
            {t("Undo")}
          </button>
        )}
        {(phase === "done" || phase === "undone") && (
          <button type="button" className="import-notice-close" onClick={onDismiss} aria-label={t("Dismiss")}><I.close /></button>
        )}
      </div>
      {problems.length > 0 && phase !== "running" && (
        <details className="import-notice-problems">
          <summary>
            {phase === "undone"
              ? tn(problems.length, "{count} project couldn't be removed", "{count} projects couldn't be removed")
              : tn(problems.length, "{count} song couldn't be imported", "{count} songs couldn't be imported")}
          </summary>
          <ul>
            {problems.map((problem, index) => (
              <li key={index}><b>{problem.name}</b> {problem.message}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export default function Library({
  setPage,
  onImport,
  onCreate,
  openProjectIds = [],
  refreshToken = 0,
  theme = "light",
  filter = "all",
  onCounts,
}) {
  const [view, setView] = useState("grid");
  const [selId, setSelId] = useState("");
  const [query, setQuery] = useState("");
  const [songs, setSongs] = useState(() => libraryCache?.songs || []);
  const [records, setRecords] = useState(() => libraryCache?.records || []);
  const loaded = Boolean(libraryCache);
  const [detailAction, setDetailAction] = useState("");
  const libraryFolderGate = useLibraryFolderGate();
  const bulk = useSyncExternalStore(subscribeBulkImport, getBulkImport);
  const importCoversMade = useSyncExternalStore(subscribeBulkImport, getImportCoversMade);
  const queue = useSyncExternalStore(subscribeQueue, getQueue);
  const queueOpen = queue.open;
  const [dropHot, setDropHot] = useState("");
  const [importError, setImportError] = useState(null);
  const [statusMsg, setStatusMsg] = useState("");

  const loadLibrary = useCallback(async (shouldCommit = () => true) => {
    const recs = await getAllSongRecords();
    const sorted = [...recs].sort(
      (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
    );
    // Tiles hold still while songs are being picked and finishing.
    if ((getQueue().open || getQueue().running) && libraryCache) {
      const place = new Map(libraryCache.records.map((record, index) => [record.id, index]));
      sorted.sort((a, b) => (place.get(a.id) ?? -1) - (place.get(b.id) ?? -1));
    }
    const projects = reuseUnchangedCards(await Promise.all(sorted.map(recordToCard)), libraryCache?.songs);
    libraryCache = { records: sorted, songs: projects };
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

  // When tiles change places they slide there from where they were.
  const listRegion = useRef(null);
  const slideFrom = useRef(null);
  const noteTilePlaces = () => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    slideFrom.current = new Map(
      [...(listRegion.current?.querySelectorAll("[data-song-id]") || [])].map((el) => [el.dataset.songId, el.getBoundingClientRect()])
    );
  };
  useLayoutEffect(() => {
    const from = slideFrom.current;
    if (!from) return;
    slideFrom.current = null;
    listRegion.current?.querySelectorAll("[data-song-id]").forEach((el) => {
      const was = from.get(el.dataset.songId);
      if (!was) return;
      const now = el.getBoundingClientRect();
      const x = was.left - now.left;
      const y = was.top - now.top;
      if (x || y) {
        el.animate(
          [{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }],
          { duration: 360, easing: "cubic-bezier(.2, .8, .2, 1)" }
        );
      }
    });
  }, [songs]);

  // Finished takes change their projects; closing the queue or the run ending
  // sorts the library again.
  const queueDone = useMemo(() => queueSummary(queue).done, [queue]);
  const seenQueue = useRef({ done: queueDone, open: queueOpen, running: queue.running });
  useEffect(() => {
    const seen = seenQueue.current;
    seenQueue.current = { done: queueDone, open: queueOpen, running: queue.running };
    const settled = seen.open !== queueOpen || seen.running !== queue.running;
    if (settled) noteTilePlaces();
    if (settled || queueDone > seen.done) loadLibrary().catch(() => {});
  }, [queueDone, queueOpen, queue.running, loadLibrary]);

  // Generate moves the queue's songs to where finishing will leave them (the
  // last to finish comes first), so nothing jumps when the queue closes.
  const runOrder = queue.running ? queue.items.map((item) => item.songId).join("/") : "";
  useEffect(() => {
    if (!runOrder || !libraryCache) return;
    const ids = getQueue().items
      .filter((item) => item.runs.some((run) => run.status !== "failed"))
      .map((item) => item.songId)
      .reverse();
    const rank = new Map(ids.map((id, index) => [id, index]));
    const ordered = [...libraryCache.records].sort((a, b) => {
      if (rank.has(a.id) || rank.has(b.id)) return (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity);
      return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt);
    });
    if (ordered.every((record, index) => record.id === libraryCache.records[index].id)) return;
    const place = new Map(ordered.map((record, index) => [record.id, index]));
    const cards = [...libraryCache.songs].sort((a, b) => place.get(a.id) - place.get(b.id));
    libraryCache = { records: ordered, songs: cards };
    noteTilePlaces();
    setRecords(ordered);
    setSongs(cards);
    listRegion.current?.scrollTo({ top: 0, behavior: slideFrom.current ? "smooth" : "auto" });
  }, [runOrder]);

  // Song folders dropped anywhere on the Library import into it; one song file
  // starts a new project with it, and several become projects to generate
  // later. A folder of song folders imports them all. With the queue open, every
  // song dropped also joins the queue.
  const handleDragOver = (event) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const next = dragLooksLikeSongs(event) ? "songs" : "file";
    if (dropHot !== next) setDropHot(next);
  };

  const handleDragLeave = (event) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setDropHot("");
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setDropHot("");
    setImportError(null);
    setStatusMsg("");
    readDrop(event.dataTransfer).then(({ folders, songs, directories, archives, file }) => {
      if (folders.length || songs.length > 1 || (queueOpen && songs.length)) {
        if (bulkImportBusy()) setImportError(t("Songs are still importing. Drop more once they're in."));
        else {
          startBulkImport(songs, { onSaved: queueOpen ? (saved) => addToQueue([saved]) : undefined })
            .catch((err) => setImportError(err.message || String(err)));
        }
      } else if (directories || archives) {
        setImportError(t("No Clone Hero songs in there. Each song needs a notes.chart and its audio."));
      } else if (file) {
        onCreate?.(file);
      }
    }).catch((err) => setImportError(err instanceof SongArchiveError ? err.message : t("That drop couldn't be read.")));
  };

  // Show projects as they land, and pick the first one imported. Coming back
  // to the Library with an earlier import's notice up leaves the pick alone.
  const importedCount = bulk?.imported?.length || 0;
  const firstImportedId = bulk?.imported?.[0]?.id || "";
  const bulkPhase = bulk?.phase || "";
  const seenImport = useRef({ count: importedCount, phase: bulkPhase });
  useEffect(() => {
    const seen = seenImport.current;
    if (seen.count === importedCount && seen.phase === bulkPhase) return;
    seenImport.current = { count: importedCount, phase: bulkPhase };
    if (!importedCount && bulkPhase !== "undone") return;
    loadLibrary().then(() => {
      if (firstImportedId && bulkPhase !== "undone") setSelId(firstImportedId);
    }).catch(() => {});
  }, [importedCount, firstImportedId, bulkPhase, loadLibrary]);

  // An imported video's cover lands after the video itself.
  useEffect(() => {
    if (importCoversMade) loadLibrary().catch(() => {});
  }, [importCoversMade, loadLibrary]);

  const handleUndoImport = useCallback(() => {
    // A song being charted stays, like one open in the app.
    const charting = getQueue().items
      .filter((item) => item.runs.some((run) => run.status === "running"))
      .map((item) => item.songId);
    const keepIds = [...openProjectIds, ...charting];
    removeFromQueue((getBulkImport()?.imported || []).map((project) => project.id).filter((id) => !keepIds.includes(id)));
    undoBulkImport({ keepIds }).catch((err) => setImportError(err.message || String(err)));
  }, [openProjectIds]);

  // Ctrl+Z (Cmd+Z) undoes a finished import while its notice is up, unless
  // a text field has the keyboard.
  useEffect(() => {
    if (bulkPhase !== "done" || !importedCount) return undefined;
    const onKeyDown = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "z") return;
      const target = event.target;
      if (target?.closest?.("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      handleUndoImport();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [bulkPhase, importedCount, handleUndoImport]);

  // Stable across renders so unchanged tiles can skip rendering.
  const songsRef = useRef(songs);
  songsRef.current = songs;
  const handleToggleFavorite = useCallback(async (songId) => {
    const current = songsRef.current.find((song) => song.id === songId);
    if (!current) return;
    const next = !current.fav;
    setImportError(null);
    setSongs((items) => items.map((song) => (song.id === songId ? { ...song, fav: next } : song)));
    try {
      await setSongFavorite(songId, next);
    } catch (err) {
      setSongs((items) => items.map((song) => (song.id === songId ? { ...song, fav: !next } : song)));
      setImportError(err.message || t("Could not update the favorite."));
    }
  }, []);

  // Keep the cache in step with local edits such as favorites.
  useEffect(() => {
    if (libraryCache) libraryCache = { records, songs };
  }, [records, songs]);

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
        plainText(s.charter).toLowerCase().includes(q)
    );
  }

  const selected = filtered.find((s) => s.id === selId) || filtered[0] || null;
  const selectedId = selected?.id || "";
  // With the queue closed, only the song being charted stays marked.
  const marks = useMemo(() => {
    const all = queueMarks(queue);
    return queue.open ? all : new Map([...all].filter(([, mark]) => mark.startsWith("running")));
  }, [queue]);
  const songsById = useMemo(() => new Map(songs.map((song) => [song.id, song])), [songs]);
  // The queue takes its color from the song it's on, like a project's panel does.
  const queueFocus = useMemo(() => {
    const has = (status) => (item) => item.runs.some((run) => run.status === status);
    const item = queue.items.find(has("running")) || queue.items.find(has("waiting")) || queue.items.at(-1);
    return item ? songsById.get(item.songId) : null;
  }, [queue.items, songsById]);
  const queueColor = useCoverAccent(queueFocus || NO_SONG, theme);

  // With the queue open a click adds or removes a song, and shift-click adds
  // every song shown between it and the last one clicked. Stable across renders
  // so unchanged tiles can skip rendering.
  const pickRef = useRef({});
  pickRef.current = { records, filtered, queueOpen };
  const pickAnchor = useRef("");
  const handlePick = useCallback((songId, event) => {
    const { records: allRecords, filtered: shown, queueOpen: picking } = pickRef.current;
    if (!picking) {
      setSelId(songId);
      return;
    }
    const recordFor = (id) => allRecords.find((record) => record.id === id);
    const from = shown.findIndex((song) => song.id === pickAnchor.current);
    const to = shown.findIndex((song) => song.id === songId);
    if (event?.shiftKey && from >= 0 && to >= 0) {
      addToQueue(shown.slice(Math.min(from, to), Math.max(from, to) + 1).map((song) => recordFor(song.id)));
    } else {
      toggleInQueue(recordFor(songId));
    }
    pickAnchor.current = songId;
  }, []);
  const addAllShown = () => addToQueue(filtered.map((song) => records.find((record) => record.id === song.id)));
  const selectedRecord = records.find((r) => r.id === selected?.id) || null;

  const openImportedSong = async (songId) => {
    const rec = await getSongRecord(songId);
    if (!rec) throw new Error(t("This project is gone from the library."));
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
    if (getQueue().items.some((item) => item.songId === songId && item.runs.some((run) => run.status === "running"))) {
      setImportError(t("This song is being charted. Stop the queue before deleting it."));
      return;
    }
    try {
      const details = await getProjectDeletionDetails(songId);
      const projectTitle = details.title || song.title || songId;
      const confirmed = await askConfirm({
        title: t("Delete “{title}”?", { title: projectTitle }),
        body: details.disposition === "trash"
          ? t("Its folder moves to the Trash.")
          : t("It's deleted from this browser for good."),
        detail: details.path,
        confirmLabel: t("Delete project"),
        danger: true,
      });
      if (!confirmed) return;

      const result = await deleteProjectRecord(songId, details.path, details.title);
      revokeCoverUrl(songId);
      removeFromQueue([songId]);
      await loadLibrary();
      setStatusMsg(
        result.disposition === "trash"
          ? t("Moved “{title}” to the Trash from {path}.", { title: projectTitle, path: result.path })
          : t("Deleted “{title}” from {path}.", { title: projectTitle, path: result.path })
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
      if (!rec) throw new Error(t("This project is gone from the library."));
      const finalVersion = await ensureFinalVersionSaved(rec);
      const result = await exportChart(songId, finalVersion.id);
      if (result.canceled) {
        setStatusMsg(result.message || t("Export canceled."));
      } else {
        setStatusMsg(result.message || t("Exported final chart to {path}", { path: result.path }));
      }
      await loadLibrary();
    } catch (err) {
      setImportError(err.message || t("Final chart export failed"));
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
      if (!rec) throw new Error(t("This project is gone from the library."));
      const finalVersion = await ensureFinalVersionSaved(rec);
      const result = await saveChartToCloneHeroLibrary(songId, finalVersion.id);
      setStatusMsg(result.message || t("Saved final chart to {path}", { path: result.path }));
      await loadLibrary();
    } catch (err) {
      if (isMissingLibraryFolderError(err)) libraryFolderGate.request(() => saveFinalToLibrary(songId));
      else setImportError(err.message || t("Could not save final chart to {library}.", { library: GAME_LIBRARY_NAME }));
    } finally {
      setDetailAction("");
    }
  };

  const handleSaveFinal = (songId, trigger) => {
    setImportError(null);
    setStatusMsg("");
    return libraryFolderGate.run(() => saveFinalToLibrary(songId), trigger);
  };

  return (
    <div
      className={"ac-body library-body" + (dropHot ? " is-drop-hot" : "")}
      style={queueFocus ? { "--queue-tint": queueColor.tint, "--queue-accent": queueColor.accent } : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="main">
        <div className="browser-bar">
          <div className="search">
            <I.search aria-hidden="true" />
            <input
              aria-label={t("Search projects, artists, and charters")}
              placeholder={t("Search projects, artists, charters")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="viewtoggle">
            <button
              type="button"
              className={view === "grid" ? "active" : ""}
              onClick={() => setView("grid")}
              title={t("Grid view")}
              aria-label={t("Grid view")}
              aria-pressed={view === "grid"}
            >
              <I.grid aria-hidden="true" />
            </button>
            <button
              type="button"
              className={view === "list" ? "active" : ""}
              onClick={() => setView("list")}
              title={t("List view")}
              aria-label={t("List view")}
              aria-pressed={view === "list"}
            >
              <I.list aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            className={"btn-quiet queue-toggle-btn" + (queueOpen ? " is-open" : "")}
            onClick={() => setQueueOpen(!queueOpen)}
            aria-pressed={queueOpen}
            title={queueOpen ? t("Back to the library. The queue keeps its songs and keeps running.") : t("Chart several songs, one after another")}
          >
            {queueOpen ? <I.close /> : queue.running ? <ProgressRing value={queueSummary(queue).percent} /> : <I.queue />}
            <span>{queueOpen ? t("Close queue") : t("Queue")}</span>
            {!queueOpen && queue.items.length > 0 && <b className="queue-toggle-count">{queue.items.length}</b>}
          </button>
          <button
            type="button"
            className={queueOpen ? "btn-quiet library-new-quiet" : "btn-primary"}
            onClick={() => (onCreate ? onCreate() : setPage("generate"))}
            title={t("Start from a song, or open a Clone Hero song folder. You can also drop either onto the Library.")}
          >
            <I.plus /> {t("New project")}
          </button>
        </div>

        <div className="listregion" ref={listRegion}>
          {!loaded ? null : filtered.length === 0 ? (
            <div className="empty-state">
              <span className="empty-ico">
                <I.search />
              </span>
              <div className="empty-title">{t("No projects found")}</div>
              <div className="empty-sub">
                {query.trim()
                  ? t("Nothing matches “{query}”.", { query: query.trim() })
                  : filter === "favorites"
                    ? t("You haven't starred any projects yet.")
                    : t("Nothing here yet. Start a new project, or drop songs or Clone Hero song folders here.")}
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
                      selected={queueOpen ? marks.has(s.id) : s.id === selectedId}
                      queueMark={marks.get(s.id) || (queueOpen ? "add" : undefined)}
                      onSelect={handlePick}
                      onToggleFavorite={handleToggleFavorite}
                    />
                  ))}
                </div>
              ) : (
                <div className="list">
                  <div className="list-cols" aria-hidden="true">
                    <span />
                    <span>{t("Title")}</span>
                    <span>{t("Album")}</span>
                    <span className="num">{t("Year")}</span>
                    <span className="num">{t("Takes")}</span>
                  </div>
                  {filtered.map((s) => (
                    <ListRow
                      key={s.id}
                      song={s}
                      selected={queueOpen ? marks.has(s.id) : s.id === selectedId}
                      queueMark={marks.get(s.id) || (queueOpen ? "add" : undefined)}
                      onSelect={handlePick}
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
            {filter === "favorites"
              ? tn(filtered.length, "{count} favorite", "{count} favorites")
              : tn(filtered.length, "{count} project", "{count} projects")}
          </span>
          {query.trim() && <span className="status-chunk">{t("match “{query}”", { query: query.trim() })}</span>}
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
      {queueOpen ? (
        <QueuePanel
          songs={songsById}
          folderGate={libraryFolderGate}
          onOpen={handleOpen}
          onAddAll={addAllShown}
          canAddAll={filtered.some((song) => !marks.has(song.id))}
        />
      ) : selected && (
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
      {bulk && <ImportNotice bulk={bulk} onStop={stopBulkImport} onUndo={handleUndoImport} onDismiss={dismissBulkImport} />}
      <div className="library-drop-veil" aria-hidden="true">
        <span>
          {queueOpen
            ? t("Drop to add these to the queue")
            : dropHot === "songs" ? t("Drop to import these songs") : t("Drop to start a project with this song")}
        </span>
      </div>
    </div>
  );
}
