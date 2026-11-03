// Rewrites a transcriber decoder graph (ONNX bytes) so its self-attention
// cache is read in place; transcribe.mjs and inpaint.mjs drive the result.
//
// The exported graphs (decoder_step, and fim_decoder, which feeds n tokens a
// call) take the whole cache (past_self_k/v [layers, batch, heads, past,
// head_dim]) and return it with the new rows appended, so every call copies
// the whole cache several times and a long song slows to a crawl. The
// rewritten graph takes each layer's cache as past_k_<i>/past_v_<i> [batch,
// heads, cap, head_dim] with spare rows that self_mask (0 or -inf per row)
// hides, attends to the cache and to the new rows separately under one
// softmax, and returns only the new rows (new_self_k/v [layers, batch, heads,
// n, head_dim]). The encoder's cross keys and values come in per layer too
// (cross_k_<i>/cross_v_<i> [heads, n_beats, head_dim]), which spares a copy
// of them on every call. The outputs match the original's up to float
// rounding (the sums run in another order).
//
// Only CPU sessions use it: on WebGPU the cache stays on the device.
// Returns null when the graph isn't one of the expected shapes.

import {
  readFields, parseNode, intAttr, intsAttr, constantValue, int64Initializer, floatScalarInitializer, floatInput,
  valueInfoName, added, isConstList, onnxOpset, Message,
  MODEL_GRAPH, GRAPH_NODE, GRAPH_INITIALIZER, GRAPH_INPUT, GRAPH_OUTPUT, GRAPH_VALUE_INFO, FLOAT,
} from "./onnxProto.mjs";

// One layer's self-attention in either graph shape, or null:
//  step (decoder_step): Concat(past, k) -> Transpose -> MatMul(q, .) -> Softmax
//    -> MatMul(., Concat(past, v)); q, k, v are [batch, heads, 1, head_dim].
//  multi (fim_decoder, n tokens): Concat(past, k) -> Gather(0) -> Transpose ->
//    MatMul(q, .) -> Where(causal mask from step_id, -inf, .) -> Softmax ->
//    MatMul(., Gather(Concat(past, v), 0)); k, v are [1, heads, n, head_dim],
//    q and the result [heads, n, head_dim].
function matchLayer(gk, gv, producer, consumers) {
  const uses = (name) => consumers.get(name) || [];
  const one = (name, op) => {
    const list = uses(name).filter((n) => n.op === op);
    return list.length === 1 ? list[0] : null;
  };
  const isConst = (name, value) => {
    const c = producer.get(name);
    return c && c.op === "Constant" && constantValue(c) === value;
  };
  const ck = one(gk.outputs[0], "Concat");
  const cv = one(gv.outputs[0], "Concat");
  if (!ck || !cv || uses(gk.outputs[0]).length !== 1 || uses(gv.outputs[0]).length !== 1) return null;
  if (ck.inputs.length !== 2 || cv.inputs.length !== 2 || ck.inputs[0] !== gk.outputs[0] || cv.inputs[0] !== gv.outputs[0]) return null;
  if (intAttr(ck, "axis") !== 2 || intAttr(cv, "axis") !== 2) return null;
  const softmaxOk = (sm) => sm && [-1, 3, 2].includes(intAttr(sm, "axis") ?? -1);

  const tr = one(ck.outputs[0], "Transpose");
  if (tr) {
    if ((intsAttr(tr, "perm") || []).join(",") !== "0,1,3,2") return null;
    const qk = one(tr.outputs[0], "MatMul");
    const sm = qk && qk.inputs[1] === tr.outputs[0] ? one(qk.outputs[0], "Softmax") : null;
    if (!softmaxOk(sm) || intAttr(sm, "axis") === 2) return null;
    const av = one(sm.outputs[0], "MatMul");
    if (!av || av.inputs[1] !== cv.outputs[0]) return null;
    return { kind: "step", q: qk.inputs[0], newK: ck.inputs[1], newV: cv.inputs[1], av };
  }
  const g4 = uses(ck.outputs[0]).find((n) => n.op === "Gather" && isConst(n.inputs[1], 0) && (intAttr(n, "axis") ?? 0) === 0);
  const g7 = uses(cv.outputs[0]).find((n) => n.op === "Gather" && isConst(n.inputs[1], 0) && (intAttr(n, "axis") ?? 0) === 0);
  if (!g4 || !g7) return null;
  const tr3 = one(g4.outputs[0], "Transpose");
  if (!tr3 || (intsAttr(tr3, "perm") || []).join(",") !== "0,2,1") return null;
  const qk = one(tr3.outputs[0], "MatMul");
  const where = qk && qk.inputs[1] === tr3.outputs[0] ? one(qk.outputs[0], "Where") : null;
  if (!where || where.inputs[2] !== qk.outputs[0] || !isConst(where.inputs[1], -Infinity)) return null;
  // The mask: Cast(Greater(positions, Unsqueeze(Cast(step_id), 1))).
  const cast = producer.get(where.inputs[0]);
  const greater = cast && cast.op === "Cast" ? producer.get(cast.inputs[0]) : null;
  const stepCol = greater && greater.op === "Greater" ? producer.get(greater.inputs[1]) : null;
  const stepCast = stepCol && stepCol.op === "Unsqueeze" && isConstList(producer.get(stepCol.inputs[1]), [1]) ? producer.get(stepCol.inputs[0]) : null;
  if (!stepCast || stepCast.op !== "Cast" || stepCast.inputs[0] !== "step_id" || intAttr(stepCast, "to") !== FLOAT) return null;
  const sm = one(where.outputs[0], "Softmax");
  if (!softmaxOk(sm)) return null;
  const av = one(sm.outputs[0], "MatMul");
  if (!av || av.inputs[1] !== g7.outputs[0]) return null;
  const uk = producer.get(ck.inputs[1]);
  const uv = producer.get(cv.inputs[1]);
  if (!uk || !uv || uk.op !== "Unsqueeze" || uv.op !== "Unsqueeze") return null;
  if (!isConstList(producer.get(uk.inputs[1]), [0]) || !isConstList(producer.get(uv.inputs[1]), [0])) return null;
  return { kind: "multi", q: qk.inputs[0], newK: ck.inputs[1], newV: cv.inputs[1], av };
}


