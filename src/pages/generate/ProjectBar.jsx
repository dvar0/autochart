import { useEffect, useRef, useState } from "react";
import { MEDIA_ACCEPT } from "../../services/mediaMetadata.js";
import { I } from "../../icons.jsx";
import RichText from "../../components/RichText.jsx";
import useCoverArt from "../../hooks/useCoverArt.js";
import { coverArtSeed } from "../../lib/coverArt/render.js";
import { t } from "../../i18n/index.js";

// The generated cover a song without album art gets in the Library and its
// exports, for the title and artist as typed. A song opening shows its cover
// at once (the Library has usually drawn it already); while the title or
// artist is being typed it follows once typing pauses, so each keystroke
// doesn't draw (and keep) a cover.
function useGeneratedCover(details, enabled, typing) {
  const seed = enabled && (details.title || details.artist) ? coverArtSeed(details.title, details.artist) : null;
  const [settled, setSettled] = useState(seed);
  useEffect(() => {
    if (seed === settled) return undefined;
    if (!typing) {
      setSettled(seed);
      return undefined;
    }
    const timer = setTimeout(() => setSettled(seed), 400);
    return () => clearTimeout(timer);
  }, [seed, settled, typing]);
  return useCoverArt(typing ? settled : seed);
}

// Open state for an anchored popover, closed by an outside click or Escape.
function usePopover() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  return { open, setOpen, wrapRef };
}

// Anchored popover. True overlay, so it carries --shadow-pop per the design
// system.
function BarPopover({ icon, label, isSet, className = "", children }) {
  const { open, setOpen, wrapRef } = usePopover();
  return (
    <div className="bar-pop-wrap" ref={wrapRef}>
      <button
        className={"bar-btn" + (open ? " open" : "") + (isSet ? " is-set" : "")}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {icon}
        <span>{label}</span>
        <I.chev className="chev" />
      </button>
      {open && <div className={"bar-pop " + className}>{children}</div>}
    </div>
  );
}

// Change the cover, or go back to the generated one. The cover's own menu
// stacks them with full labels; the Song menu sets them side by side.
function CoverButtons({ hasOwnCover, busy, onPick, onClear, compact = false }) {
  return (
    <div className={compact ? "song-pop-buttons" : "bar-pop-pair"}>
      <label className={"bar-pop-btn" + (busy ? " disabled" : "")} aria-disabled={busy} title={t("Change cover")}>
        <I.image />
        <span>{compact ? t("Change") : t("Change cover")}</span>
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={onPick} disabled={busy} />
      </label>
      <button className="bar-pop-btn" onClick={onClear} disabled={busy || !hasOwnCover} title={t("Use a cover made from the title and artist")}>
        <I.spark />
        <span>{compact ? t("Generated") : t("Generated cover")}</span>
      </button>
    </div>
  );
}

// The cover at the start of the bar opens its own small menu.
function CoverMenu({ artUrl, children }) {
  const { open, setOpen, wrapRef } = usePopover();
  return (
    <div className="bar-pop-wrap" ref={wrapRef}>
      <button
        className={"project-bar-art" + (open ? " open" : "")}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t("Cover")}
        title={t("Cover")}
      >
        {artUrl ? <img src={artUrl} alt="" /> : <I.music />}
      </button>
      {open && (
        <div className="bar-pop bar-pop-cover">
          <div className="bar-pop-cover-preview">{artUrl ? <img src={artUrl} alt="" /> : <I.music />}</div>
          {children}
        </div>
      )}
    </div>
  );
}

