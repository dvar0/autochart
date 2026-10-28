const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

// Development only (AUTOCHART_UPDATE_PREVIEW=1): pretends to run an older
// version and serves a made-up newer release, so the rail notice, update sheet
// and What's new can be clicked through. Downloads are simulated and install
// only says what would happen.
const PREVIEW_BYTES = Buffer.from("Autochart update preview\n");
// Any picture does; this one is already in the repository.
const PREVIEW_IMAGE = path.join(__dirname, "..", "docs", "screenshots", "generate-dark.png");

function createUpdatePreview({ runningVersion = "0.2.0", offeredVersion = "0.3.0", important = true, platform, arch }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const target = `${platform}-${arch}`;
  const installMode = platform === "linux" ? "replace" : platform === "win32" ? "installer" : "dmg";
  const extension = { replace: "AppImage", installer: "exe", dmg: "dmg" }[installMode];
  const imageBytes = require("fs").readFileSync(PREVIEW_IMAGE);
  const payload = JSON.stringify({
    schemaVersion: 1,
    product: "Autochart",
    version: offeredVersion,
    important,
    headline: "Fretformer 3 is here",
    image: {
      name: "update-preview.png",
      url: "https://example.invalid/preview.png",
      size: imageBytes.length,
      sha256: crypto.createHash("sha256").update(imageBytes).digest("hex"),
    },
    sub: "Charts that sound like they were made by hand, on every difficulty.",
    features: [
      { icon: "spark", title: "Fretformer 3", text: "Better chords and sustains, and real Easy and Medium charts." },
      { icon: "music", title: "Drum charts", text: "Generate drums next to guitar, from the same song." },
    ],
    fixes: [
      "Inpaint keeps solos when you redo a section.",
      "Faster separation on AMD GPUs.",
      "Fixed lyrics in YARG exports.",
      "Long songs no longer stop charting after six minutes.",
      "The take list remembers where you scrolled.",
      "Exports keep the album art's colors.",
    ],
    notesUrl: "https://github.com/dvar0/autochart/releases",
    page: "https://github.com/dvar0/autochart/releases",
    files: {
      [target]: {
        name: `Autochart-${offeredVersion}-preview.${extension}`,
        url: "https://example.invalid/preview",
        size: 395_601_819,
        sha256: crypto.createHash("sha256").update(PREVIEW_BYTES).digest("hex"),
      },
    },
  });
  const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString("base64");

  return {
    currentVersion: runningVersion,
    installMode,
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
    fetchText: async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return JSON.stringify({ payload, signature });
    },
    // About six seconds of progress, then a stand-in file.
    downloadFile: async ({ targetPath, onProgress }) => {
      for (let percent = 0; percent <= 100; percent += 4) {
        onProgress?.({ percent });
        await new Promise((resolve) => setTimeout(resolve, 240));
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, PREVIEW_BYTES);
      return { path: targetPath };
    },
    downloadImage: async ({ targetPath }) => {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, imageBytes);
      return { path: targetPath };
    },
    installMessage: {
      replace: `Autochart would now replace its AppImage with ${offeredVersion} and restart.`,
      installer: `The ${offeredVersion} installer would now run, and Autochart would close and reopen.`,
      dmg: `The ${offeredVersion} disk image would now open, and Autochart would close.`,
    }[installMode],
  };
}

module.exports = { createUpdatePreview };
