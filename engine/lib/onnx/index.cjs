"use strict";

// Aggregator so engine/bin can `require("../lib/onnx")` and reach the ONNX stage pieces.
// sessionLoader comes first: loading it installs the onnxruntime-node host the stages run on.
module.exports = {
  ...require("./sessionLoader.cjs"),
  ...require("./modelsManifest.cjs"),
  ...require("./audioDecode.cjs"),
  ...require("./wavWrite.cjs"),
  ...require("./demucsSeparate.mjs"),
  ...require("./beatDetect.mjs"),
  ...require("./chartEventStream.mjs"),
  ...require("./prefixTables.mjs"),
  ...require("./buildBeatMel.mjs"),
  ...require("./melTables.mjs"),
  ...require("./transcribe.mjs"),
  ...require("./forceSolo.mjs"),
  ...require("./chartTokens.mjs"),
  ...require("./inpaint.mjs"),
  ...require("./resample.mjs"),
  ...require("./pipeline.mjs"),
};
