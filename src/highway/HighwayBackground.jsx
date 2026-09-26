import { useEffect, useState } from "react";
import { resolveVideoBackground } from "../services/videoPreview.js";

export default function HighwayBackground({ background, videoRef, onVideoReady }) {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (background?.type !== "video") return;
    let active = true;
    resolveVideoBackground(background).then(
      (url) => { if (active) setPreview({ background, url }); },
      (error) => { if (active) setPreview({ background, error: error.message || "Video preview unavailable." }); },
    );
    return () => { active = false; };
  }, [background]);

  if (background?.type === "image") return <img className="bg-layer" src={background.url} alt="" />;
  if (background?.type !== "video") return null;
  const current = preview?.background === background ? preview : null;
  if (!current) return <div className="video-preview-status" role="status">Preparing video preview in the background…</div>;
  if (current.error) return <div className="video-preview-status" role="status">Video preview unavailable. Audio is still ready.<span>{current.error}</span></div>;
  if (!current.url) return <div className="video-preview-status" role="status">This file has no video track. Audio is ready.</div>;
  return <video ref={videoRef} className="bg-layer" src={current.url} muted loop playsInline onLoadedData={onVideoReady} />;
}