// The replacement: attend to the cache (masked by self_mask) and to the new
// rows (causally, for several), one softmax over both, then sum the parts.
function layerNodes(layer, m) {
  const p = `/inplace_kv/${layer}/`;
  const kIn = `past_k_${layer}`;
  const vIn = `past_v_${layer}`;
  const nodes = [
    added("Transpose", [kIn], [p + "kT"], p + "kT", { perm: [0, 1, 3, 2] }),
    added("MatMul", [m.q, p + "kT"], [p + "s_past"], p + "s_past"),
    added("Add", [p + "s_past", "self_mask"], [p + "s_past_masked"], p + "s_past_masked"),
    added("Transpose", [m.newK], [p + "nkT"], p + "nkT", { perm: [0, 1, 3, 2] }),
    added("MatMul", [m.q, p + "nkT"], [p + "s_new"], p + "s_new"),
  ];
  let sNew = p + "s_new";
  if (m.kind === "multi") {
    nodes.push(added("Where", ["/inplace_kv/causal", "/inplace_kv/neg_inf", sNew], [p + "s_new_masked"], p + "s_new_masked"));
    sNew = p + "s_new_masked";
  }
  const out = m.kind === "multi" ? p + "o" : m.av.outputs[0];
  nodes.push(
    added("Concat", [p + "s_past_masked", sNew], [p + "s"], p + "s", { axis: 3 }),
    added("Softmax", [p + "s"], [p + "w"], p + "w", { axis: 3 }),
    added("Shape", [m.newK], [p + "n"], p + "n", { start: 2, end: 3 }),
    added("Concat", ["/inplace_kv/cap", p + "n"], [p + "split"], p + "split_sizes", { axis: 0 }),
    added("Split", [p + "w", p + "split"], [p + "w_past", p + "w_new"], p + "split", { axis: 3 }),
    added("MatMul", [p + "w_past", vIn], [p + "o_past"], p + "o_past"),
    added("MatMul", [p + "w_new", m.newV], [p + "o_new"], p + "o_new"),
    added("Add", [p + "o_past", p + "o_new"], [out], p + "o"),
  );
  if (m.kind === "multi") nodes.push(added("Squeeze", [out, "/inplace_kv/axis0"], [m.av.outputs[0]], p + "o_squeezed"));
  return nodes;
}

