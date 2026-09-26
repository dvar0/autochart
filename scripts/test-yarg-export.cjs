"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const library = require("../electron/libraryStore.cjs");
const { writeChartText } = require("../shared/chartWriter.cjs");
const { readBuild } = require("./prepare-ffmpeg.cjs");

// Exact Core submodule of YARG v0.15.0. Keep upstream code outside this repo
// and the application package. See docs/yarg-compatibility.md for setup.
const CORE_REVISION = "3beb94e526558134145bcd3e409428f759001a40";
async function main() {
  const core = process.env.AUTOCHART_YARG_CORE_PATH;
  if (!core) throw new Error("Set AUTOCHART_YARG_CORE_PATH to the pinned YARG.Core checkout; see docs/yarg-compatibility.md.");
  assert.equal(execFileSync("git", ["-C", core, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), CORE_REVISION);
  assert.equal(execFileSync("git", ["-C", core, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "", "YARG.Core must have no tracked modifications");
  const { executable } = readBuild();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-yarg-export-"));
  const previous = process.env.AUTOCHART_FFMPEG_PATH;
  process.env.AUTOCHART_FFMPEG_PATH = executable;
  try {
    const { buildFinalChartVersion } = await import("../src/services/finalChart.js");
    const context = { userDataPath: root, projectsFolder: path.join(root, "projects"), cacheFolder: path.join(root, "cache") };
    const source = path.join(root, "source.ogg");
    execFileSync(executable, ["-hide_banner", "-loglevel", "error", "-i", path.join(__dirname, "..", "fixtures", "demo", "autochart-demo-30s.wav"), "-c:a", "libvorbis", source]);
    const expected = [];
    const difficulties = ["easy", "medium", "hard", "expert"];
    for (const id of [...difficulties, "final", "offset", "padded"]) {
      const resolution = id === "offset" ? 480 : 192;
      const offset = id === "offset" ? -0.25 : 0;
      const versions = difficulties.map(difficulty => ({
        id: difficulty, source: "generated", settings: { difficulty },
        chart: { text: writeChartText([
          [resolution, 0, resolution / 2], [resolution, 2, resolution / 2],
          [resolution * 2, 1, 0], [resolution * 2, 5, 0],
          [resolution * 3, 3, 0], [resolution * 3, 6, 0],
          [resolution * 4, 7, resolution / 2], [resolution * 5, 4, 0],
        ], { title: id, difficulty, resolution, offset, syncLines: ["0 = TS 4 2", "0 = B 120000", `${resolution * 4} = B 150000`] }).text },
      }));
      const selected = id === "final"
        ? buildFinalChartVersion({ versions, slots: Object.fromEntries(difficulties.map(d => [d, d])) }).finalVersion
        : versions.find(v => v.id === id) || versions[3];
      const project = path.join(context.projectsFolder, id);
      await fs.mkdir(project, { recursive: true });
      await fs.copyFile(source, path.join(project, "song.ogg"));
      await fs.copyFile(path.join(__dirname, "..", "fixtures", "clone-hero-export", "source-vp9.webm"), path.join(project, "video.webm"));
      if (id === "padded") {
        const engine = path.join(context.cacheFolder, "engine");
        await fs.mkdir(engine, { recursive: true });
        const padded = path.join(engine, "padded.flac");
        execFileSync(executable, ["-hide_banner", "-loglevel", "error", "-i", source,
          "-filter_complex", "anullsrc=channel_layout=stereo:sample_rate=48000:d=2[s];[0:a]aresample=48000,asetpts=PTS-STARTPTS[a];[s][a]concat=n=2:v=0:a=1[out]",
          "-map", "[out]", "-c:a", "flac", padded]);
        selected.meta = { analysisAudioPath: padded, leadInSilenceMs: 2000, durationSec: 32 };
      }
      const title = `YARG ${id} – "quotes" \\ path`;
      await fs.writeFile(path.join(project, "song.json"), JSON.stringify({
        schemaVersion: 2, id, meta: { title, artist: "Autochart", genre: "Progressive Rock", durationSec: 30 },
        settings: {}, chart: selected.chart, versions: [selected],
        assets: { audio: "song.ogg", background: { type: "video", file: "video.webm" } },
      }));
      const dest = path.join(root, "Songs", id);
      await fs.mkdir(dest, { recursive: true });
      // YARG prioritizes old MIDI over notes.chart, including case variants.
      await fs.writeFile(path.join(dest, "NOTES.MID"), "stale MIDI from an older export");
      await fs.writeFile(path.join(dest, "notes.midi"), "another stale MIDI");
      await fs.writeFile(path.join(dest, "song.ini"), "[song]\nautochart_export = 1\n");
      await library.exportSongToFolder(context, id, dest);
      expected.push({ id, title, resolution, offsetMs: offset * 1000,
        durationMs: id === "padded" ? 32000 : 30000, videoStartMs: id === "padded" ? -2000 : 0,
        difficulties: id === "final" ? difficulties : [difficulties.includes(id) ? id : "expert"] });
    }
    await fs.writeFile(path.join(root, "expected.json"), JSON.stringify(expected));
    const harness = path.join(root, "Harness");
    await fs.mkdir(harness);
    await fs.copyFile(path.join(__dirname, "yarg-export", "Program.cs"), path.join(harness, "Program.cs"));
    const xmlPath = path.join(path.resolve(core), "YARG.Core", "YARG.Core.csproj").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    await fs.writeFile(path.join(harness, "Harness.csproj"), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><ProjectReference Include="${xmlPath}" /></ItemGroup></Project>`);
    execFileSync("dotnet", ["run", "--project", path.join(harness, "Harness.csproj"), "--configuration", "Release", "--", root], { stdio: "inherit" });
  } finally {
    if (previous == null) delete process.env.AUTOCHART_FFMPEG_PATH;
    else process.env.AUTOCHART_FFMPEG_PATH = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
