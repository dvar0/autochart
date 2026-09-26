#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const vm = require("vm");

const {
  RELEASE_SMOKE_PROBE,
  createReleaseSmokePingHandler,
  isStrictChild,
  resolveReleaseSmokePaths,
  waitForReleaseSmokeRenderer,
} = require("../electron/releaseSmoke.cjs");

function mockWindow(probes, id = 17) {
  let calls = 0;
  const values = probes.slice();
  return {
    calls: () => calls,
    isDestroyed: () => false,
    webContents: {
      id,
      isDestroyed: () => false,
      executeJavaScript: async () => {
        calls += 1;
        return values.length > 1 ? values.shift() : values[0];
      },
    },
  };
}

async function main() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-release-smoke-"));
  try {
    assert.equal(resolveReleaseSmokePaths({}), null);
    assert.throws(
      () => resolveReleaseSmokePaths({ AUTOCHART_RELEASE_SMOKE: "1" }),
      /ROOT is required/
    );
    assert.throws(
      () => resolveReleaseSmokePaths({
        AUTOCHART_RELEASE_SMOKE: "1",
        AUTOCHART_RELEASE_SMOKE_ROOT: "relative-root",
      }),
      /absolute path/
    );
    assert.throws(
      () => resolveReleaseSmokePaths({
        AUTOCHART_RELEASE_SMOKE: "1",
        AUTOCHART_RELEASE_SMOKE_ROOT: path.parse(scratch).root,
      }),
      /filesystem root/
    );
    assert.throws(
      () => resolveReleaseSmokePaths({
        AUTOCHART_RELEASE_SMOKE: "1",
        AUTOCHART_RELEASE_SMOKE_ROOT: scratch,
        AUTOCHART_USER_DATA: path.join(path.dirname(scratch), "outside-user-data"),
      }),
      /must be inside/
    );

    const paths = resolveReleaseSmokePaths({
      AUTOCHART_RELEASE_SMOKE: "1",
      AUTOCHART_RELEASE_SMOKE_ROOT: scratch,
      AUTOCHART_USER_DATA: path.join(scratch, "custom-user-data"),
    });
    for (const [name, target] of Object.entries(paths)) {
      if (name === "root") continue;
      assert.equal(isStrictChild(paths.root, target), true, `${name} escaped the smoke root`);
    }

    const authorized = new Set([17]);
    const ping = createReleaseSmokePingHandler(paths, authorized, 1234);
    assert.deepEqual(
      ping({ sender: { id: 17, isDestroyed: () => false } }),
      { ok: true, senderId: 17, processId: 1234 }
    );
    assert.throws(
      () => ping({ sender: { id: 18, isDestroyed: () => false } }),
      /unauthorized renderer/
    );
    assert.throws(
      () => ping({ sender: { id: 17, isDestroyed: () => true } }),
      /unauthorized renderer/
    );
    assert.throws(
      () => createReleaseSmokePingHandler(null, authorized)({
        sender: { id: 17, isDestroyed: () => false },
      }),
      /unauthorized renderer/
    );

    const noMount = await vm.runInNewContext(RELEASE_SMOKE_PROBE, {
      document: { querySelector: () => ({ childElementCount: 0 }) },
      window: {},
    });
    assert.equal(noMount.mounted, false);
    const noBridge = await vm.runInNewContext(RELEASE_SMOKE_PROBE, {
      document: { querySelector: () => ({ childElementCount: 1 }) },
      window: {},
    });
    assert.equal(noBridge.bridge, false);
    const bridged = await vm.runInNewContext(RELEASE_SMOKE_PROBE, {
      document: { querySelector: () => ({ childElementCount: 1 }) },
      window: {
        autochart: {
          releaseSmoke: {
            ping: async () => ({ ok: true, senderId: 17, processId: process.pid }),
          },
        },
      },
    });
    assert.equal(bridged.bridge, true);
    assert.equal(bridged.reply.ok, true);

    const readyWindow = mockWindow([
      { mounted: false, bridge: false, reply: null },
      {
        mounted: true,
        bridge: true,
        reply: { ok: true, senderId: 17, processId: process.pid },
      },
    ]);
    await waitForReleaseSmokeRenderer(readyWindow, { timeoutMs: 100, pollIntervalMs: 1 });
    assert.equal(readyWindow.calls(), 2);

    const wrongSender = mockWindow([{
      mounted: true,
      bridge: true,
      reply: { ok: true, senderId: 99, processId: process.pid },
    }]);
    await assert.rejects(
      waitForReleaseSmokeRenderer(wrongSender, { timeoutMs: 10, pollIntervalMs: 1 }),
      /sender-bound IPC ping failed/
    );

    console.log("release smoke: hermetic paths, preload probe, and sender-bound IPC passed");
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
