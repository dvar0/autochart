import { AlbumArt } from "./index.jsx";

// A library song's cover: its own image, or its generated one.
export default function SongCover({ song, showLabel }) {
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
  return <AlbumArt seed={song.artSeed} label={song.artist} showLabel={showLabel} />;
}
