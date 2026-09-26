"use strict";

const fs = require("fs");
const fsPromises = require("fs/promises");
const https = require("https");
const path = require("path");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const tar = require("tar");
const yauzl = require("yauzl");
const {
  assertPinnedFileSync,
  manifest,
  targetArch,
  targetSpecification,
  verifyFfmpegInstallation,
} = require("./verify-runtime-artifacts.cjs");

const NODE_VERSION = manifest.node.version;
const CONNECT_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 30_000;
const OVERALL_TIMEOUT_MS = 5 * 60_000;

function archiveDetails(platform, arch) {
  const { specification } = targetSpecification("node", platform, arch);
  return {
    ...specification,
    archiveType: specification.archiveName.endsWith(".zip") ? "zip" : "tar.gz",
  };
}

function request(url, onResponse, redirects = 5, deadline = Date.now() + OVERALL_TIMEOUT_MS) {
  const parsedUrl = url instanceof URL ? url : new URL(url);
  if (parsedUrl.protocol !== "https:") {
    return Promise.reject(new Error(`Refusing non-HTTPS Node runtime URL: ${parsedUrl}`));
  }
  const remainingOverallMs = deadline - Date.now();
  if (remainingOverallMs <= 0) {
    return Promise.reject(new Error(`Overall timeout downloading ${parsedUrl}`));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let connectTimer;
    let overallTimer;
    const cleanup = () => {
      clearTimeout(connectTimer);
      clearTimeout(overallTimer);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const req = https.get(parsedUrl, (response) => {
      clearTimeout(connectTimer);
      const location = response.headers.location;
      if (location && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        if (redirects <= 0) {
          finishReject(new Error(`Too many redirects downloading ${parsedUrl}`));
          return;
        }
        let redirectUrl;
        try {
          redirectUrl = new URL(location, parsedUrl);
          if (redirectUrl.protocol !== "https:") {
            throw new Error(`Refusing non-HTTPS redirect while downloading ${parsedUrl}: ${redirectUrl}`);
          }
        } catch (error) {
          finishReject(error);
          return;
        }
        finishResolve(request(redirectUrl, onResponse, redirects - 1, deadline));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        finishReject(new Error(`Download failed (${response.statusCode}) for ${parsedUrl}`));
        return;
      }
      Promise.resolve(onResponse(response)).then(finishResolve, finishReject);
    });
    connectTimer = setTimeout(() => {
      req.destroy(new Error(`Connect timeout downloading ${parsedUrl}`));
    }, Math.min(CONNECT_TIMEOUT_MS, remainingOverallMs));
    overallTimer = setTimeout(() => {
      req.destroy(new Error(`Overall timeout downloading ${parsedUrl}`));
    }, remainingOverallMs);
    req.on("socket", (socket) => {
      if (!socket.connecting) {
        clearTimeout(connectTimer);
        return;
      }
      socket.once("secureConnect", () => clearTimeout(connectTimer));
    });
    req.setTimeout(IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`Idle timeout downloading ${parsedUrl}`));
    });
    req.on("error", finishReject);
  });
}

async function downloadFile(url, destination, expectedBytes) {
  const temporary = `${destination}.download`;
  await fsPromises.rm(temporary, { force: true });
  try {
    await request(url, async (response) => {
      const rawContentLength = Array.isArray(response.headers["content-length"])
        ? response.headers["content-length"][0]
        : response.headers["content-length"];
      if (rawContentLength !== undefined) {
        const declaredBytes = Number(rawContentLength);
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
          throw new Error(`Invalid Content-Length downloading ${url}: ${rawContentLength}`);
        }
        if (declaredBytes > expectedBytes) {
          throw new Error(`Node archive exceeds pinned size: declared ${declaredBytes}, expected ${expectedBytes}.`);
        }
      }
      let receivedBytes = 0;
      const byteLimiter = new Transform({
        transform(chunk, encoding, callback) {
          receivedBytes += chunk.length;
          if (receivedBytes > expectedBytes) {
            callback(new Error(`Node archive exceeds pinned size of ${expectedBytes} bytes.`));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(response, byteLimiter, fs.createWriteStream(temporary, { flags: "wx" }));
      if (receivedBytes !== expectedBytes) {
        throw new Error(`Node archive size mismatch: expected ${expectedBytes}, received ${receivedBytes}.`);
      }
    });
    await fsPromises.rename(temporary, destination);
  } catch (error) {
    await fsPromises.rm(temporary, { force: true });
    throw error;
  }
}

function extractZipEntry(archivePath, entryName, destination, mode) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.on("error", fail);
      zip.on("entry", (entry) => {
        if (entry.fileName !== entryName) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            fail(streamError);
            return;
          }
          pipeline(stream, fs.createWriteStream(destination, { flags: "wx", mode }))
            .then(() => {
              if (settled) return;
              settled = true;
              zip.close();
              resolve();
            }, fail);
        });
      });
      zip.on("end", () => {
        if (!settled) fail(new Error(`Node archive entry ${entryName} was not found in ${archivePath}`));
      });
      zip.readEntry();
    });
  });
}