export default function ProjectBar({ project }) {
  const {
    songId,
    details,
    setField,
    albumUrl,
    background,
    sourceAudioFile,
    sourceAudioName,
    sourceAudioMeta,
    pickAudio,
    pickBackground,
    clearBackground,
    pickAlbumArt,
    clearAlbumArt,
    handleSave,
    busy,
    busyAction,
  } = project;
  const [typing, setTyping] = useState(false);
  const generatedCover = useGeneratedCover(details, !albumUrl && Boolean(songId || sourceAudioFile), typing);
  const artUrl = albumUrl || generatedCover?.url;
  const coverProps = { hasOwnCover: Boolean(albumUrl), busy, onPick: pickAlbumArt, onClear: clearAlbumArt };

  return (
    <header className="project-bar">
      <CoverMenu artUrl={artUrl}><CoverButtons {...coverProps} /></CoverMenu>

      <div className="project-id" onFocus={() => setTyping(true)} onBlur={() => setTyping(false)}>
        {/* Transparent inputs are a noted exception to the input-border rule:
            the global focus ring + focus border compensate. */}
        <input
          className="project-title-input"
          value={details.title}
          placeholder={t("Untitled song")}
          onChange={setField("title")}
          aria-label={t("Song title")}
        />
        <input
          className="project-artist-input"
          value={details.artist}
          placeholder={t("Unknown artist")}
          onChange={setField("artist")}
          aria-label={t("Artist")}
        />
      </div>

      <div className="project-bar-actions">
        <BarPopover icon={<I.music />} label={t("Song")} isSet={Boolean(sourceAudioFile)} className="song-pop">
          <div className="bar-pop-current">
            {sourceAudioName ? (
              <>
                <b>{sourceAudioName}</b>
                {sourceAudioMeta && <small>{sourceAudioMeta}</small>}
              </>
            ) : (
              <b>{t("No media yet")}</b>
            )}
          </div>
          <label
            className={"bar-pop-btn" + (sourceAudioFile ? " is-set" : "") + (busy ? " disabled" : "")}
            aria-disabled={busy}
          >
            <I.upload />
            <span>{sourceAudioFile ? t("Start new project with this media") : t("Add media")}</span>
            <input type="file" accept={MEDIA_ACCEPT} onChange={pickAudio} disabled={busy} />
          </label>

          <section className="song-pop-section">
              <span className="song-pop-label">{t("Cover")}</span>
              <div className="song-pop-cover">
                <div className="song-pop-thumb">{artUrl ? <img src={artUrl} alt="" /> : <I.music />}</div>
                <CoverButtons {...coverProps} compact />
              </div>
            </section>
            <section className="song-pop-section">
              <span className="song-pop-label">{t("Background")}</span>
              <div className="song-pop-buttons">
                <label
                  className={"bar-pop-btn" + (background?.type === "image" ? " is-set" : "") + (busy ? " disabled" : "")}
                  aria-disabled={busy}
                  title={t("Image background")}
                >
                  <I.image />
                  <span>{t("Image")}</span>
                  <input type="file" accept="image/*" onChange={pickBackground("image")} disabled={busy} />
                </label>
                <label
                  className={"bar-pop-btn" + (background?.type === "video" ? " is-set" : "") + (busy ? " disabled" : "")}
                  aria-disabled={busy}
                  title={t("Video background")}
                >
                  <I.play />
                  <span>{t("Video")}</span>
                  <input type="file" accept="video/*" onChange={pickBackground("video")} disabled={busy} />
                </label>
                <button className="bar-pop-btn" onClick={clearBackground} disabled={busy || !background} title={t("Remove background")}>
                  <I.trash />
                  <span>{t("Remove")}</span>
                </button>
              </div>
            </section>

          <section className="song-pop-section">
            <span className="song-pop-label">{t("Details")}</span>
            <div className="bar-pop-fields">
              <div className="field">
                <label>{t("Title")}</label>
                <input placeholder={t("Title")} value={details.title} onChange={setField("title")} />
              </div>
              <div className="field">
                <label>{t("Artist")}</label>
                <input placeholder={t("Artist")} value={details.artist} onChange={setField("artist")} />
              </div>
              <div className="field">
                <label>{t("Album")}</label>
                <input placeholder={t("Album")} value={details.album} onChange={setField("album")} />
              </div>
              <div className="field">
                <label>{t("Year")}</label>
                <input placeholder={t("Year")} value={details.year} onChange={setField("year")} />
              </div>
              <div className="field">
                <label htmlFor="project-genre">{t("Genre")}</label>
                <input id="project-genre" placeholder={t("e.g. Rock")} value={details.genre || ""} onChange={setField("genre")} />
              </div>
              <div className="field">
                <label id="project-charter-label">{t("Charter")}</label>
                <div
                  className="field-static"
                  role="textbox"
                  aria-readonly="true"
                  aria-labelledby="project-charter-label"
                  title={t("Generated charts are credited to Autochart. Imported chart credits are preserved.")}
                >
                  <RichText value={details.charter || "Autochart"} />
                </div>
              </div>
            </div>
          </section>
        </BarPopover>

        <button
          className="bar-btn bar-save"
          onClick={handleSave}
          disabled={busy || !songId}
          title={songId ? t("Save this project") : t("Generate a chart first")}
        >
          {busyAction === "saving" ? t("Saving…") : t("Save")}
        </button>
      </div>
    </header>
  );
}
