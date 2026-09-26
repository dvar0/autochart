"use strict";

const fs = require("fs/promises");
const fsSync = require("fs");
const { Readable } = require("stream");
const { mimeFromMediaFileName } = require("./mediaAssetPolicy.cjs");

const MEDIA_SCHEME = "autochart-media";

function mediaAssetUrl(projectId, fileName, revision = "") {
  const url = new URL(`${MEDIA_SCHEME}://asset/`);
  url.searchParams.set("project", String(projectId || ""));
  url.searchParams.set("file", String(fileName || ""));
  if (revision) url.searchParams.set("v", String(revision));
  return url.href;
}

function parseMediaAssetUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== `${MEDIA_SCHEME}:` || url.hostname !== "asset" || url.pathname !== "/") {
    throw new Error("Invalid Autochart media URL.");
  }
  const projectId = url.searchParams.get("project") || "";
  const fileName = url.searchParams.get("file") || "";
  if (!projectId || !fileName) throw new Error("Incomplete Autochart media URL.");
  return { projectId, fileName };
}

function mediaError(status, message) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function requestHeader(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return String(value);
  }
  return null;
}

function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) {
    throw new Error("Invalid media byte range.");
  }
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new Error("Invalid media byte range.");
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= size ||
      end < start
    ) {
      throw new Error("Invalid media byte range.");
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function responseHeaders(source, size) {
  return new Headers({
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Type": source.mime || mimeFromMediaFileName(source.name),
    "X-Content-Type-Options": "nosniff",
    "Content-Length": String(size),
  });
}

async function createMediaAssetResponse(source, request) {
  const noFollow = fsSync.constants.O_NOFOLLOW || 0;
  const handle = await fs.open(source.path, fsSync.constants.O_RDONLY | noFollow);
  let handedOff = false;
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.dev !== source.device ||
      stat.ino !== source.inode ||
      stat.size !== source.size ||
      stat.mtimeMs !== source.lastModified
    ) {
      throw new Error("Project media changed before it could be streamed.");
    }
    let range;
    try {
      range = parseByteRange(requestHeader(request.headers, "range"), stat.size);
    } catch {
      const headers = responseHeaders(source, 0);
      headers.set("Content-Range", `bytes */${stat.size}`);
      return new Response(null, { status: 416, headers });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, stat.size - 1);
    const length = stat.size === 0 ? 0 : end - start + 1;
    const headers = responseHeaders(source, length);
    if (range) headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    if (request.method === "HEAD" || length === 0) {
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    const stream = handle.createReadStream({ start, end, autoClose: true });
    handedOff = true;
    return new Response(Readable.toWeb(stream), {
      status: range ? 206 : 200,
      headers,
    });
  } finally {
    if (!handedOff) await handle.close();
  }
}

function createMediaProtocolHandler({ getSource, getPreviewSource, serveSource = createMediaAssetResponse }) {
  if (typeof getSource !== "function" || typeof serveSource !== "function") {
    throw new Error("Media protocol dependencies are required.");
  }
  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return mediaError(405, "Method not allowed");
    }
    try {
      const url = new URL(request.url);
      if (url.protocol === `${MEDIA_SCHEME}:` && url.hostname === "preview" && /^\/[a-f0-9]{64}$/.test(url.pathname)) {
        const source = await getPreviewSource?.(url.pathname.slice(1));
        if (!source) throw new Error("Unknown video preview.");
        return await serveSource(source, request);
      }
      const { projectId, fileName } = parseMediaAssetUrl(request.url);
      const source = await getSource(projectId, fileName);
      return await serveSource(source, request);
    } catch {
      return mediaError(404, "Media asset not found");
    }
  };
}

module.exports = {
  MEDIA_SCHEME,
  createMediaAssetResponse,
  createMediaProtocolHandler,
  mediaAssetUrl,
  parseByteRange,
  parseMediaAssetUrl,
};