function rewriteGraph(buf, graphField) {
  const fields = readFields(graphField.value);
  const nodes = fields.filter((f) => f.no === GRAPH_NODE).map((f) => parseNode(graphField.value, f));
  const producer = new Map();
  const consumers = new Map();
  for (const n of nodes) {
    for (const o of n.outputs) producer.set(o, n);
    for (const i of n.inputs) {
      if (!consumers.has(i)) consumers.set(i, []);
      consumers.get(i).push(n);
    }
  }
  const layerOf = (gather) => {
    const c = producer.get(gather.inputs[1]);
    return c && c.op === "Constant" && (intAttr(gather, "axis") ?? 0) === 0 ? constantValue(c) : null;
  };

  const kGathers = consumers.get("past_self_k") || [];
  const vGathers = consumers.get("past_self_v") || [];
  const nLayers = kGathers.length;
  if (!nLayers || vGathers.length !== nLayers) return null;
  if (![...kGathers, ...vGathers].every((g) => g.op === "Gather" && Number.isInteger(layerOf(g)))) return null;

  const before = new Map();
  const dropped = new Set();
  const newRows = [];
  let kind = null;
  for (const gk of kGathers) {
    const layer = layerOf(gk);
    const gv = vGathers.find((g) => layerOf(g) === layer);
    const m = gv && layer < nLayers && !newRows[layer] ? matchLayer(gk, gv, producer, consumers) : null;
    if (!m || (kind && m.kind !== kind)) return null;
    kind = m.kind;
    before.set(m.av, layerNodes(layer, m));
    dropped.add(m.av);
    newRows[layer] = [m.newK, m.newV];
  }

  // cross_k/cross_v: Gather(layer) -> Identity(cross_k_<layer>).
  const replaced = new Map();
  for (const name of ["cross_k", "cross_v"]) {
    const gathers = consumers.get(name) || [];
    const layers = gathers.map((g) => (g.op === "Gather" && g.inputs[0] === name ? layerOf(g) : null));
    if (gathers.length !== nLayers || layers.some((l) => !Number.isInteger(l)) || new Set(layers).size !== nLayers) return null;
    gathers.forEach((g, i) => {
      const id = added("Identity", [`${name}_${layers[i]}`], g.outputs, g.name);
      replaced.set(g, id);
    });
  }

  const head = [
    added("Shape", ["past_k_0"], ["/inplace_kv/cap"], "/inplace_kv/cap", { start: 2, end: 3 }),
  ];
  if (kind === "multi") {
    // causal[i][j] = step_id[j] > step_id[i], as the exported mask for the new rows.
    head.push(
      added("Cast", ["step_id"], ["/inplace_kv/step"], "/inplace_kv/step", { to: FLOAT }),
      added("Unsqueeze", ["/inplace_kv/step", "/inplace_kv/axis0"], ["/inplace_kv/step_row"], "/inplace_kv/step_row"),
      added("Unsqueeze", ["/inplace_kv/step", "/inplace_kv/axis1"], ["/inplace_kv/step_col"], "/inplace_kv/step_col"),
      added("Greater", ["/inplace_kv/step_row", "/inplace_kv/step_col"], ["/inplace_kv/causal"], "/inplace_kv/causal"),
    );
  }
  const tail = [];
  const rowsK = [], rowsV = [];
  for (let i = 0; i < nLayers; i += 1) {
    const p = `/inplace_kv/${i}/`;
    tail.push(added("Unsqueeze", [newRows[i][0], "/inplace_kv/axis0"], [p + "nk_row"], p + "nk_row"));
    tail.push(added("Unsqueeze", [newRows[i][1], "/inplace_kv/axis0"], [p + "nv_row"], p + "nv_row"));
    rowsK.push(p + "nk_row");
    rowsV.push(p + "nv_row");
  }
  tail.push(added("Concat", rowsK, ["new_self_k"], "/inplace_kv/new_k", { axis: 0 }));
  tail.push(added("Concat", rowsV, ["new_self_v"], "/inplace_kv/new_v", { axis: 0 }));

  // The new node order, then everything that no longer reaches an output goes.
  const order = [...head];
  for (const n of nodes) {
    if (before.has(n)) order.push(...before.get(n));
    if (replaced.has(n)) order.push(replaced.get(n));
    else if (!dropped.has(n)) order.push(n);
  }
  order.push(...tail);
  const keepOutputs = new Set(["new_self_k", "new_self_v"]);
  const outputFields = fields.filter((f) => f.no === GRAPH_OUTPUT);
  for (const f of outputFields) {
    const name = valueInfoName(f.value);
    if (name !== "present_self_k" && name !== "present_self_v") keepOutputs.add(name);
  }
  const needed = new Set(keepOutputs);
  const live = new Array(order.length).fill(false);
  for (let i = order.length - 1; i >= 0; i -= 1) {
    if (!order[i].outputs.some((o) => needed.has(o))) continue;
    live[i] = true;
    for (const input of order[i].inputs) needed.add(input);
  }
  if (needed.has("past_self_k") || needed.has("past_self_v") || needed.has("cross_k") || needed.has("cross_v")) return null;

  const graph = new Message();
  let wroteNodes = false;
  for (const f of fields) {
    if (f.no === GRAPH_NODE) {
      if (!wroteNodes) {
        order.forEach((n, i) => {
          if (!live[i]) return;
          if (n.message) graph.message(GRAPH_NODE, n.message);
          else graph.raw(n.raw);
        });
        wroteNodes = true;
      }
      continue;
    }
    if (f.no === GRAPH_VALUE_INFO) continue;
    if (f.no === GRAPH_INPUT || f.no === GRAPH_OUTPUT) {
      const name = valueInfoName(f.value);
      if (["past_self_k", "past_self_v", "present_self_k", "present_self_v", "cross_k", "cross_v"].includes(name)) continue;
    }
    graph.raw(graphField.value.subarray(f.start, f.end));
  }
  graph.message(GRAPH_INITIALIZER, int64Initializer("/inplace_kv/axis0", [0]));
  if (kind === "multi") {
    graph.message(GRAPH_INITIALIZER, int64Initializer("/inplace_kv/axis1", [1]));
    graph.message(GRAPH_INITIALIZER, floatScalarInitializer("/inplace_kv/neg_inf", -Infinity));
  }
  for (let i = 0; i < nLayers; i += 1) {
    graph.message(GRAPH_INPUT, floatInput(`past_k_${i}`, ["batch", "heads", "cap", "head_dim"]));
    graph.message(GRAPH_INPUT, floatInput(`past_v_${i}`, ["batch", "heads", "cap", "head_dim"]));
  }
  graph.message(GRAPH_INPUT, floatInput("self_mask", ["cap"]));
  for (let i = 0; i < nLayers; i += 1) {
    graph.message(GRAPH_INPUT, floatInput(`cross_k_${i}`, ["heads", "n_beats", "head_dim"]));
    graph.message(GRAPH_INPUT, floatInput(`cross_v_${i}`, ["heads", "n_beats", "head_dim"]));
  }
  graph.message(GRAPH_OUTPUT, floatInput("new_self_k", [nLayers, "batch", "heads", "n_new", "head_dim"]));
  graph.message(GRAPH_OUTPUT, floatInput("new_self_v", [nLayers, "batch", "heads", "n_new", "head_dim"]));
  return graph;
}


export function inPlaceDecoderGraph(bytes) {
  try {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const fields = readFields(buf);
    // Split and Unsqueeze take their sizes as inputs from opset 13, Shape start/end from 15.
    if (onnxOpset(fields) < 15) return null;
    const graphField = fields.find((f) => f.no === MODEL_GRAPH);
    if (!graphField) return null;
    const graph = rewriteGraph(buf, graphField);
    if (!graph) return null;
    const model = new Message();
    for (const f of fields) {
      if (f.no === MODEL_GRAPH) model.message(MODEL_GRAPH, graph);
      else model.raw(buf.subarray(f.start, f.end));
    }
    return model.finish();
  } catch {
    return null;
  }
}
