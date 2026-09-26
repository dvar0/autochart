"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const AdmZip = require("adm-zip");
const { stagePublicRelease } = require("./stage-public-release.cjs");

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-public-staging-"));
  try {
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    git("init");
    await fs.writeFile(path.join(repo, "fixture.txt"), "original source\n");
    git("add", "fixture.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Source fixture");
    const source = git("archive", "--format=tar.gz", "HEAD");
    const inputs = [];
    const originals = new Map();
    for (const [id, osName, binaries] of [
      ["linux-x64", "linux", ["linux-x86_64.AppImage"]],
      ["win32-x64", "windows", ["win-x64.exe", "win-x64.zip"]],
      ["darwin-arm64", "macos", ["arm64.dmg"]],
    ]) {
      const dir = path.join(root, id);
      await fs.mkdir(dir);
      inputs.push(dir);
      const files = new Map([
        ["Autochart-0.1.0-source.tar.gz", source],
        [`Autochart-0.1.0-${osName}-${id.split("-")[1]}-ffmpeg-corresponding-source.tar.gz`, Buffer.from(`exact ${id} FFmpeg source`)],
        ...binaries.map((suffix) => [`Autochart-0.1.0-${suffix}`, Buffer.from(`binary ${suffix}`)]),
        ["unused.blockmap", Buffer.from("unused update metadata")],
      ]);
      files.set("SHA256SUMS.txt", Buffer.from([...files].map(([name, bytes]) => `${hash(bytes)}  ${name}\n`).join("")));
      for (const [name, bytes] of [...files]) {
        if (name.endsWith(".tar.gz")) files.set(`${name}.sha256`, Buffer.from(`${hash(bytes)}  ${name}\n`));
      }
      files.set("UNSIGNED-RELEASE.txt", Buffer.from(`Target: ${id}\nOriginal warning text\n`));
      files.set("builder-debug.yml", Buffer.from("private runner diagnostics"));
      for (const [name, bytes] of files) {
        await fs.writeFile(path.join(dir, name), bytes);
        originals.set(path.join(dir, name), bytes);
      }
    }
    const output = path.join(root, "ready");
    const result = await stagePublicRelease({ output, inputs, version: "0.1.0" });
    assert.equal(result.files.length, 6);
    const zip = new AdmZip(path.join(output, result.bundleName));
    assert.equal(zip.getEntries().length, 21);
    const manifest = JSON.parse(zip.readAsText("manifest.json"));
    assert.equal(manifest.commit, git("rev-parse", "HEAD").toString().trim());
    for (const target of manifest.targets) {
      assert(zip.readFile(target.applicationSource).equals(source));
      assert(zip.readFile(target.ffmpegSource).equals(originals.get(path.join(root, target.ffmpegSource))));
      for (const binary of target.binaries) {
        assert.equal(hash(await fs.readFile(path.join(output, binary.name))), binary.sha256);
      }
    }
    for (const line of zip.readAsText("SHA256SUMS.txt").trim().split("\n")) {
      const [expected, name] = line.split("  ");
      assert.equal(hash(zip.readFile(name)), expected);
    }
    for (const line of (await fs.readFile(path.join(output, "SHA256SUMS.txt"), "utf8")).trim().split("\n")) {
      const [expected, name] = line.split("  ");
      assert.equal(hash(await fs.readFile(path.join(output, name))), expected);
    }
    assert(!zip.getEntries().some((entry) => /blockmap|builder-debug/.test(entry.entryName)));
    await assert.rejects(stagePublicRelease({ output, inputs, version: "0.1.0" }), { code: "EEXIST" });

    const rejectedOutput = path.join(root, "rejected");
    const options = { output: rejectedOutput, inputs, version: "0.1.0" };
    const binary = path.join(inputs[0], "Autochart-0.1.0-linux-x86_64.AppImage");
    await fs.writeFile(binary, "tampered binary");
    await assert.rejects(stagePublicRelease(options), /Checksum mismatch/);
    await fs.writeFile(binary, originals.get(binary));
    const sidecar = path.join(inputs[0], "Autochart-0.1.0-source.tar.gz.sha256");
    await fs.writeFile(sidecar, `${"0".repeat(64)}  Autochart-0.1.0-source.tar.gz\n`);
    await assert.rejects(stagePublicRelease(options), /sidecar mismatch/);
    await fs.writeFile(sidecar, originals.get(sidecar));
    await assert.rejects(stagePublicRelease({ ...options, inputs: [inputs[0], inputs[0], inputs[2]] }), /duplicate native target/);

    // A validly checksummed source from another commit must still be refused.
    await fs.writeFile(path.join(repo, "fixture.txt"), "different source\n");
    git("add", "fixture.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Different fixture");
    const changed = git("archive", "--format=tar.gz", "HEAD");
    const sourcePath = path.join(inputs[0], "Autochart-0.1.0-source.tar.gz");
    const sumsPath = path.join(inputs[0], "SHA256SUMS.txt");
    await fs.writeFile(sourcePath, changed);
    await fs.writeFile(sidecar, `${hash(changed)}  Autochart-0.1.0-source.tar.gz\n`);
    await fs.writeFile(sumsPath, originals.get(sumsPath).toString().replace(hash(source), hash(changed)));
    await assert.rejects(stagePublicRelease(options), /different source commits/);
    for (const file of [sourcePath, sidecar, sumsPath]) await fs.writeFile(file, originals.get(file));
    await assert.rejects(fs.access(rejectedOutput), { code: "ENOENT" });
    for (const [file, bytes] of originals) assert((await fs.readFile(file)).equals(bytes), `Input changed: ${file}`);
    console.log("Public release staging: six assets, exact sources/binaries, inner/outer checksums, tamper and mixed-commit rejection passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
