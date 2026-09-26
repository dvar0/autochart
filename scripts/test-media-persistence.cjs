"use strict";

const assert = require("assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const { FileCapabilityRegistry } = require("../electron/fileCapabilities.cjs");
const { resolveLibrarySavePayload } = require("../electron/libraryPayload.cjs");
const libraryStore = require("../electron/libraryStore.cjs");
const {
  ROLE_POLICY,
  assertMediaAssetMetadata,
} = require("../electron/mediaAssetPolicy.cjs");
const {
  createMediaProtocolHandler,
  mediaAssetUrl,
  parseByteRange,
  parseMediaAssetUrl,
} = require("../electron/mediaProtocol.cjs");

function sender() {
  return { once() {} };
}

function chartText() {
  return [
    "[Song]",
    "{",
    "  Name = Test",
    "  Artist = Harness",
    "  Resolution = 192",
    "}",
    "[SyncTrack]",
    "{",
    "  0 = B 120000",
    "}",
    "[ExpertSingle]",
    "{",
    "  0 = N 0 0",
    "}",
    "",
  ].join("\n");
}

async function snapshotProject(dir) {
  const entries = (await fs.readdir(dir)).sort();
  const snapshot = {};
  for (const name of entries) {
    const stat = await fs.lstat(path.join(dir, name));
    if (stat.isFile()) snapshot[name] = await fs.readFile(path.join(dir, name));
  }
  return snapshot;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-media-persistence-"));
  try {
    const projectsFolder = path.join(root, "projects");
    const context = { userDataPath: path.join(root, "user-data"), projectsFolder };
    const streamingSource = path.join(root, "streaming-selected.ogg");
    const streamingDestination = path.join(root, "streaming-copy.ogg");
    const originalStreamingBytes = Buffer.alloc(128 * 1024, 0x41);
    await fs.writeFile(streamingSource, originalStreamingBytes);
    await fs.writeFile(streamingDestination, "prior");
    const streamingStat = await fs.lstat(streamingSource);
    let mutated = false;
    await assert.rejects(
      libraryStore.__test.atomicCopySelected(
        streamingDestination,
        {
          path: streamingSource,
          name: "streaming-selected.ogg",
          mime: "audio/ogg",
          size: streamingStat.size,
          lastModified: streamingStat.mtimeMs,
          device: streamingStat.dev,
          inode: streamingStat.ino,
        },
        "audio",
        null,
        {
          onChunk: async () => {
            if (mutated) return;
            mutated = true;
            await fs.writeFile(streamingSource, Buffer.alloc(originalStreamingBytes.length, 0x42));
          },
        }
      ),
      /changed while it was being cached/
    );
    assert.equal(mutated, true);
    assert.equal(await fs.readFile(streamingDestination, "utf8"), "prior");
    await fs.mkdir(projectsFolder);

    const selectedAudio = path.join(root, "selected.ogg");
    await fs.writeFile(selectedAudio, "path-backed-audio");
    const registry = new FileCapabilityRegistry();
    const owner = sender();
    const cap = await registry.register(owner, selectedAudio, {
      mime: "audio/ogg",
      purpose: "library:audio",
    });
    const rendererPayload = {
      record: {
        id: "media-project",
        meta: { title: "Media" },
        chart: { text: chartText() },
        assets: {},
      },
      assets: {
        audio: {
          name: "renderer-name.ogg",
          mime: "audio/ogg",
          source: { kind: "selected-file", token: cap.token },
        },
      },
    };
    const resolved = await resolveLibrarySavePayload(registry, owner, rendererPayload);
    assert.equal(Object.hasOwn(resolved.assets.audio, "data"), false);
    assert.equal(Object.hasOwn(resolved.assets.audio, "path"), false);
    assert.equal(resolved.assets.audio.name, "selected.ogg");
    const saved = await libraryStore.saveSong(context, resolved);
    assert.equal(
      await fs.readFile(path.join(projectsFolder, saved.id, saved.assets.audio), "utf8"),
      "path-backed-audio"
    );

    const collisionSaved = await libraryStore.saveSong(context, {
      record: {
        id: "collision-project",
        meta: { title: "Collision" },
        chart: { text: chartText() },
        assets: {},
      },
      assets: {
        audio: { name: "shared", mime: "audio/ogg", data: Buffer.from("old-audio") },
        albumArt: { name: "shared", mime: "image/png", data: Buffer.from("old-album") },
        background: {
          name: "shared",
          mime: "image/png",
          type: "image",
          data: Buffer.from("old-background"),
        },
      },
    });
    const collisionNames = [
      collisionSaved.assets.audio,
      collisionSaved.assets.albumArt,
      collisionSaved.assets.background.file,
    ];
    assert.equal(new Set(collisionNames).size, 3, "media roles reused a project filename");
    assert.match(collisionSaved.assets.audio, /^audio-/);
    assert.match(collisionSaved.assets.albumArt, /^album-/);
    assert.match(collisionSaved.assets.background.file, /^background-/);
    const collisionDir = path.join(projectsFolder, collisionSaved.id);
    assert.equal(await fs.readFile(path.join(collisionDir, collisionSaved.assets.audio), "utf8"), "old-audio");
    assert.equal(await fs.readFile(path.join(collisionDir, collisionSaved.assets.albumArt), "utf8"), "old-album");
    assert.equal(
      await fs.readFile(path.join(collisionDir, collisionSaved.assets.background.file), "utf8"),
      "old-background"
    );
    await fs.writeFile(path.join(collisionDir, "unrelated-user-file.txt"), "keep-me");

    const nextAudio = path.join(root, "next-shared.ogg");
    const missingBackground = path.join(root, "next-shared.png");
    await fs.writeFile(nextAudio, "new-audio");
    await fs.writeFile(missingBackground, "new-background");
    const nextAudioCap = await registry.register(owner, nextAudio, {
      mime: "audio/ogg",
      purpose: "library:audio",
    });
    const nextBackgroundCap = await registry.register(owner, missingBackground, {
      mime: "image/png",
      purpose: "library:background-image",
    });
    const failingUpdate = await resolveLibrarySavePayload(registry, owner, {
      record: {
        ...collisionSaved,
        meta: { title: "Should Not Commit" },
        chart: { text: `${chartText()}// should not commit\n` },
      },
      assets: {
        audio: {
          name: "shared",
          mime: "audio/ogg",
          source: { kind: "selected-file", token: nextAudioCap.token },
        },
        albumArt: {
          name: "shared",
          mime: "image/png",
          data: Buffer.from("new-album"),
        },
        background: {
          name: "shared",
          mime: "image/png",
          type: "image",
          source: { kind: "selected-file", token: nextBackgroundCap.token },
        },
      },
    });
    const beforeFailedUpdate = await snapshotProject(collisionDir);
    const beforeFailedStat = await fs.lstat(collisionDir);
    await fs.rm(missingBackground);
    await assert.rejects(
      libraryStore.saveSong(context, failingUpdate),
      /ENOENT|changed before it could be saved/
    );
    const afterFailedStat = await fs.lstat(collisionDir);
    assert.equal(afterFailedStat.dev, beforeFailedStat.dev);
    assert.equal(afterFailedStat.ino, beforeFailedStat.ino);
    assert.deepEqual(
      await snapshotProject(collisionDir),
      beforeFailedUpdate,
      "late media copy failure changed the live project"
    );
    assert.equal(
      (await fs.readdir(projectsFolder)).some((name) =>
        name.startsWith(`.${collisionSaved.id}.autochart-`)
      ),
      false,
      "project save leaked a staging or backup directory"
    );
    await assert.rejects(
      libraryStore.saveSong(
        context,
        {
          record: {
            ...collisionSaved,
            meta: { title: "Promotion Must Roll Back" },
            chart: { text: `${chartText()}// rollback\n` },
          },
          assets: {
            audio: {
              name: "shared",
              mime: "audio/ogg",
              data: Buffer.from("rollback-audio"),
            },
          },
        },
        { beforeStagePromote: async () => { throw new Error("injected promotion failure"); } }
      ),
      /injected promotion failure/
    );
    const afterRollbackStat = await fs.lstat(collisionDir);
    assert.equal(afterRollbackStat.dev, beforeFailedStat.dev);
    assert.equal(afterRollbackStat.ino, beforeFailedStat.ino);
    assert.deepEqual(
      await snapshotProject(collisionDir),
      beforeFailedUpdate,
      "promotion rollback did not restore the complete prior project"
    );
    assert.equal(
      (await fs.readdir(projectsFolder)).some((name) =>
        name.startsWith(`.${collisionSaved.id}.autochart-`)
      ),
      false,
      "promotion rollback leaked a staging or backup directory"
    );
    const committedUpdate = await libraryStore.saveSong(context, {
      record: {
        ...collisionSaved,
        meta: { title: "Committed Transaction" },
        chart: { text: `${chartText()}// committed\n` },
      },
      assets: {
        audio: {
          name: "shared",
          mime: "audio/ogg",
          data: Buffer.from("committed-audio"),
        },
      },
    });
    assert.notEqual(committedUpdate.assets.audio, collisionSaved.assets.audio);
    // Staging uses independent files even when the filesystem supports fast
    // clones. A write to an unchanged staged asset must never reach the live
    // project, and a failed save must leave the previous bytes intact.
    await assert.rejects(libraryStore.saveSong(context, {
      record: { ...committedUpdate, meta: { title: "Must not commit" } },
    }, { beforePromote: async () => {
      const stageName = (await fs.readdir(projectsFolder)).find(name =>
        name.startsWith(`.${committedUpdate.id}.autochart-stage-`));
      assert(stageName, "expected a staged project");
      await fs.writeFile(path.join(projectsFolder, stageName, committedUpdate.assets.audio), "staging-only edit");
      assert.equal(await fs.readFile(path.join(collisionDir, committedUpdate.assets.audio), "utf8"), "committed-audio");
      throw new Error("staged mutation rollback");
    } }), /staged mutation rollback/);
    // Hold a save after the old directory moves aside. A concurrent renderer
    // read must wait for promotion, rather than fail or return a partial chart.
    let releasePromotion;
    let reachedPromotion;
    const promotionReached = new Promise(resolve => { reachedPromotion = resolve; });
    const promotionHeld = new Promise(resolve => { releasePromotion = resolve; });
    const concurrentSave = libraryStore.saveSong(context, {
      record: { ...committedUpdate, chart: { text: `${chartText()}// committed\n` } },
    }, { beforeStagePromote: async () => { reachedPromotion(); await promotionHeld; } });
    await promotionReached;
    let readSettled = false;
    const concurrentRead = libraryStore.getSong(context, committedUpdate.id);
    concurrentRead.then(() => { readSettled = true; }, () => { readSettled = true; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(readSettled, false, "project read raced directory promotion");
    } finally {
      releasePromotion();
    }
    await concurrentSave;
    assert.equal((await concurrentRead).chart.text, `${chartText()}// committed\n`);
    assert.equal(
      await fs.readFile(path.join(collisionDir, committedUpdate.assets.audio), "utf8"),
      "committed-audio"
    );
    await assert.rejects(fs.access(path.join(collisionDir, collisionSaved.assets.audio)));
    assert.equal(
      await fs.readFile(path.join(collisionDir, collisionSaved.assets.albumArt), "utf8"),
      "old-album"
    );
    assert.equal(
      await fs.readFile(path.join(collisionDir, "unrelated-user-file.txt"), "utf8"),
      "keep-me"
    );

    // A null upload alone means no replacement. Only an explicit null in the
    // manifest clears a background, transactionally and without touching audio.
    const unchanged = await libraryStore.patchSong(context, {
      record: { id: collisionSaved.id, meta: { title: "Keep background" } },
      assets: { background: null },
    });
    assert.deepEqual(unchanged.assets.background, collisionSaved.assets.background);
    const beforeClear = await snapshotProject(collisionDir);
    await assert.rejects(libraryStore.saveSong(context, {
      record: { id: collisionSaved.id, assets: { background: null } },
    }, { beforePromote: () => { throw new Error("clear rollback"); } }), /clear rollback/);
    assert.deepEqual(await snapshotProject(collisionDir), beforeClear);
    await libraryStore.patchSong(context, {
      record: { id: collisionSaved.id, assets: { background: null } },
    });
    const cleared = await libraryStore.getSong(context, collisionSaved.id);
    assert.equal(cleared.assets.background, null);
    assert.equal(await fs.readFile(path.join(collisionDir, cleared.assets.audio), "utf8"), "committed-audio");
    assert.equal(await fs.readFile(path.join(collisionDir, cleared.assets.albumArt), "utf8"), "old-album");
    await assert.rejects(fs.access(path.join(collisionDir, collisionSaved.assets.background.file)), { code: "ENOENT" });

    const videoProject = await libraryStore.saveSong(context, {
      record: { id: "video-background-project", chart: { text: chartText() } },
      assets: {
        audio: { name: "source.mp4", mime: "video/mp4", data: Buffer.from("source-video-audio") },
        background: { name: "source.mp4", mime: "video/mp4", type: "video", data: Buffer.from("source-video-background") },
      },
    });
    await libraryStore.patchSong(context, { record: { id: videoProject.id, assets: { background: null } } });
    assert.equal((await libraryStore.getSong(context, videoProject.id)).assets.background, null);
    assert.equal(await fs.readFile(path.join(projectsFolder, videoProject.id, videoProject.assets.audio), "utf8"), "source-video-audio");
    await assert.rejects(fs.access(path.join(projectsFolder, videoProject.id, videoProject.assets.background.file)), { code: "ENOENT" });

    const wrongPurpose = await registry.register(owner, selectedAudio, {
      mime: "audio/ogg",
      purpose: "generation",
    });
    await assert.rejects(
      resolveLibrarySavePayload(registry, owner, {
        record: rendererPayload.record,
        assets: {
          audio: {
            name: "selected.ogg",
            mime: "audio/ogg",
            source: { kind: "selected-file", token: wrongPurpose.token },
          },
        },
      }),
      /not valid for this operation/
    );
    await assert.rejects(
      resolveLibrarySavePayload(registry, owner, {
        record: rendererPayload.record,
        assets: {
          audio: { name: "selected.ogg", mime: "audio/ogg", path: selectedAudio, data: Buffer.from("x") },
        },
      }),
      /Raw library media paths/
    );
    assert.throws(
      () => assertMediaAssetMetadata("albumArt", { name: "cover.exe", mime: "image/png", size: 1 }),
      /Unsupported albumArt file type/
    );
    assert.throws(
      () => assertMediaAssetMetadata("audio", {
        name: "memory.ogg",
        mime: "audio/ogg",
        size: ROLE_POLICY.audio.maxInlineBytes + 1,
      }, { inline: true }),
      /too large/
    );
    assert.equal(ROLE_POLICY.audio.maxSelectedBytes, 512 * 1024 * 1024);
    assert.equal(ROLE_POLICY.albumArt.maxSelectedBytes, 32 * 1024 * 1024);
    assert.equal(ROLE_POLICY["background-image"].maxSelectedBytes, 64 * 1024 * 1024);
    assert.equal(ROLE_POLICY["background-video"].maxSelectedBytes, 16 * 1024 * 1024 * 1024);
    assert.throws(
      () => assertMediaAssetMetadata("audio", {
        name: "oversized.ogg",
        mime: "audio/ogg",
        size: ROLE_POLICY.audio.maxSelectedBytes + 1,
      }),
      /in-memory playback \(512 MB maximum\)/
    );

    const replacePath = path.join(root, "replace.ogg");
    await fs.writeFile(replacePath, "original");
    const replaceCap = await registry.register(owner, replacePath, {
      mime: "audio/ogg",
      purpose: "library:audio",
    });
    const replacePayload = await resolveLibrarySavePayload(registry, owner, {
      record: { ...rendererPayload.record, id: "replace-project" },
      assets: {
        audio: {
          name: "replace.ogg",
          mime: "audio/ogg",
          source: { kind: "selected-file", token: replaceCap.token },
        },
      },
    });
    await fs.rename(replacePath, `${replacePath}.original`);
    await fs.writeFile(replacePath, "replacement");
    await assert.rejects(
      libraryStore.saveSong(context, replacePayload),
      /changed before it could be saved/
    );

    await assert.rejects(
      libraryStore.getMediaAssetSource(context, saved.id, "song.json"),
      /not a declared project asset/
    );
    const mediaSource = await libraryStore.getMediaAssetSource(
      context,
      saved.id,
      saved.assets.audio,
      "audio"
    );
    assert.equal(mediaSource.path, await fs.realpath(path.join(projectsFolder, saved.id, saved.assets.audio)));

    const legacyDir = path.join(projectsFolder, "legacy-bin-project");
    await fs.mkdir(legacyDir);
    await fs.writeFile(path.join(legacyDir, "audio.bin"), "legacy-audio");
    await fs.writeFile(path.join(legacyDir, "notes.chart"), chartText());
    await fs.writeFile(path.join(legacyDir, "song.json"), JSON.stringify({
      id: "legacy-bin-project",
      chart: { file: "notes.chart" },
      assets: { audio: "audio.bin", albumArt: null, background: null },
    }));
    const legacySource = await libraryStore.getMediaAssetSource(
      context,
      "legacy-bin-project",
      "audio.bin",
      "audio"
    );
    assert.equal(legacySource.mime, "audio/ogg");

    const url = mediaAssetUrl(saved.id, saved.assets.audio, "revision");
    assert.deepEqual(parseMediaAssetUrl(url), {
      projectId: saved.id,
      fileName: saved.assets.audio,
    });
    assert.throws(() => parseMediaAssetUrl("file:///etc/passwd"), /Invalid Autochart media URL/);
    assert.deepEqual(parseByteRange("bytes=5-10", 17), { start: 5, end: 10 });
    assert.deepEqual(parseByteRange("bytes=-4", 17), { start: 13, end: 16 });
    assert.throws(() => parseByteRange("bytes=18-20", 17), /Invalid media byte range/);
    let served = null;
    const handler = createMediaProtocolHandler({
      getSource: async (projectId, fileName) => {
        assert.equal(projectId, saved.id);
        assert.equal(fileName, saved.assets.audio);
        return mediaSource;
      },
      serveSource: async (source, request) => {
        served = { source, request };
        return new Response("streamed-audio", {
          status: 206,
          headers: { "Content-Range": "bytes 0-13/17" },
        });
      },
    });
    const streamed = await handler({
      method: "GET",
      url,
      headers: new Headers({ Range: "bytes=0-13" }),
    });
    assert.equal(streamed.status, 206);
    assert.equal(await streamed.text(), "streamed-audio");
    assert.equal(served.source.path, mediaSource.path);
    assert.equal(served.request.headers.get("Range"), "bytes=0-13");

    let rendererSavePayload = null;
    const fakeAudioFile = {
      name: "renderer.ogg",
      type: "audio/ogg",
      size: 1024 * 1024 * 1024,
      arrayBuffer() {
        throw new Error("path-backed media must not be loaded into renderer memory for save");
      },
    };
    global.window = {
      autochart: {
        files: {
          registerLibraryAsset: async (file, role) => {
            assert.equal(file, fakeAudioFile);
            assert.equal(role, "audio");
            return { token: "library-audio-token" };
          },
        },
        library: {
          isAvailable: () => true,
          saveSong: async (payload) => {
            rendererSavePayload = payload;
            return payload.record;
          },
        },
      },
    };
    try {
      const libraryUrl = `${pathToFileURL(path.join(__dirname, "..", "src", "services", "songLibrary.js")).href}?media-save=${Date.now()}`;
      const songLibrary = await import(libraryUrl);
      await songLibrary.saveSongRecord({
        schemaVersion: 2,
        id: "renderer-project",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: "generated",
        status: "draft",
        meta: { title: "Renderer", artist: "Harness" },
        settings: {},
        chart: { text: chartText() },
        assets: { audio: "renderer.ogg" },
        _blobs: { audio: fakeAudioFile },
      });
      assert.deepEqual(rendererSavePayload.assets.audio.source, {
        kind: "selected-file",
        token: "library-audio-token",
      });
      assert.equal(Object.hasOwn(rendererSavePayload.assets.audio, "data"), false);
      window.autochart.library.patchSong = async (payload) => {
        assert.equal(payload.record.assets.background, null);
        return libraryStore.patchSong(context, payload);
      };
      await songLibrary.updateSongRecord(videoProject.id, {
        assets: { background: null }, _blobs: { background: null },
      });
    } finally {
      delete global.window;
    }

    const { mergeSongRecord } = await import("../src/services/songSchema.js");
    const { recordToImported } = await import("../src/services/songLibrary.js");
    for (const type of ["image", "video"]) {
      const audio = new Blob(["audio"], { type: "audio/ogg" });
      const albumArt = new Blob(["cover"], { type: "image/png" });
      const merged = mergeSongRecord({
        id: `browser-${type}`, assets: { audio: "audio.ogg", background: { type, file: "background.bin" } },
        _idbBlobs: { audio, albumArt, background: { type, blob: new Blob(["background"]) } },
      }, { assets: { background: null }, _blobs: { background: null } });
      const reopened = await recordToImported(merged);
      assert.equal(reopened.background, null, "browser legacy blobs restored a cleared background");
      assert.equal(merged._blobs.audio, audio);
      assert.equal(merged._blobs.albumArt, albumArt);
    }

    let wholeFileReads = 0;
    const tinyOggHeader = new TextEncoder().encode("OggS");
    const fakeFolderAudio = {
      name: "song.ogg",
      webkitRelativePath: "Song/song.ogg",
      type: "audio/ogg",
      size: 5 * 1024 * 1024 * 1024,
      slice(start, end) {
        assert.equal(start, 0);
        assert.ok(end <= 8 * 1024 * 1024);
        return { arrayBuffer: async () => tinyOggHeader.buffer };
      },
      arrayBuffer() {
        wholeFileReads += 1;
        throw new Error("whole-file read");
      },
    };
    const folderFiles = [
      { name: "notes.chart", webkitRelativePath: "Song/notes.chart", text: async () => chartText() },
      fakeFolderAudio,
    ];
    const importUrl = `${pathToFileURL(path.join(__dirname, "..", "src", "services", "songImport.js")).href}?bounded-import=${Date.now()}`;
    const { importSongFolder } = await import(importUrl);
    const imported = await importSongFolder(folderFiles);
    assert.equal(imported.audioBuffer, null);
    assert.equal(imported.audioBlob, fakeFolderAudio);
    assert.equal(wholeFileReads, 0);

    console.log("media persistence: selected audio copied disk-to-disk with sender/purpose/identity checks");
    console.log("media persistence: role-scoped names and transactional save/rollback preserved project state");
    console.log("media persistence: project-only URLs stream range responses without binary IPC");
    console.log("media persistence: renderer import/save avoids whole-file reads and caps inline fallbacks");
  } finally {
    delete global.window;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
