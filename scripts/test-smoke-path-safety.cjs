#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const safety = require("./smoke-path-safety.cjs");
const releaseVerify = require("./release-verify.cjs");
const generationSmoke = require("./smoke-generate.cjs");
const engineManager = require("../electron/engineManager.cjs");

async function rejectsWith(fn, pattern) {
  await assert.rejects(fn, pattern);
}

async function main() {
  assert.equal(generationSmoke.parseArgs([]).generationTimeoutSeconds, 900);
  for (const value of ["0", "-1", "NaN", "Infinity", "2147484"]) {
    assert.throws(() => generationSmoke.parseArgs(["--generation-timeout-seconds", value]), /must be positive/);
  }
  const originalCancel = engineManager.cancelJob;
  const sender = {};
  const canceled = [];
  let rejectJob;
  engineManager.cancelJob = (jobId, owner) => {
    assert.equal(owner, sender, "timeout must use the original sender to cancel its job");
    canceled.push(jobId);
    rejectJob(new Error("canceled"));
  };
  try {
    await assert.rejects(
      generationSmoke.withGenerationTimeout("stalled-job", sender, 0.02, () => new Promise((_resolve, reject) => { rejectJob = reject; })),
      /Generation smoke exceeded 0.02 seconds/
    );
    assert.deepEqual(canceled, ["stalled-job"]);
    assert.equal(await generationSmoke.withGenerationTimeout("completed-job", sender, 0.02, async () => "chart"), "chart");
    await assert.rejects(
      generationSmoke.withGenerationTimeout("failed-job", sender, 0.02, async () => { throw new Error("engine failure"); }),
      /engine failure/
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(canceled, ["stalled-job"], "settled jobs must clear their timeout");
  } finally {
    engineManager.cancelJob = originalCancel;
  }
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-smoke-safety-test-"));
  let ownedIsolation = null;
  let assertions = 0;
  try {
    ownedIsolation = await safety.createIsolatedRunRoot("autochart-smoke-safety-owned-");
    const { root, runId } = ownedIsolation;
    const sibling = path.join(sandbox, "unrelated.txt");
    await fs.writeFile(sibling, "preserve", "utf8");

    const owned = path.join(root, "cache");
    await safety.createOwnedDirectory(owned, { runId, role: "cache" });
    await fs.writeFile(path.join(owned, "generated.bin"), "delete", "utf8");
    await safety.wipeOwnedDirectory(owned, { runId, role: "cache" });
    assert.equal(await safety.pathExists(path.join(owned, "generated.bin")), false);
    assertions += 1;
    await safety.readAndValidateMarker(owned, { runId, role: "cache" });
    assertions += 1;
    assert.equal(await fs.readFile(sibling, "utf8"), "preserve");
    assertions += 1;

    const preexisting = path.join(sandbox, "preexisting");
    await fs.mkdir(preexisting);
    await fs.writeFile(path.join(preexisting, "user-project.txt"), "preserve", "utf8");
    await rejectsWith(
      () => safety.createOwnedDirectory(preexisting, { runId, role: "projects" }),
      /pre-existing smoke path/
    );
    assertions += 1;
    assert.equal(await fs.readFile(path.join(preexisting, "user-project.txt"), "utf8"), "preserve");
    assertions += 1;

    const releaseOptions = releaseVerify.parseArgs([
      "--clean-install",
      "--user-data", preexisting,
      "--projects-folder", path.join(sandbox, "new-projects"),
    ]);
    await rejectsWith(
      () => releaseVerify.configureIsolatedPaths(releaseOptions),
      /refuses the pre-existing user-data path/
    );
    assertions += 1;
    assert.equal(await fs.readFile(path.join(preexisting, "user-project.txt"), "utf8"), "preserve");
    assertions += 1;

    const defaultReleaseOptions = releaseVerify.parseArgs([]);
    const publicUnsignedOptions = releaseVerify.parseArgs(["--public-release"]);
    assert.equal(publicUnsignedOptions.publicRelease, true);
    assert.equal(publicUnsignedOptions.requireSigning, false);
    assertions += 2;
    const publicSignedOptions = releaseVerify.parseArgs([
      "--public-release",
      "--require-signing",
    ]);
    assert.equal(publicSignedOptions.requireSigning, true);
    assertions += 1;
    assert.throws(
      () => releaseVerify.parseArgs(["--require-signing"]),
      /only together with --public-release/
    );
    assertions += 1;
    const unsignedEnvironment = releaseVerify.unsignedPackagingEnvironment();
    assert.equal(unsignedEnvironment.CSC_IDENTITY_AUTO_DISCOVERY, "false");
    assertions += 1;
    for (const key of [
      "CSC_LINK",
      "CSC_NAME",
      "CSC_KEY_PASSWORD",
      "WIN_CSC_LINK",
      "WIN_CSC_KEY_PASSWORD",
      "APPLE_API_KEY",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
      "APPLE_ID",
      "APPLE_APP_SPECIFIC_PASSWORD",
      "APPLE_TEAM_ID",
    ]) {
      assert.equal(unsignedEnvironment[key], undefined, `${key} leaked into unsigned packaging`);
      assertions += 1;
    }
    const unsignedChild = require("child_process").spawnSync(process.execPath, ["-e", "if ('CSC_LINK' in process.env) process.exit(1)"], {
      env: { ...process.env, CSC_LINK: "test-certificate", ...unsignedEnvironment },
    });
    assert.equal(unsignedChild.status, 0, "unsigned child inherited a certificate path");
    assertions += 1;
    const noticeDir = path.join(sandbox, "unsigned-release");
    const noticePath = await releaseVerify.stageUnsignedReleaseNotice(
      { platform: "win32", arch: "x64" },
      { releaseDir: noticeDir }
    );
    const noticeText = await fs.readFile(noticePath, "utf8");
    assert.match(noticeText, /intentionally not signed or notarized/);
    assert.match(noticeText, /Target: win32-x64/);
    assertions += 2;
    await rejectsWith(
      () => releaseVerify.stageUnsignedReleaseNotice(
        { platform: "win32", arch: "x64" },
        { releaseDir: noticeDir }
      ),
      /EEXIST/
    );
    assertions += 1;
    const defaultReleaseIsolation = await releaseVerify.configureIsolatedPaths(defaultReleaseOptions);
    for (const key of ["userData", "modelsFolder", "cacheFolder", "projectsFolder"]) {
      assert.equal(safety.isWithin(defaultReleaseIsolation.root, defaultReleaseOptions[key]), true);
      assertions += 1;
    }
    assert.notEqual(defaultReleaseOptions.userData, defaultReleaseOptions.projectsFolder);
    assertions += 1;
    await safety.removeOwnedDirectory(defaultReleaseIsolation.root, {
      runId: defaultReleaseIsolation.runId,
      role: "run-root",
    });
    assertions += 1;

    const tampered = path.join(root, "models");
    await safety.createOwnedDirectory(tampered, { runId, role: "models" });
    await fs.writeFile(path.join(tampered, safety.MARKER_NAME), "{}\n", "utf8");
    await fs.writeFile(path.join(tampered, "model.bin"), "preserve", "utf8");
    await rejectsWith(
      () => safety.wipeOwnedDirectory(tampered, { runId, role: "models" }),
      /Unrecognized smoke ownership marker/
    );
    assertions += 1;
    assert.equal(await fs.readFile(path.join(tampered, "model.bin"), "utf8"), "preserve");
    assertions += 1;

    if (process.platform !== "win32") {
      const link = path.join(sandbox, "linked-cache");
      await fs.symlink(preexisting, link, "dir");
      await rejectsWith(
        () => safety.ensureOwnedDirectory(link, { runId, role: "cache" }),
        /non-directory or symlink smoke target/
      );
      assertions += 1;
      await rejectsWith(
        () => safety.validateDistinctTargets([
          { role: "user-data", target: path.join(preexisting, "shared-child") },
          { role: "cache", target: path.join(link, "shared-child") },
        ]),
        /must be separate directories/
      );
      assertions += 1;
      const systemLink = path.join(sandbox, "system-link");
      await fs.symlink("/etc", systemLink, "dir");
      await rejectsWith(
        () => safety.validateDistinctTargets([
          { role: "user-data", target: path.join(systemLink, "autochart-new-child") },
          { role: "cache", target: path.join(root, "safe-cache-child") },
        ]),
        /unsafe canonical smoke isolation target/
      );
      assertions += 1;
    }

    assert.throws(() => safety.assertSafeTarget(path.parse(process.cwd()).root), /unsafe smoke isolation target/);
    assertions += 1;
    assert.throws(() => safety.assertSafeTarget(process.cwd()), /unsafe smoke isolation target/);
    assertions += 1;
    if (process.platform !== "win32") {
      assert.throws(() => safety.assertSafeTarget("/etc/autochart"), /unsafe smoke isolation target/);
      assertions += 1;
    }
    assert.throws(
      () => safety.assertDistinctTargets([
        { role: "user-data", target: path.join(root, "parent") },
        { role: "cache", target: path.join(root, "parent", "cache") },
      ]),
      /must be separate directories/
    );
    assertions += 1;

    await safety.removeOwnedDirectory(owned, { runId, role: "cache" });
    assert.equal(await safety.pathExists(owned), false);
    assertions += 1;

    // A mismatched run can never clean a correctly marked directory.
    const protectedOwned = path.join(root, "projects");
    await safety.createOwnedDirectory(protectedOwned, { runId, role: "projects" });
    await fs.writeFile(path.join(protectedOwned, "chart.chart"), "preserve", "utf8");
    await rejectsWith(
      () => safety.removeOwnedDirectory(protectedOwned, {
        runId: "00000000-0000-4000-8000-000000000000",
        role: "projects",
      }),
      /run mismatch/
    );
    assertions += 1;
    assert.equal(await fs.readFile(path.join(protectedOwned, "chart.chart"), "utf8"), "preserve");
    assertions += 1;

    console.log(`[smoke-path-safety] PASS (${assertions} assertions)`);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
    if (ownedIsolation && await safety.pathExists(ownedIsolation.root)) {
      await safety.removeOwnedDirectory(ownedIsolation.root, {
        runId: ownedIsolation.runId,
        role: "run-root",
      });
    }
  }
}

main().catch((error) => {
  console.error(`[smoke-path-safety] FAIL: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
