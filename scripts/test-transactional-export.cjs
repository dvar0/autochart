const assert = require("assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const libraryStore = require("../electron/libraryStore.cjs");

async function snapshotDirectory(dir) {
  const entries = (await fs.readdir(dir)).sort();
  const snapshot = {};
  for (const name of entries) {
    const stat = await fs.stat(path.join(dir, name));
    if (stat.isFile()) snapshot[name] = await fs.readFile(path.join(dir, name), "utf8");
  }
  return snapshot;
}

async function assertNoWorkDirectories(parent, destName) {
  const entries = await fs.readdir(parent);
  assert.equal(
    entries.some((name) => name.startsWith(`.${destName}.autochart-stage-`)),
    false,
    "staging directory leaked"
  );
  assert.equal(
    entries.some((name) => name.startsWith(`.${destName}.autochart-backup-`)),
    false,
    "backup directory leaked"
  );
}

async function writeManifest(projectDir, assets) {
  await fs.writeFile(
    path.join(projectDir, "song.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: "transaction-song",
      meta: { title: "New Export", artist: "Autochart", charter: "Harness" },
      settings: { difficulty: "expert" },
      chart: { text: "[Song]\n{\n  Name = New Export\n}\n" },
      assets,
    })
  );
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-export-transaction-"));
  const previousFfmpeg = process.env.AUTOCHART_FFMPEG_PATH;
  try {
    const projectsFolder = path.join(root, "projects");
    const projectDir = path.join(projectsFolder, "transaction-song");
    const exportParent = path.join(root, "exports");
    const destDir = path.join(exportParent, "Existing Export");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "song.ogg"), "new audio");
    await fs.writeFile(path.join(projectDir, "song.wav"), "not a real wav");
    await fs.writeFile(path.join(destDir, "notes.chart"), "old chart");
    await fs.writeFile(path.join(destDir, "song.ini"), "[song]\nname = Old\nautochart_export = 1\n");
    await fs.writeFile(path.join(destDir, "song.ogg"), "old audio");
    await fs.writeFile(path.join(destDir, "keep-old.txt"), "prior export sentinel");
    await fs.writeFile(path.join(destDir, "video.mp4"), "stale known asset");
    await fs.writeFile(path.join(destDir, "NOTES.MID"), "stale preferred MIDI");
    await fs.writeFile(path.join(destDir, "notes.midi"), "stale alternate MIDI");
    await fs.writeFile(path.join(destDir, "SONG.MP3"), "stale case-variant audio");

    const context = {
      userDataPath: path.join(root, "user-data"),
      projectsFolder,
      cacheFolder: path.join(root, "cache"),
    };
    const before = await snapshotDirectory(destDir);

    // A same-named folder holding someone else's chart must never be replaced,
    // including when marker text appears as a non-affirmative value, in a
    // comment, outside [song], or in the wrong field.
    await writeManifest(projectDir, { audio: "song.ogg", albumArt: null });
    const legacyPhrase = "Contains AI-generated guitar difficulties: expert,hard. Generated with Autochart.";
    const foreignInis = {
      "Foreign Song": "[song]\nname = Foreign\ncharter = Someone\n",
      "Marker Zero": "[song]\nname = Foreign\nautochart_export = 0\n",
      "Provenance Zero": "[song]\nautochart_provenance_version = 0\n",
      "Comment Phrase": "[song]\nname = Foreign\n; Not Generated with Autochart.\n",
      "Other Section": "[song]\nname = Foreign\n[example]\nautochart_export = 1\n",
      "Commented Marker": "[song]\n; autochart_export = 1\n# autochart_export = 1\n",
      "Negated Phrase": "[song]\nloading_phrase = Not Generated with Autochart.\n",
      "Phrase Elsewhere": `[song]\nname = ${legacyPhrase}\n`,
      "Overridden Marker": "[song]\nautochart_export = 1\nautochart_export = 0\n",
      "Before Section": "autochart_export = 1\n[song]\nname = Foreign\n",
    };
    for (const [folder, iniText] of Object.entries(foreignInis)) {
      const foreignDir = path.join(exportParent, folder);
      await fs.mkdir(foreignDir);
      await fs.writeFile(path.join(foreignDir, "notes.chart"), "hand-authored chart");
      await fs.writeFile(path.join(foreignDir, "song.ini"), iniText);
      await fs.writeFile(path.join(foreignDir, "song.ogg"), "original audio");
      const foreignBefore = await snapshotDirectory(foreignDir);
      await assert.rejects(
        libraryStore.exportSongToFolder(context, "transaction-song", foreignDir),
        /not exported by Autochart/,
        `${folder}: export must refuse a folder Autochart did not create`
      );
      assert.deepEqual(await snapshotDirectory(foreignDir), foreignBefore, `${folder}: export replaced a foreign song`);
      await assertNoWorkDirectories(exportParent, folder);
    }

    // Genuine exports, including ones written before `autochart_export` existed.
    const ownedInis = {
      "Marked Export": "[song]\nname = Old\nautochart_export = 1\n",
      "Legacy Provenance": "[Song]\nname = Old\nautochart_provenance_version = 1\n",
      "Legacy Phrase": `\uFEFF[song]\r\nname = Old\r\nloading_phrase = ${legacyPhrase}\r\n`,
    };
    for (const [folder, iniText] of Object.entries(ownedInis)) {
      const ownedDir = path.join(exportParent, folder);
      await fs.mkdir(ownedDir);
      await fs.writeFile(path.join(ownedDir, "notes.chart"), "old chart");
      await fs.writeFile(path.join(ownedDir, "song.ini"), iniText);
      await fs.writeFile(path.join(ownedDir, "keep.txt"), "custom file");
      await libraryStore.exportSongToFolder(context, "transaction-song", ownedDir);
      assert.match(await fs.readFile(path.join(ownedDir, "notes.chart"), "utf8"), /New Export/, `${folder}: re-export must replace the chart`);
      assert.match(await fs.readFile(path.join(ownedDir, "song.ini"), "utf8"), /^autochart_export = 1$/m, `${folder}: re-export must mark ownership`);
      assert.equal(await fs.readFile(path.join(ownedDir, "keep.txt"), "utf8"), "custom file");
      await assertNoWorkDirectories(exportParent, folder);
    }

    await writeManifest(projectDir, { audio: "song.ogg", albumArt: "missing.png" });
    await assert.rejects(
      libraryStore.exportSongToFolder(context, "transaction-song", destDir),
      (err) => err?.code === "ENOENT"
    );
    assert.deepEqual(await snapshotDirectory(destDir), before, "copy failure changed prior export");
    await assertNoWorkDirectories(exportParent, path.basename(destDir));

    await writeManifest(projectDir, { audio: "song.wav", albumArt: null });
    process.env.AUTOCHART_FFMPEG_PATH = path.join(root, "missing-ffmpeg");
    await assert.rejects(
      libraryStore.exportSongToFolder(context, "transaction-song", destDir),
      /ffmpeg is required|ENOENT|spawn/
    );
    assert.deepEqual(await snapshotDirectory(destDir), before, "FFmpeg failure changed prior export");
    await assertNoWorkDirectories(exportParent, path.basename(destDir));

    if (previousFfmpeg == null) delete process.env.AUTOCHART_FFMPEG_PATH;
    else process.env.AUTOCHART_FFMPEG_PATH = previousFfmpeg;
    await fs.writeFile(path.join(projectDir, "album.png"), "new album");
    await writeManifest(projectDir, { audio: "song.ogg", albumArt: "album.png" });
    const result = await libraryStore.exportSongToFolder(
      context,
      "transaction-song",
      destDir
    );
    assert.equal(result.path, path.resolve(destDir));
    assert.equal(await fs.readFile(path.join(destDir, "notes.chart"), "utf8"), '[Song]\n{\n  Name = New Export\n  Charter = "Harness"\n}\n');
    assert.equal(await fs.readFile(path.join(destDir, "song.ogg"), "utf8"), "new audio");
    assert.equal(await fs.readFile(path.join(destDir, "album.png"), "utf8"), "new album");
    assert.equal(
      await fs.readFile(path.join(destDir, "keep-old.txt"), "utf8"),
      "prior export sentinel",
      "successful export removed an unrelated destination file"
    );
    await assert.rejects(fs.access(path.join(destDir, "video.mp4")));
    for (const name of ["NOTES.MID", "notes.midi", "SONG.MP3"]) {
      await assert.rejects(fs.access(path.join(destDir, name)), { code: "ENOENT" });
    }
    await assertNoWorkDirectories(exportParent, path.basename(destDir));

    const successful = await snapshotDirectory(destDir);
    const symlinkDest = path.join(exportParent, "Symlink Export");
    await fs.symlink(
      destDir,
      symlinkDest,
      process.platform === "win32" ? "junction" : "dir"
    );
    await assert.rejects(
      libraryStore.exportSongToFolder(context, "transaction-song", symlinkDest),
      /cannot be a symbolic link/
    );
    assert.deepEqual(
      await snapshotDirectory(destDir),
      successful,
      "symlink rejection changed its target"
    );
    assert.equal((await fs.lstat(symlinkDest)).isSymbolicLink(), true);
    await assertNoWorkDirectories(exportParent, path.basename(symlinkDest));

    console.log("transactional export: copy and FFmpeg failures preserved the prior export");
    console.log("transactional export: successful swap preserved unrelated files and removed stale known assets");
    console.log("transactional export: symlink destination rejected; stage/backup cleaned");
  } finally {
    if (previousFfmpeg == null) delete process.env.AUTOCHART_FFMPEG_PATH;
    else process.env.AUTOCHART_FFMPEG_PATH = previousFfmpeg;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
