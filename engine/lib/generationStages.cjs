"use strict";

const STAGE_ORDER = Object.freeze([
  "audio",
  "demucs",
  "timing",
  "smoothing",
  "transcription",
  "chart",
  "finalization",
]);

const FAILURE_DETAILS = Object.freeze({
  audio: Object.freeze({
    stage: "audio",
    label: "audio preparation",
    completedStages: Object.freeze([]),
    note: "Audio preparation failed before model stages ran.",
  }),
  demucs: Object.freeze({
    stage: "demucs",
    label: "Demucs separation",
    completedStages: Object.freeze(["audio"]),
    note: "Demucs separation failed after audio preparation.",
  }),
  timing: Object.freeze({
    stage: "timing",
    label: "timing detection",
    completedStages: Object.freeze(["audio", "demucs"]),
    note: "Timing detection failed after audio and Demucs completed.",
  }),
  smoothing: Object.freeze({
    stage: "smoothing",
    label: "timing smoothing",
    completedStages: Object.freeze(["audio", "demucs", "timing"]),
    note: "Timing smoothing failed after timing detection completed.",
  }),
  transcription: Object.freeze({
    stage: "transcription",
    label: "transcription",
    completedStages: Object.freeze(["demucs", "timing"]),
    note: "Transcription failed after Demucs and timing completed.",
  }),
  chart: Object.freeze({
    stage: "chart",
    label: "chart writing",
    completedStages: Object.freeze(["demucs", "timing", "transcription"]),
    note: "Chart writing failed after transcription completed.",
  }),
  finalization: Object.freeze({
    stage: "finalization",
    label: "result finalization",
    completedStages: Object.freeze(["demucs", "timing", "transcription", "chart"]),
    note: "Result persistence failed after generation completed.",
  }),
});
function createResultPersistence(write) {
  let writeCount = 0;
  return {
    async persist(result) {
      if (writeCount) throw new Error("Generation result persistence was already attempted.");
      writeCount += 1;
      return write(result);
    },
    get writeCount() {
      return writeCount;
    },
  };
}

function failureStageDetails(stage) {
  return FAILURE_DETAILS[stage] || FAILURE_DETAILS.audio;
}

function createGenerationLifecycle({ emit = () => {} } = {}) {
  let currentStage = "audio";
  let failure = null;
  let cancelled = false;
  let terminal = false;
  const fail = (error, stage = currentStage) => {
    if (cancelled || terminal) return failureStageDetails(stage);
    if (failure && stage !== "finalization") return failure;
    const details = failureStageDetails(stage);
    const message = String(error?.message || error);
    if (!failure || failure.stage !== details.stage) {
      failure = details;
      emit({ type: "error", message: `${details.label} failed: ${message}` });
      emit({ type: "stage", stage: details.stage, status: "failed", message });
    }
    return details;
  };
  return {
    stages: STAGE_ORDER,
    get stage() { return currentStage; },
    get failure() { return failure; },
    enter(stage) {
      if (terminal || cancelled) throw new Error("Generation lifecycle is already terminal.");
      if (!STAGE_ORDER.includes(stage)) throw new Error(`Unknown generation stage: ${stage}`);
      currentStage = stage;
      return currentStage;
    },
    async runStage(stage, operation) {
      this.enter(stage);
      try {
        return await operation();
      } catch (error) {
        if (!failure) fail(error, stage);
        throw error;
      }
    },
    fail,
    cancel(reason = "canceled") {
      if (terminal || cancelled) return;
      cancelled = true;
      terminal = true;
      emit({ type: "canceled", reason });
    },
    async finalize(result, persist, resultPath) {
      if (cancelled || terminal) throw new Error("Generation lifecycle is already terminal.");
      try {
        this.enter("finalization");
        await persist(result);
      } catch (error) {
        fail(error, "finalization");
        terminal = true;
        throw error;
      }
      emit({ type: "result", path: resultPath });
      emit({ type: "stage", stage: "done", status: result.status === "completed" ? "completed" : "failed", ...(result.status === "failed" ? { message: result.error } : {}) });
      terminal = true;
      return result;
    },
    isTerminal() { return terminal || cancelled; },
    complete() {
      if (terminal || cancelled) throw new Error("Generation lifecycle is already terminal.");
      terminal = true;
    },
  };
}

module.exports = { STAGE_ORDER, createGenerationLifecycle, createResultPersistence, failureStageDetails };
