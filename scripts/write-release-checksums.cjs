#!/usr/bin/env node
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");

const RELEASE_DIR = path.resolve(process.argv[2] || path.join(__dirname, "..", "release"));
const OUTPUT_NAME = "SHA256SUMS.txt";
const ARTIFACT_EXTS = new Set([
  ".appimage",
  ".dmg",
  ".zip",
  ".exe",
  ".msi",
  ".deb",
  ".rpm",
  ".blockmap",
  ".yml",
]);

function isReleaseArtifact(name) {
  const lower = name.toLowerCase();
  if (lower === OUTPUT_NAME.toLowerCase() || lower === "builder-debug.yml") return false;
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tar.xz") || lower.endsWith(".tar.zst")) return true;
  return ARTIFACT_EXTS.has(path.extname(lower));
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fsSync.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const entries = await fs.readdir(RELEASE_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && isReleaseArtifact(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (!files.length) {
    throw new Error(`No release artifacts found in ${RELEASE_DIR}`);
  }

  const lines = [];
  for (const file of files) {
    const digest = await sha256File(path.join(RELEASE_DIR, file));
    lines.push(`${digest}  ${file}`);
  }

  const outputPath = path.join(RELEASE_DIR, OUTPUT_NAME);
  await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`Wrote ${outputPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