async function executableReportsVersion(executable) {
  try {
    const { spawn } = require("child_process");
    return await new Promise((resolve) => {
      const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0 && stdout.trim() === `v${NODE_VERSION}`));
    });
  } catch {
    return false;
  }
}

async function prepareNodeRuntime(context = {}) {
  const platform = context.electronPlatformName || process.platform;
  const arch = targetArch(context.arch ?? process.arch);
  const projectDir = context.packager?.info?.projectDir || process.cwd();
  const details = archiveDetails(platform, arch);
  const cacheRoot = path.join(projectDir, "node_modules", ".cache", "autochart-node");
  const targetDir = path.join(cacheRoot, `${platform}-${arch}`);
  const executable = path.join(targetDir, details.executableName);
  const license = path.join(targetDir, "LICENSE");

  await require("./prepare-ffmpeg.cjs").prepareFfmpeg({ projectDir, platform, arch });
  verifyFfmpegInstallation({ projectDir, platform, arch });

  await fsPromises.mkdir(cacheRoot, { recursive: true });
  const archivePath = path.join(cacheRoot, details.archiveName);
  const releaseBase = new URL(manifest.node.releaseBaseUrl);

  if (!fs.existsSync(archivePath)) {
    await downloadFile(new URL(details.archiveName, releaseBase), archivePath, details.archiveSize);
  }
  try {
    assertPinnedFileSync(archivePath, {
      size: details.archiveSize,
      sha256: details.archiveSha256,
    }, `Node ${NODE_VERSION} archive`);
  } catch (error) {
    await fsPromises.rm(archivePath, { force: true });
    throw error;
  }

  const extractRoot = path.join(cacheRoot, `.extract-${platform}-${arch}`);
  await fsPromises.rm(extractRoot, { recursive: true, force: true });
  await fsPromises.mkdir(extractRoot, { recursive: true });
  try {
    if (details.archiveType === "zip") {
      await extractZipEntry(
        archivePath,
        `${details.rootName}/${details.executableName}`,
        path.join(extractRoot, details.executableName),
        0o755
      );
      await extractZipEntry(archivePath, `${details.rootName}/LICENSE`, path.join(extractRoot, "LICENSE"), 0o644);
    } else {
      await tar.x({
        cwd: extractRoot,
        file: archivePath,
        filter: (entryPath) => entryPath === `${details.rootName}/bin/node`,
        strip: 2,
      });
      await tar.x({
        cwd: extractRoot,
        file: archivePath,
        filter: (entryPath) => entryPath === `${details.rootName}/LICENSE`,
        strip: 1,
      });
    }
    const extracted = path.join(extractRoot, details.executableName);
    const extractedLicense = path.join(extractRoot, "LICENSE");
    await fsPromises.chmod(extracted, 0o755);
    await fsPromises.chmod(extractedLicense, 0o644);
    assertPinnedFileSync(extracted, {
      size: details.executableSize,
      sha256: details.executableSha256,
    }, `Node ${NODE_VERSION} executable`);
    assertPinnedFileSync(extractedLicense, {
      size: details.licenseSize,
      sha256: details.licenseSha256,
    }, `Node ${NODE_VERSION} license and third-party notices`);
    await fsPromises.rm(targetDir, { recursive: true, force: true });
    await fsPromises.rename(extractRoot, targetDir);
  } catch (error) {
    await fsPromises.rm(extractRoot, { recursive: true, force: true });
    throw error;
  }

  assertPinnedFileSync(executable, {
    size: details.executableSize,
    sha256: details.executableSha256,
  }, `Cached Node ${NODE_VERSION} executable`);
  assertPinnedFileSync(license, {
    size: details.licenseSize,
    sha256: details.licenseSha256,
  }, `Cached Node ${NODE_VERSION} license and third-party notices`);

  if (platform === process.platform && arch === process.arch && !await executableReportsVersion(executable)) {
    throw new Error(`Bundled Node runtime failed its version check: ${executable}`);
  }
  return executable;
}

module.exports = prepareNodeRuntime;
module.exports.NODE_VERSION = NODE_VERSION;

if (require.main === module) {
  prepareNodeRuntime()
    .then((executable) => console.log(`Prepared Node ${NODE_VERSION}: ${executable}`))
    .catch((error) => {
      console.error(error.stack || error.message || error);
      process.exitCode = 1;
    });
}
