"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { readBuild } = require("./prepare-ffmpeg.cjs");
const library = require("../electron/libraryStore.cjs");
const { writeChartText } = require("../shared/chartWriter.cjs");

// Exercise the real exporter and packaged codecs. These are documentation-based
// contracts, not an assertion that Clone Hero itself has loaded the result.
async function main() {
  const build = readBuild();
  const previousFfmpeg = process.env.AUTOCHART_FFMPEG_PATH;
  process.env.AUTOCHART_FFMPEG_PATH = build.executable;
  const run = (args) => execFileSync(build.executable, ["-hide_banner", "-loglevel", "error", ...args], { maxBuffer: 16 * 1024 * 1024 });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-clone-hero-"));
  try {
    const fixtures = path.join(__dirname, "..", "fixtures", "clone-hero-export");
    const context = { userDataPath: root, projectsFolder: path.join(root, "projects"), cacheFolder: path.join(root, "cache") };
    const project = path.join(context.projectsFolder, "compatibility");
    const dest = path.join(root, "Songs", "Compatibility");
    await fs.mkdir(project, { recursive: true });
    await fs.copyFile(path.join(__dirname, "..", "fixtures", "demo", "autochart-demo-30s.wav"), path.join(project, "song.wav"));
    const videos = ["source-vp9.webm", "source-av1.webm", "source-av1-10bit.mp4"];
    for (const file of ["image.gif", "image.webp", ...videos]) {
      await fs.copyFile(path.join(fixtures, file), path.join(project, file));
      // Exercise timestamps that round up when project staging preserves them.
      await fs.utimes(path.join(project, file), 1700000000.12375, 1700000000.12375);
    }
    const versions = ["easy", "medium", "hard", "expert"].map((difficulty) => ({
      id: difficulty,
      source: "generated",
      settings: { difficulty },
      chart: { text: writeChartText([[192, 0, 96], [384, 2, 0], [384, 5, 0], [576, 3, 0], [576, 6, 0], [768, 7, 96]], {
        difficulty, syncLines: ["0 = TS 4 2", "0 = B 120000", "768 = B 150000"],
      }).text },
    }));
    const record = {
      schemaVersion: 2, id: "compatibility",
      meta: { title: "   ", artist: "Artist\nname = injected", durationSec: 30 },
      settings: { activeVersionId: "expert" },
      chart: versions[0].chart, versions,
      assets: { audio: "song.wav", albumArt: "image.webp", background: { type: "image", file: "image.gif" } },
    };
    const save = () => fs.writeFile(path.join(project, "song.json"), JSON.stringify(record));
    const ini = () => fs.readFile(path.join(dest, "song.ini"), "utf8");
    const jpeg = async (name) => {
      const bytes = await fs.readFile(path.join(dest, name));
      assert.equal(bytes.subarray(0, 3).toString("hex"), "ffd8ff", `${name} must contain JPEG bytes`);
      const inspected = spawnSync(build.executable, ["-hide_banner", "-i", path.join(dest, name)], { encoding: "utf8" });
      assert.match(inspected.stderr, /Video: mjpeg/);
      assert.match(inspected.stderr, /16x16/);
    };
    await save();
    for (const version of versions) {
      await library.exportSongToFolder(context, record.id, dest, { versionId: version.id });
      const exported = await fs.readFile(path.join(dest, "notes.chart"), "utf8");
      assert.equal(exported.slice(exported.indexOf("[SyncTrack]")), version.chart.text.slice(version.chart.text.indexOf("[SyncTrack]")), "export metadata must not change timing or tracks");
      assert.match(exported, /autochart_ai_generated = "true"/);
      assert.match(await ini(), /^charter = Autochart$/m);
    }
    assert.match(await ini(), /^\[song\]\nname = Untitled\n/);
    assert.match(await ini(), /^artist = Artist name = injected$/m);
    assert.equal((await ini()).match(/^name = /gm).length, 1);
    assert.match(await ini(), /^song_length = 30000$/m);
    assert.match(await ini(), /^background = background.jpg$/m);
    assert.doesNotMatch(await ini(), /^diff_guitar|^video/m);
    await jpeg("album.jpg");
    await jpeg("background.jpg");
    const ogg = await fs.readFile(path.join(dest, "song.ogg"));
    assert.equal(ogg.subarray(0, 4).toString(), "OggS");
    assert(ogg.includes(Buffer.from("\x01vorbis")), "audio must be Vorbis, not just an Ogg filename");
    const pcm = run(["-i", path.join(dest, "song.ogg"), "-ar", "22050", "-ac", "1", "-f", "f32le", "pipe:1"]);
    assert(Math.abs(pcm.length / 4 / 22050 - 30) < 0.1);

    // Reverse the image roles; both routes must transcode both input formats.
    record.assets.albumArt = "image.gif";
    record.assets.background.file = "image.webp";
    await save();
    await library.exportSongToFolder(context, record.id, dest);
    await jpeg("album.jpg");
    await jpeg("background.jpg");

    const engine = path.join(context.cacheFolder, "engine");
    await fs.mkdir(engine, { recursive: true });
    const padded = path.join(engine, "padded.flac");
    run(["-i", path.join(project, "song.wav"), "-filter_complex", "anullsrc=channel_layout=stereo:sample_rate=48000:d=2[s];[0:a]aresample=48000,asetpts=PTS-STARTPTS[a];[s][a]concat=n=2:v=0:a=1[out]", "-map", "[out]", "-c:a", "flac", padded]);
    record.versions[3].meta = { analysisAudioPath: padded, leadInSilenceMs: 2000, durationSec: 32 };
    assert.match(run(["-decoders"]).toString(), /libdav1d/, "bundled FFmpeg must include software AV1 decoding");
    for (const video of videos) {
      const sourceBytes = await fs.readFile(path.join(project, video));
      record.assets.background = { type: "video", file: video };
      await save();
      await library.exportSongToFolder(context, record.id, dest);
      assert.match(await ini(), /^video = video.webm$/m);
      assert.match(await ini(), /^video_start_time = -2000$/m);
      assert.match(await ini(), /^song_length = 32000$/m);
      await assert.rejects(fs.access(path.join(dest, "background.jpg")));
      const inspected = spawnSync(build.executable, ["-hide_banner", "-i", path.join(dest, "video.webm")], { encoding: "utf8" });
      assert.match(inspected.stderr, /Video: vp8/);
      assert.match(inspected.stderr, /Duration: 00:00:00\.50/);
      assert.doesNotMatch(inspected.stderr, /Audio:/);
      // Decode every exported frame: a VP8 header alone cannot prove conversion.
      const frames = path.join(root, `${video}-frames`);
      await fs.mkdir(frames);
      run(["-i", path.join(dest, "video.webm"), "-c:v", "mjpeg", "-pix_fmt", "yuvj420p", path.join(frames, "%02d.jpg")]);
      assert.equal((await fs.readdir(frames)).length, 5, `${video}: all five frames must decode`);
      assert.deepEqual(await fs.readFile(path.join(project, video)), sourceBytes, "export must retain the original background");
      const exportedVideo = await fs.readFile(path.join(dest, "video.webm"));
      // Exercise the actual Save path: persist the final chart before export.
      // No encoder may be needed again for unchanged media after project staging.
      await library.patchSong(context, { record: { id: record.id, meta: { title: "Saved again" } } });
      process.env.AUTOCHART_FFMPEG_PATH = path.join(root, "encoder-must-not-run");
      try {
        await library.exportSongToFolder(context, record.id, dest);
      } finally {
        process.env.AUTOCHART_FFMPEG_PATH = build.executable;
      }
      assert.deepEqual(await fs.readFile(path.join(dest, "video.webm")), exportedVideo, "cached export must retain the converted video");
    }

    // Keep custom files (including nested managed names), remove competing root
    // assets, and don't read/copy the old media just to discard it afterward.
    await fs.mkdir(path.join(dest, "extras"));
    await fs.writeFile(path.join(dest, "extras", "song.ogg"), "custom nested audio");
    await fs.writeFile(path.join(dest, "NOTES.MID"), "obsolete chart");
    await fs.writeFile(path.join(dest, "SONG.MP3"), "obsolete audio");
    const originalCopyFile = fs.copyFile;
    const originalCp = fs.cp;
    let skippedExportAssets = 0;
    fs.cp = async (source, target, options) => originalCp(source, target, {
      ...options,
      filter: async (candidate, destination) => {
        const keep = options.filter ? await options.filter(candidate, destination) : true;
        if (path.dirname(candidate) === dest && path.basename(candidate) !== "extras") {
          assert.equal(keep, false, "must skip replaced root export assets before copying");
          skippedExportAssets++;
        }
        return keep;
      },
    });
    fs.copyFile = async (source, ...args) => {
      assert.notEqual(path.dirname(String(source)), dest, "must not copy replaced root export assets");
      return originalCopyFile(source, ...args);
    };
    try {
      await library.exportSongToFolder(context, record.id, dest);
    } finally {
      fs.copyFile = originalCopyFile;
      fs.cp = originalCp;
    }
    assert(skippedExportAssets >= 5, "expected chart, metadata and media to be skipped");
    assert.equal(await fs.readFile(path.join(dest, "extras", "song.ogg"), "utf8"), "custom nested audio");
    await assert.rejects(fs.access(path.join(dest, "NOTES.MID")), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(dest, "SONG.MP3")), { code: "ENOENT" });
    // File clones must be independent: editing game-library media cannot alter
    // the project cache or corrupt the next export.
    const originalVideo = await fs.readFile(path.join(dest, "video.webm"));
    await fs.writeFile(path.join(dest, "video.webm"), "external game-library edit");
    await library.exportSongToFolder(context, record.id, dest);
    assert.deepEqual(await fs.readFile(path.join(dest, "video.webm")), originalVideo);
    await fs.mkdir(path.join(dest, "notes.mid"));
    await fs.writeFile(path.join(dest, "notes.mid", "keep.txt"), "user data");
    await assert.rejects(library.exportSongToFolder(context, record.id, dest), /Cannot replace export asset directory/);
    assert.equal(await fs.readFile(path.join(dest, "notes.mid", "keep.txt"), "utf8"), "user data");
    await fs.rm(path.join(dest, "notes.mid"), { recursive: true });
    const saved = await library.saveSongToCloneHeroLibrary(context, record.id, path.join(root, "GameLibrary"));
    assert.deepEqual(await fs.readFile(path.join(saved.path, "video.webm")), await fs.readFile(path.join(dest, "video.webm")), "library save must include the AV1-derived video");
    const paddedPcm = run(["-i", path.join(dest, "song.ogg"), "-ar", "22050", "-ac", "1", "-f", "f32le", "pipe:1"]);
    assert(Math.abs(paddedPcm.length / 4 / 22050 - 32) < 0.1);
    assert(paddedPcm.subarray(0, 22050 * 4).every(byte => byte === 0));

    // An image conversion failure must preserve the previous complete export.
    const goodIni = await ini();
    const goodArt = await fs.readFile(path.join(dest, "album.jpg"));
    await fs.writeFile(path.join(project, "broken.gif"), "invalid GIF");
    record.assets.albumArt = "broken.gif";
    await save();
    await assert.rejects(library.exportSongToFolder(context, record.id, dest), /Could not convert "broken.gif" for Clone Hero \/ YARG/);
    assert.equal(await ini(), goodIni);
    assert.deepEqual(await fs.readFile(path.join(dest, "album.jpg")), goodArt);

    // A failed video conversion must be readable and preserve every export file.
    record.assets.albumArt = "image.gif";
    record.assets.background.file = "broken.mp4";
    await fs.writeFile(path.join(project, "broken.mp4"), "invalid video");
    await save();
    const snapshot = async () => Promise.all((await fs.readdir(dest, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name).sort().map(async name => [name, await fs.readFile(path.join(dest, name))]));
    const goodExport = await snapshot();
    await assert.rejects(library.exportSongToFolder(context, record.id, dest), error => {
      assert.match(error.message, /Could not convert "broken.mp4"/);
      assert.match(error.message, /Try replacing it/);
      assert.doesNotMatch(error.message, /0x|Error submitting|ffmpeg version|moov atom/);
      assert(error.stderr, "technical diagnostics must remain available to logs");
      return true;
    });
    assert.deepEqual(await snapshot(), goodExport);
    assert(!(await fs.readdir(path.dirname(dest))).some(name => name.includes(".autochart-stage-")));
    assert(!(await fs.readdir(path.join(project, ".export-cache"))).some(name => name.includes(".tmp-")));

    // The renderer must show the actionable message from either IPC export path.
    const { exportChart, saveChartToCloneHeroLibrary } = await import("../src/services/generation.js");
    const previousWindow = global.window;
    const userMessage = 'Could not convert "broken.mp4" for Clone Hero / YARG. Try replacing it.';
    try {
      for (const [action, invoke] of [["exportSong", exportChart], ["saveSongToCloneHeroLibrary", saveChartToCloneHeroLibrary]]) {
        const ipcError = new Error(`Error invoking remote method 'library:${action}': Error: ${userMessage}`);
        global.window = { autochart: { library: {
          isAvailable: () => true,
          getSong: async () => record,
          [action]: async () => { throw ipcError; },
        } } };
        await assert.rejects(invoke(record.id), error => {
          assert.equal(error.message, userMessage);
          assert.equal(error.cause, ipcError);
          return true;
        });
      }
    } finally {
      if (previousWindow === undefined) delete global.window;
      else global.window = previousWindow;
    }

    // Fail before altering an existing export if its required audio is absent.
    const before = await ini();
    record.versions[3].meta = {};
    delete record.assets.audio;
    await save();
    await assert.rejects(library.exportSongToFolder(context, record.id, dest), /Add song audio/);
    assert.equal(await ini(), before);
    console.log("Clone Hero export: four difficulties, metadata/audio, GIF/WebP, VP9/AV1 (8/10-bit) to VP8, cached video, padded timing and failed-conversion preservation passed.");
  } finally {
    if (previousFfmpeg == null) delete process.env.AUTOCHART_FFMPEG_PATH;
    else process.env.AUTOCHART_FFMPEG_PATH = previousFfmpeg;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
