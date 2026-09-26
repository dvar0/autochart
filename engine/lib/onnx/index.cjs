"use strict";

// Aggregator so engine/bin can `require("../lib/onnx")` and reach the ONNX stage pieces.
module.exports = {
  ...require("./modelsManifest.cjs"),
  ...require("./sessionLoader.cjs"),
  ...require("./audioDecode.cjs"),
  ...require("./wavWrite.cjs"),
  ...require("./demucsSeparate.cjs"),
  ...require("./beatDetect.cjs"),
  ...require("./chartEventStream.cjs"),
  ...require("./prefixTables.cjs"),
  ...require("./buildBeatMel.cjs"),
  ...require("./transcribe.cjs"),
};