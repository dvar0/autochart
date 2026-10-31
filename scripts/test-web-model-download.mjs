#!/usr/bin/env node
// Browser model downloads (engine/web/modelStore.mjs) against a local host
// that drops connections partway through a file.

import assert from "node:assert/strict";
import http from "node:http";
import { fetchModelFile } from "../engine/web/modelStore.mjs";

const FILE = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7 + (i >> 9)) & 255);
const PAUSES = [5, 5, 5];

// plan: one entry per request, how the host answers it.
//   { drop: n }   send n bytes, then cut the connection
//   { noRange }   ignore Range and send the whole file
//   { status }    answer with that status and no body
function host(plan) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const step = plan[requests.length] || {};
    requests.push(req.headers.range || null);
    if (step.status) {
      res.writeHead(step.status).end();
      return;
    }
    const range = !step.noRange && /^bytes=(\d+)-$/.exec(req.headers.range || "");
    const start = range ? Number(range[1]) : 0;
    const body = FILE.subarray(start);
    res.writeHead(range ? 206 : 200, {
      "Content-Length": String(body.length),
      ...(range ? { "Content-Range": `bytes ${start}-${FILE.length - 1}/${FILE.length}` } : {}),
    });
    if (step.drop == null) {
      res.end(Buffer.from(body));
      return;
    }
    res.write(Buffer.from(body.subarray(0, step.drop)), () => setTimeout(() => res.socket.destroy(), 20));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}/folder/file.onnx`, requests, close: () => server.close() });
  }));
}

async function run(plan) {
  const h = await host(plan);
  const progress = [];
  try {
    const bytes = await fetchModelFile(h.url, { retryPauses: PAUSES, onProgress: (p) => progress.push(p) });
    return { bytes, requests: h.requests, progress };
  } finally {
    h.close();
  }
}

// A clean download is one request.
{
  const { bytes, requests } = await run([{}]);
  assert.deepEqual(bytes, FILE);
  assert.deepEqual(requests, [null]);
}

// A dropped connection resumes from the bytes already received.
{
  const { bytes, requests, progress } = await run([{ drop: 50_000 }, { drop: 120_000 }, {}]);
  assert.deepEqual(bytes, FILE);
  assert.equal(requests[0], null);
  assert.match(requests[1], /^bytes=\d+-$/);
  assert.ok(Number(requests[2].slice(6, -1)) > Number(requests[1].slice(6, -1)), "each resume starts further in");
  assert.deepEqual(progress.at(-1), { loaded: FILE.length, total: FILE.length });
}

// A host that won't resume sends the whole file again, and it isn't doubled.
{
  const { bytes, requests } = await run([{ drop: 50_000 }, { noRange: true }]);
  assert.deepEqual(bytes, FILE);
  assert.equal(requests.length, 2);
}

// A busy host is tried again; a missing file isn't.
{
  const { bytes } = await run([{ status: 503 }, {}]);
  assert.deepEqual(bytes, FILE);
  const h = await host([{ status: 404 }, {}]);
  await assert.rejects(fetchModelFile(h.url, { retryPauses: PAUSES }), /\(404\)/);
  assert.equal(h.requests.length, 1);
  h.close();
}

// It gives up after the last retry.
{
  const h = await host([{ drop: 1000 }, { drop: 1000 }, { drop: 1000 }, { drop: 1000 }, {}]);
  await assert.rejects(fetchModelFile(h.url, { retryPauses: PAUSES }));
  assert.equal(h.requests.length, 4);
  h.close();
}

console.log("Web model download checks passed.");
