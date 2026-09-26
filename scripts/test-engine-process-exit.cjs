"use strict";

const assert = require("assert/strict");
const path = require("path");
const { spawn } = require("child_process");

async function checkExit(code) {
  const helper = path.join(__dirname, "..", "engine", "lib", "finishProcess.cjs");
  const child = spawn(process.execPath, ["-e", `
    const { finishProcess } = require(${JSON.stringify(helper)});
    process.stdout.write('x'.repeat(2 * 1024 * 1024));
    process.stdout.write('\\n' + JSON.stringify({type:'result', status:${JSON.stringify(code ? "failed" : "completed")}}) + '\\n');
    process.stderr.write('y'.repeat(1024 * 1024));
    finishProcess(${code});
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [], stderr = [];
  // Exercise backpressure: an immediate process.exit would truncate these pipes.
  child.stdout.pause();
  child.stderr.pause();
  const timer = setTimeout(() => {
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdout.resume();
    child.stderr.resume();
  }, 100);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    assert.deepEqual(result, { exitCode: code, signal: null });
    const expected = 'x'.repeat(2 * 1024 * 1024) + '\n' + JSON.stringify({type:'result', status:code ? 'failed' : 'completed'}) + '\n';
    assert.equal(Buffer.concat(stdout).toString(), expected, "exit truncated result/event output");
    assert.equal(Buffer.concat(stderr).toString(), 'y'.repeat(1024 * 1024), "exit truncated diagnostic output");
  } finally {
    clearTimeout(timer);
    clearTimeout(timeout);
  }
}

(async () => {
  await checkExit(0);
  await checkExit(1);
  console.log("Engine exit: complete event/diagnostic pipes under backpressure, success and failure codes preserved.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
