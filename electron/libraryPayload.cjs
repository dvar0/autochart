"use strict";

const libraryStore = require("./libraryStore.cjs");
const {
  assertInlineMediaAsset,
  assertMediaAssetMetadata,
  mediaAssetRole,
} = require("./mediaAssetPolicy.cjs");

const ASSET_KEYS = ["audio", "albumArt", "background"];

async function resolveLibraryAsset(registry, sender, key, asset) {
  if (!asset) return null;
  if (!asset || typeof asset !== "object") throw new Error("Invalid library media asset.");
  const role = mediaAssetRole(key, asset);
  const source = asset.source;
  if (source != null) {
    if (
      source?.kind !== "selected-file" ||
      typeof source.token !== "string" ||
      !source.token ||
      Object.hasOwn(source, "path") ||
      Object.hasOwn(asset, "data")
    ) {
      throw new Error("Library media requires a valid selected-file capability.");
    }
    const selected = await registry.consume(sender, source.token, {
      purpose: `library:${role}`,
    });
    assertMediaAssetMetadata(role, selected);
    const resolved = {
      name: selected.name,
      mime: selected.mime,
      ...(key === "background" ? { type: asset.type === "video" ? "video" : "image" } : {}),
    };
    Object.defineProperty(resolved, libraryStore.SOURCE_ASSET, {
      value: selected,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return resolved;
  }

  if (Object.hasOwn(asset, "path") || Object.getOwnPropertySymbols(asset).length) {
    throw new Error("Raw library media paths are not accepted.");
  }
  assertInlineMediaAsset(role, asset);
  return {
    name: asset.name,
    mime: asset.mime,
    data: asset.data,
    ...(key === "background" ? { type: asset.type === "video" ? "video" : "image" } : {}),
  };
}

async function resolveLibrarySavePayload(registry, sender, payload = {}) {
  if (!payload || typeof payload !== "object") throw new Error("Invalid library save payload.");
  const assets = payload.assets || {};
  const resolvedAssets = {};
  for (const key of ASSET_KEYS) {
    resolvedAssets[key] = await resolveLibraryAsset(registry, sender, key, assets[key]);
  }
  return {
    record: payload.record,
    assets: resolvedAssets,
  };
}

module.exports = { ASSET_KEYS, resolveLibraryAsset, resolveLibrarySavePayload };
