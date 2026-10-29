import { useEffect, useRef, useState } from "react";
import { MEDIA_ACCEPT } from "../../services/mediaMetadata.js";
import { I } from "../../icons.jsx";
import RichText from "../../components/RichText.jsx";
import useCoverArt from "../../hooks/useCoverArt.js";
import { coverArtSeed } from "../../lib/coverArt/render.js";

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

// Anchored popover with outside-click + Escape dismissal. True overlay, so it
// carries --shadow-pop per the design system.
function BarPopover({ icon, label, isSet, children }) {
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
      {open && <div className="bar-pop">{children}</div>}
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
    handleSave,
    busy,
    busyAction,
  } = project;
  const [typing, setTyping] = useState(false);
  const generatedCover = useGeneratedCover(details, !albumUrl && Boolean(songId || sourceAudioFile), typing);
  const artUrl = albumUrl || generatedCover?.url;

  return (
    <header className="project-bar">
      <div className="project-bar-art" aria-hidden="true">
        {artUrl ? <img src={artUrl} alt="" /> : <I.music />}
      </div>

      <div className="project-id" onFocus={() => setTyping(true)} onBlur={() => setTyping(false)}>
        {/* Transparent inputs are a noted exception to the input-border rule:
            the global focus ring + focus border compensate. */}
        <input
          className="project-title-input"
          value={details.title}
          placeholder="Untitled Song"
          onChange={setField("title")}
          aria-label="Song title"
        />
        <input
          className="project-artist-input"
          value={details.artist}
          placeholder="Unknown Artist"
          onChange={setField("artist")}
          aria-label="Artist"
        />
      </div>

      <div className="project-bar-actions">
        <BarPopover icon={<I.music />} label="Media" isSet={Boolean(sourceAudioFile)}>
          <div className="bar-pop-current">
            {sourceAudioName ? (
              <>
                <b>{sourceAudioName}</b>
                {sourceAudioMeta && <small>{sourceAudioMeta}</small>}
              </>
            ) : (
              <b>No media yet</b>
            )}
          </div>
          <label
            className={"bar-pop-btn" + (sourceAudioFile ? " is-set" : "") + (busy ? " disabled" : "")}
            aria-disabled={busy}
          >
            <I.upload />
            <span>{sourceAudioFile ? "Start new project with this media" : "Add media"}</span>
            <input type="file" accept={MEDIA_ACCEPT} onChange={pickAudio} disabled={busy} />
          </label>
          <label className={"bar-pop-btn" + (background?.type === "image" ? " is-set" : "") + (busy ? " disabled" : "")} aria-disabled={busy}>
            <I.image />
            <span>Image background</span>
            <input type="file" accept="image/*" onChange={pickBackground("image")} disabled={busy} />
          </label>
          <label className={"bar-pop-btn" + (background?.type === "video" ? " is-set" : "") + (busy ? " disabled" : "")} aria-disabled={busy}>
            <I.play />
            <span>Video background</span>
            <input type="file" accept="video/*" onChange={pickBackground("video")} disabled={busy} />
          </label>
          {background && (
            <button className="bar-pop-btn" onClick={clearBackground} disabled={busy}>
              <I.trash />
              <span>Remove background</span>
            </button>
          )}
        </BarPopover>

        <BarPopover icon={<I.pencil />} label="Details">
          <div className="field">
            <label>Album</label>
            <input placeholder="Album" value={details.album} onChange={setField("album")} />
          </div>
          <div className="field">
            <label>Year</label>
            <input placeholder="Year" value={details.year} onChange={setField("year")} />
          </div>
          <div className="field">
            <label htmlFor="project-genre">Genre</label>
            <input id="project-genre" placeholder="e.g. Rock" value={details.genre || ""} onChange={setField("genre")} />
          </div>
          <div className="field">
            <label id="project-charter-label">Charter</label>
            <div className="field-static" role="textbox" aria-readonly="true" aria-labelledby="project-charter-label">
              <RichText value={details.charter || "Autochart"} />
            </div>
            <small>Generated charts are credited to Autochart. Imported chart credits are preserved.</small>
          </div>
        </BarPopover>

        {songId && (
          <button className="bar-btn bar-save" onClick={handleSave} disabled={busy}>
            {busyAction === "saving" ? "Saving…" : "Save"}
          </button>
        )}
      </div>
    </header>
  );
}
