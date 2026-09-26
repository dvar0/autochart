import catalog from "../../engine/catalog.json" with { type: "json" };

const standardPack = Array.isArray(catalog.packs)
  ? catalog.packs.find((pack) => pack.id === "standard-onnx")
  : null;

export const STANDARD_PACK_DOWNLOAD_BYTES = Number(standardPack?.downloadBytes) || 0;
