"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const tar = require("tar");
const { readBuild, fileHash, buildEnvironment } = require("./prepare-ffmpeg.cjs");
const { inspectFfmpegSourceArchive } = require("./ffmpeg-source-gate.cjs");
(async () => {
  const cleanEnvironment = buildEnvironment({ PATH: process.env.PATH, AUTOCHART_ASSETS_BASE_URL: "private", CSC_LINK: "secret", APPLE_API_KEY: "secret", BASH_ENV: "injected", CFLAGS: "injected", AUTOCHART_BUILD_JOBS: "4" });
  for (const key of ["AUTOCHART_ASSETS_BASE_URL", "CSC_LINK", "APPLE_API_KEY", "BASH_ENV", "CFLAGS"]) assert.equal(cleanEnvironment[key], undefined, `Build must not inherit ${key}`);
  assert.equal(cleanEnvironment.AUTOCHART_BUILD_JOBS, "4");
  assert.throws(() => buildEnvironment({ AUTOCHART_BUILD_JOBS: "--eval=bad" }), /integer/);
  assert.equal(buildEnvironment({ SDKROOT: os.tmpdir() }, "darwin").SDKROOT, os.tmpdir());
  assert.equal(buildEnvironment({ SDKROOT: os.tmpdir() }, "linux").SDKROOT, undefined);
  assert.throws(() => buildEnvironment({ SDKROOT: "relative-sdk" }, "darwin"), /installed macOS SDK/);
  const build = readBuild();
  await inspectFfmpegSourceArchive(build.sourceArchive);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autochart-source-test-"));
  try {
    const bad = path.join(root, "bad.tar.gz");
    fs.copyFileSync(build.sourceArchive, bad);
    fs.appendFileSync(bad, "tampered");
    await assert.rejects(inspectFfmpegSourceArchive(bad), /checksum mismatch/);
    await assert.rejects(inspectFfmpegSourceArchive(build.sourceArchive, { build, target: { platform: "wrong", arch: "x64" } }), /does not match/);
    // Rehashing an archive cannot conceal a changed upstream input or build recipe.
    const input = path.join(root, "ffmpeg-build.sh");
    fs.writeFileSync(input, "echo changed recipe\n");
    await tar.c({ cwd: root, file: bad, gzip: true }, ["ffmpeg-build.sh"]);
    await assert.rejects(inspectFfmpegSourceArchive(bad, { build: { ...build, sourceSha256: fileHash(bad) } }), /input checksum mismatch/);
    fs.writeFileSync(path.join(root, "unexpected.txt"), "unexpected");
    await tar.c({ cwd: root, file: bad, gzip: true }, ["unexpected.txt"]);
    await assert.rejects(inspectFfmpegSourceArchive(bad, { build: { ...build, sourceSha256: fileHash(bad) } }), /Unexpected FFmpeg source entry/);
    const projectDir = path.join(root, "project");
    const cached = path.join(projectDir, "node_modules", ".cache", "autochart-ffmpeg", `${process.platform}-${process.arch}`);
    fs.mkdirSync(cached, { recursive: true });
    fs.copyFileSync(path.join(build.directory, "build.json"), path.join(cached, "build.json"));
    fs.writeFileSync(path.join(cached, path.basename(build.executable)), "wrong binary");
    assert.throws(() => readBuild({ projectDir }), /checksum mismatch/);
    const receipt = JSON.parse(fs.readFileSync(path.join(cached, "build.json")));
    receipt.recipeSha256 = "0".repeat(64);
    fs.writeFileSync(path.join(cached, "build.json"), JSON.stringify(receipt));
    assert.throws(() => readBuild({ projectDir }), /stale/);
    console.log("FFmpeg source/executable binding and archive tamper checks passed.");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
