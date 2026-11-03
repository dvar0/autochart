// Rewrites the transcriber's decoder graphs (ONNX bytes) for WebGPU:
// decoder_step (one token per stream) and the fill-in decoder (n tokens of
// one stream). transcribe.mjs and inpaint.mjs drive the results.
//
// The exported graphs take the whole self-attention cache (past_self_k/v
// [layers, batch, heads, past, head_dim]) and return it with the new rows
// appended, so every call copies the whole cache several times over (one
// Gather and one Concat per layer, then a Concat of all layers) into freshly
// allocated buffers. The rewritten graph takes each layer's cache as
// past_key_<i>/past_value_<i> [batch, heads, cap, head_dim], a buffer with
// room for `cap` rows, and runs each layer's self-attention as one
// GroupQueryAttention (com.microsoft) that writes the new rows into that
// buffer: the caller passes the same tensors as the
// present_key_<i>/present_value_<i> outputs, so the cache never moves.
// total_sequence_length (int32 scalar) is the filled rows after the call and
// seqlens_k [batch] (int32) one less.
//
// It also splits every weight matmul ([rows, K] x [K, N]) along K into blocks
// of 64 (Reshape -> batched MatMul -> ReduceSum): ONNX Runtime's WebGPU
// kernels spread a one-row matmul over far too few threads, and the split
// form runs about twice as fast. In the fill-in decoder the blocks are the
// batch, so a chunk of many tokens still runs as a few large matmuls.
//
// The logits match the original's up to float rounding (the sums run in
// another order). Returns null when the graph isn't the expected shape.

import {
  readFields, parseNode, intAttr, floatAttr, intsAttr, constantValue, int64Initializer, floatInitializer,
  parseTensor, floatInput, tensorInput, valueInfoName, added, makeNode, onnxOpset, Message,
  MODEL_IR_VERSION, MODEL_OPSET, MODEL_GRAPH, GRAPH_NAME, OPSET_DOMAIN, OPSET_VERSION, INT64,
  GRAPH_NODE, GRAPH_INITIALIZER, GRAPH_INPUT, GRAPH_OUTPUT, GRAPH_VALUE_INFO,
} from "./onnxProto.mjs";

const SPLIT = 64;
const INT32 = 6;
const P = "/layer_kv/";

// A Reshape's target as the constants after its leading (batch) entry, read
// through the Concat(Unsqueeze(batch), Constant, ...) the exporter writes.
function reshapeTail(reshape, producer) {
  const shape = producer.get(reshape.inputs[1]);
  if (!shape) return null;
  if (shape.op === "Constant") {
    const values = constantValue(shape, true);
    return values ? values.slice(1) : null;
  }
  if (shape.op !== "Concat" || intAttr(shape, "axis") !== 0) return null;
  const tail = [];
  for (const name of shape.inputs.slice(1)) {
    const c = producer.get(name);
    const v = c && c.op === "Constant" ? constantValue(c, true) : null;
    if (!v || v.length !== 1) return null;
    tail.push(v[0]);
  }
  return tail;
}

// One layer's self-attention, or null:
//   Gather(past_self_k, i) -> Concat(., k) -> Transpose -> MatMul(Mul(q, scale), .)
//   -> Softmax -> MatMul(., Concat(Gather(past_self_v, i), v)) -> Reshape
// with q, k, v Reshapes of [batch, heads*head_dim] rows to [batch, heads, 1, head_dim].
function matchLayer(gk, gv, producer, consumers) {
  const uses = (name) => consumers.get(name) || [];
  const only = (name, op) => {
    const list = uses(name);
    return list.length === 1 && list[0].op === op ? list[0] : null;
  };
  const ck = only(gk.outputs[0], "Concat");
  const cv = only(gv.outputs[0], "Concat");
  if (!ck || !cv || ck.inputs.length !== 2 || cv.inputs.length !== 2) return null;
  if (ck.inputs[0] !== gk.outputs[0] || cv.inputs[0] !== gv.outputs[0]) return null;
  if (intAttr(ck, "axis") !== 2 || intAttr(cv, "axis") !== 2) return null;
  const tr = uses(ck.outputs[0]).find((n) => n.op === "Transpose");
  if (!tr || (intsAttr(tr, "perm") || []).join(",") !== "0,1,3,2") return null;
  const qk = only(tr.outputs[0], "MatMul");
  if (!qk || qk.inputs[1] !== tr.outputs[0]) return null;
  const sm = only(qk.outputs[0], "Softmax");
  if (!sm || ![-1, 3].includes(intAttr(sm, "axis") ?? -1)) return null;
  const av = only(sm.outputs[0], "MatMul");
  if (!av || av.inputs[1] !== cv.outputs[0]) return null;
  const out = only(av.outputs[0], "Reshape");
  const mul = producer.get(qk.inputs[0]);
  if (!out || !mul || mul.op !== "Mul") return null;
  const scaleNode = producer.get(mul.inputs[1]);
  const scale = scaleNode && scaleNode.op === "Constant" ? constantValue(scaleNode) : null;
  const rq = producer.get(mul.inputs[0]);
  const rk = producer.get(ck.inputs[1]);
  const rv = producer.get(cv.inputs[1]);
  if (typeof scale !== "number" || !rq || !rk || !rv || [rq, rk, rv].some((n) => n.op !== "Reshape")) return null;
  const tails = [rq, rk, rv].map((n) => reshapeTail(n, producer));
  if (tails.some((t) => !t || t.length !== 3 || t[1] !== 1 || t[0] !== tails[0][0] || t[2] !== tails[0][2])) return null;
  const [heads, , headDim] = tails[0];
  const outTail = reshapeTail(out, producer);
  if (!outTail || outTail.length !== 1 || outTail[0] !== heads * headDim) return null;
  return { q: rq.inputs[0], k: rk.inputs[0], v: rv.inputs[0], out, heads, scale, axis: P + "axis1" };
}

// The same self-attention in a graph that takes n tokens of one stream (the
// fill-in decoder), or null:
//   Gather(past_self_k, i) -> Concat(., Unsqueeze(T(k))) -> Gather(0) -> Transpose(0,2,1)
//   -> MatMul(Mul(T(q), scale), .) -> Where(future, -inf, .) -> Softmax
//   -> MatMul(., Gather(Concat(Gather(past_self_v, i), Unsqueeze(T(v))), 0)) -> T -> Reshape
// with q, k, v Reshapes of [n, heads*head_dim] rows to [n, heads, head_dim]
// and T = Transpose(1,0,2). Where hides keys past each token's step_id, which
// is the causal mask GroupQueryAttention applies (the caller feeds step_id =
// cache length + position).
function matchTokensLayer(gk, gv, producer, consumers) {
  const uses = (name) => consumers.get(name) || [];
  const only = (name, op) => {
    const list = uses(name);
    return list.length === 1 && list[0].op === op ? list[0] : null;
  };
  const perm = (n, p) => n && n.op === "Transpose" && (intsAttr(n, "perm") || []).join(",") === p;
  // A Constant 0, as a scalar (Gather index) or a one-entry list (axes).
  const zeroConst = (name) => {
    const c = producer.get(name);
    if (!c || c.op !== "Constant") return false;
    const list = constantValue(c, true);
    return list ? list.length === 1 && list[0] === 0 : constantValue(c) === 0;
  };
  // Concat(Gather(past, i), Unsqueeze(Transpose(Reshape(rows)), 0)) -> the Reshape.
  const newRows = (gather) => {
    const concat = only(gather.outputs[0], "Concat");
    if (!concat || concat.inputs.length !== 2 || concat.inputs[0] !== gather.outputs[0] || intAttr(concat, "axis") !== 2) return null;
    const un = producer.get(concat.inputs[1]);
    if (!un || un.op !== "Unsqueeze" || !zeroConst(un.inputs[1])) return null;
    const tr = producer.get(un.inputs[0]);
    if (!perm(tr, "1,0,2")) return null;
    const reshape = producer.get(tr.inputs[0]);
    return reshape && reshape.op === "Reshape" ? { concat, reshape } : null;
  };
  // Gather(concat, 0) along axis 0: the one stream's rows.
  const streamOf = (concat) => uses(concat.outputs[0]).filter((n) => n.op === "Gather" && (intAttr(n, "axis") ?? 0) === 0 && zeroConst(n.inputs[1]));
  const k = newRows(gk);
  const v = newRows(gv);
  if (!k || !v) return null;
  let qk = null, kt = null;
  for (const g of streamOf(k.concat)) {
    for (const t of uses(g.outputs[0])) {
      const mm = perm(t, "0,2,1") ? only(t.outputs[0], "MatMul") : null;
      if (mm && mm.inputs[1] === t.outputs[0]) [qk, kt] = [mm, t];
    }
  }
  if (!qk || !kt) return null;
  const where = only(qk.outputs[0], "Where");
  if (!where || where.inputs[2] !== qk.outputs[0]) return null;
  const fill = producer.get(where.inputs[1]);
  const fillValue = fill && fill.op === "Constant" ? constantValue(fill) : null;
  if (typeof fillValue !== "number" || !(fillValue <= -1e9)) return null;
  // The mask compares key positions with step_id.
  const fromStepId = (name, depth = 0) => {
    if (name === "step_id") return true;
    const n = producer.get(name);
    return Boolean(n && depth < 4 && ["Cast", "Unsqueeze"].includes(n.op) && fromStepId(n.inputs[0], depth + 1));
  };
  const cond = producer.get(where.inputs[0]);
  const greater = cond && cond.op === "Cast" ? producer.get(cond.inputs[0]) : cond;
  if (!greater || greater.op !== "Greater" || !fromStepId(greater.inputs[1])) return null;
  const sm = only(where.outputs[0], "Softmax");
  if (!sm || ![-1, 2].includes(intAttr(sm, "axis") ?? -1)) return null;
  const av = only(sm.outputs[0], "MatMul");
  const vStream = av && producer.get(av.inputs[1]);
  if (!vStream || !streamOf(v.concat).includes(vStream)) return null;
  const outT = only(av.outputs[0], "Transpose");
  if (!perm(outT, "1,0,2")) return null;
  const out = only(outT.outputs[0], "Reshape");
  const mul = producer.get(qk.inputs[0]);
  if (!out || !mul || mul.op !== "Mul") return null;
  const scaleNode = producer.get(mul.inputs[1]);
  const scale = scaleNode && scaleNode.op === "Constant" ? constantValue(scaleNode) : null;
  const tq = producer.get(mul.inputs[0]);
  const rq = perm(tq, "1,0,2") ? producer.get(tq.inputs[0]) : null;
  if (typeof scale !== "number" || !rq || rq.op !== "Reshape") return null;
  const tails = [rq, k.reshape, v.reshape].map((n) => reshapeTail(n, producer));
  if (tails.some((t) => !t || t.length !== 2 || t[0] !== tails[0][0] || t[1] !== tails[0][1])) return null;
  const [heads, headDim] = tails[0];
  const outTail = reshapeTail(out, producer);
  if (!outTail || outTail.length !== 1 || outTail[0] !== heads * headDim) return null;
  return { q: rq.inputs[0], k: k.reshape.inputs[0], v: v.reshape.inputs[0], out, heads, scale, axis: P + "axis0" };
}

// GroupQueryAttention reads q, k, v as [batch, rows, heads*head_dim]: one
// token per stream (rows on axis 1) or n tokens of one stream (axis 0).
function attentionNodes(layer, m) {
  const p = `${P}${layer}/`;
  return [
    added("Unsqueeze", [m.q, m.axis], [p + "q"], p + "q"),
    added("Unsqueeze", [m.k, m.axis], [p + "k"], p + "k"),
    added("Unsqueeze", [m.v, m.axis], [p + "v"], p + "v"),
    added("GroupQueryAttention", [p + "q", p + "k", p + "v", `past_key_${layer}`, `past_value_${layer}`, "seqlens_k", "total_sequence_length"],
      [p + "o", `present_key_${layer}`, `present_value_${layer}`], p + "attention",
      { num_heads: m.heads, kv_num_heads: m.heads, scale: { float: m.scale } }, "com.microsoft"),
    added("Squeeze", [p + "o", m.axis], m.out.outputs, p + "o_rows"),
  ];
}

// x [rows, K] times W [K, N] (plus bias) as K/64 blocks summed. With few rows
// (one per stream) each row is its own batch of blocks; with many (a chunk of
// tokens) the blocks are the batch, so each block's matmul covers every row.
function splitMatmul(tag, x, w, k, n, bias, output, initializers, manyRows = false) {
  const blocks = k / SPLIT;
  const p = `${P}sk/${tag}/`;
  initializers.push(floatInitializer(p + "W", [blocks, SPLIT, n], w));
  initializers.push(int64Initializer(p + "out_shape", [-1, n]));
  let nodes;
  if (manyRows) {
    initializers.push(int64Initializer(p + "in_shape", [-1, blocks, SPLIT]));
    nodes = [
      added("Reshape", [x, p + "in_shape"], [p + "x3"], p + "x3"),
      added("Transpose", [p + "x3"], [p + "x"], p + "x", { perm: [1, 0, 2] }),
      added("MatMul", [p + "x", p + "W"], [p + "parts"], p + "parts"),
      added("ReduceSum", [p + "parts", P + "axis0"], [p + "sum"], p + "sum", { keepdims: 0 }),
    ];
  } else {
    initializers.push(int64Initializer(p + "in_shape", [-1, blocks, 1, SPLIT]));
    nodes = [
      added("Reshape", [x, p + "in_shape"], [p + "x"], p + "x"),
      added("MatMul", [p + "x", p + "W"], [p + "parts"], p + "parts"),
      added("ReduceSum", [p + "parts", P + "axis1"], [p + "sum"], p + "sum", { keepdims: 0 }),
    ];
  }
  if (bias) {
    nodes.push(added("Reshape", [p + "sum", p + "out_shape"], [p + "rows"], p + "rows"));
    nodes.push(added("Add", [p + "rows", bias], [output], p + "bias"));
  } else {
    nodes.push(added("Reshape", [p + "sum", p + "out_shape"], [output], p + "rows"));
  }
  return nodes;
}

function rewriteGraph(graphField) {
  const fields = readFields(graphField.value);
  const nodes = fields.filter((f) => f.no === GRAPH_NODE).map((f) => parseNode(graphField.value, f));
  const weights = new Map();
  for (const f of fields) {
    if (f.no !== GRAPH_INITIALIZER) continue;
    const t = parseTensor(f.value);
    weights.set(t.name, t);
  }
  const producer = new Map();
  const consumers = new Map();
  for (const n of nodes) {
    for (const o of n.outputs) producer.set(o, n);
    for (const i of n.inputs) {
      if (!consumers.has(i)) consumers.set(i, []);
      consumers.get(i).push(n);
    }
  }
  const inputNames = fields.filter((f) => f.no === GRAPH_INPUT).map((f) => valueInfoName(f.value));
  if (!inputNames.includes("token_id") || !inputNames.includes("past_self_k")) return null;
  const layerOf = (gather) => {
    const c = producer.get(gather.inputs[1]);
    return gather.op === "Gather" && c && c.op === "Constant" && (intAttr(gather, "axis") ?? 0) === 0 ? constantValue(c) : null;
  };

  // Self-attention, layer by layer.
  const kGathers = consumers.get("past_self_k") || [];
  const vGathers = consumers.get("past_self_v") || [];
  const nLayers = kGathers.length;
  if (!nLayers || vGathers.length !== nLayers) return null;
  const before = new Map();
  const dropped = new Set();
  const seen = new Set();
  let rowsAxis = null;
  for (const gk of kGathers) {
    const layer = layerOf(gk);
    const gv = vGathers.find((g) => layerOf(g) === layer);
    if (!Number.isInteger(layer) || layer < 0 || layer >= nLayers || seen.has(layer) || !gv) return null;
    const m = matchLayer(gk, gv, producer, consumers) || matchTokensLayer(gk, gv, producer, consumers);
    if (!m || (rowsAxis && m.axis !== rowsAxis)) return null;
    rowsAxis = m.axis;
    seen.add(layer);
    before.set(m.out, attentionNodes(layer, m));
    dropped.add(m.out);
  }

  // Weight matmuls. Every activation here is [rows, features]: one row per
  // stream (one token each) or per token (one stream).
  const found = [];
  for (const n of nodes) {
    let w = null, k = 0, cols = 0, bias = null, output = n.outputs[0], add = null;
    if (n.op === "Gemm") {
      const t = weights.get(n.inputs[1]);
      const alpha = floatAttr(n, "alpha") ?? 1, beta = floatAttr(n, "beta") ?? 1;
      if (!t || !t.data || t.dims.length !== 2 || (intAttr(n, "transA") ?? 0) !== 0 || alpha !== 1 || beta !== 1) continue;
      if (n.inputs.length > 2 && n.inputs[2]) {
        bias = weights.get(n.inputs[2]);
        if (!bias || !bias.data || bias.data.length !== (intAttr(n, "transB") ? t.dims[0] : t.dims[1])) continue;
      }
      if (intAttr(n, "transB")) {
        [cols, k] = t.dims;
        w = new Float32Array(k * cols);
        for (let r = 0; r < cols; r += 1) for (let c = 0; c < k; c += 1) w[c * cols + r] = t.data[r * k + c];
      } else {
        [k, cols] = t.dims;
        w = t.data;
      }
    } else if (n.op === "MatMul") {
      const t = weights.get(n.inputs[1]);
      if (!t || !t.data || t.dims.length !== 2 || weights.has(n.inputs[0])) continue;
      [k, cols] = t.dims;
      w = t.data;
      const users = consumers.get(n.outputs[0]) || [];
      const user = users.length === 1 && users[0].op === "Add" && users[0].inputs[0] === n.outputs[0] ? users[0] : null;
      const b = user ? weights.get(user.inputs[1]) : null;
      if (b && b.data && b.dims.length === 1 && b.dims[0] === cols) {
        bias = b;
        output = user.outputs[0];
        add = user;
      }
    } else continue;
    if (k % SPLIT !== 0 || k <= SPLIT) continue;
    found.push({ node: n, x: n.inputs[0], w, k, cols, bias, output, add });
  }
  if (!found.length) return null;

  // Matmuls of the same rows (a layer's q, k and v) run as one, then split.
  const groups = new Map();
  for (const m of found) {
    const key = `${m.x}|${m.k}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const manyRows = rowsAxis === P + "axis0";
  const initializers = [];
  const replaced = new Map();
  let tag = 0;
  for (const group of groups.values()) {
    const { x, k } = group[0];
    for (const m of group) if (m.add) dropped.add(m.add);
    if (group.length === 1) {
      const m = group[0];
      const biasName = m.bias ? `${P}sk/${tag}/bias` : null;
      if (m.bias) initializers.push(floatInitializer(biasName, [m.cols], m.bias.data));
      replaced.set(m.node, splitMatmul(tag, x, m.w, k, m.cols, biasName, m.output, initializers, manyRows));
      tag += 1;
      continue;
    }
    const cols = group.reduce((a, m) => a + m.cols, 0);
    const w = new Float32Array(k * cols);
    const bias = new Float32Array(cols);
    let at = 0;
    for (const m of group) {
      for (let r = 0; r < k; r += 1) w.set(m.w.subarray(r * m.cols, (r + 1) * m.cols), r * cols + at);
      if (m.bias) bias.set(m.bias.data, at);
      at += m.cols;
    }
    const p = `${P}sk/${tag}/`;
    initializers.push(floatInitializer(p + "bias", [cols], bias));
    initializers.push(int64Initializer(p + "sizes", group.map((m) => m.cols)));
    const nodes = splitMatmul(tag, x, w, k, cols, p + "bias", p + "joined", initializers, manyRows);
    nodes.push(added("Split", [p + "joined", p + "sizes"], group.map((m) => m.output), p + "split", { axis: 1 }));
    replaced.set(group[0].node, nodes);
    for (const m of group.slice(1)) dropped.add(m.node);
    tag += 1;
  }

  const order = [];
  for (const n of nodes) {
    if (before.has(n)) order.push(...before.get(n));
    if (replaced.has(n)) order.push(...replaced.get(n));
    else if (!dropped.has(n)) order.push(n);
  }
  const keepOutputs = new Set();
  for (let i = 0; i < nLayers; i += 1) keepOutputs.add(`present_key_${i}`).add(`present_value_${i}`);
  for (const f of fields.filter((x) => x.no === GRAPH_OUTPUT)) {
    const name = valueInfoName(f.value);
    if (name !== "present_self_k" && name !== "present_self_v") keepOutputs.add(name);
  }
  const needed = new Set(keepOutputs);
  const live = new Array(order.length).fill(false);
  for (let i = order.length - 1; i >= 0; i -= 1) {
    if (!order[i].outputs.some((o) => needed.has(o))) continue;
    live[i] = true;
    for (const input of order[i].inputs) if (input) needed.add(input);
  }
  if (needed.has("past_self_k") || needed.has("past_self_v")) return null;

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
    if (f.no === GRAPH_INITIALIZER && !needed.has(parseTensorName(f.value))) continue;
    if (f.no === GRAPH_INPUT || f.no === GRAPH_OUTPUT) {
      const name = valueInfoName(f.value);
      if (["past_self_k", "past_self_v", "present_self_k", "present_self_v"].includes(name)) continue;
    }
    graph.raw(graphField.value.subarray(f.start, f.end));
  }
  graph.message(GRAPH_INITIALIZER, int64Initializer(P + "axis0", [0]));
  graph.message(GRAPH_INITIALIZER, int64Initializer(P + "axis1", [1]));
  for (const t of initializers) graph.message(GRAPH_INITIALIZER, t);
  for (let i = 0; i < nLayers; i += 1) {
    graph.message(GRAPH_INPUT, floatInput(`past_key_${i}`, ["batch", "heads", "cap", "head_dim"]));
    graph.message(GRAPH_INPUT, floatInput(`past_value_${i}`, ["batch", "heads", "cap", "head_dim"]));
  }
  graph.message(GRAPH_INPUT, tensorInput("seqlens_k", INT32, ["batch"]));
  graph.message(GRAPH_INPUT, tensorInput("total_sequence_length", INT32, []));
  for (let i = 0; i < nLayers; i += 1) {
    graph.message(GRAPH_OUTPUT, floatInput(`present_key_${i}`, ["batch", "heads", "cap", "head_dim"]));
    graph.message(GRAPH_OUTPUT, floatInput(`present_value_${i}`, ["batch", "heads", "cap", "head_dim"]));
  }
  return graph;
}

function parseTensorName(bytes) {
  const f = readFields(bytes).find((x) => x.no === 8);
  return f ? new TextDecoder().decode(f.value) : "";
}

export function layerKvDecoderGraph(bytes) {
  try {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const fields = readFields(buf);
    // Squeeze, Unsqueeze and ReduceSum take their axes as inputs from opset 13.
    if (onnxOpset(fields) < 13) return null;
    const graphField = fields.find((f) => f.no === MODEL_GRAPH);
    if (!graphField) return null;
    const graph = rewriteGraph(graphField);
    if (!graph) return null;
    const model = new Message();
    let hasMicrosoft = false;
    for (const f of fields) {
      if (f.no === MODEL_GRAPH) model.message(MODEL_GRAPH, graph);
      else {
        if (f.no === MODEL_OPSET) {
          const domain = readFields(f.value).find((x) => x.no === OPSET_DOMAIN);
          if (domain && new TextDecoder().decode(domain.value) === "com.microsoft") hasMicrosoft = true;
        }
        model.raw(buf.subarray(f.start, f.end));
      }
    }
    if (!hasMicrosoft) model.message(MODEL_OPSET, new Message().string(OPSET_DOMAIN, "com.microsoft").varint(OPSET_VERSION, 1));
    return model.finish();
  } catch {
    return null;
  }
}


// A graph copying the first `keep` rows of one layer's cache (k, v [batch,
// heads, rows, head_dim]) into new buffers with room for `cap` rows (k_out,
// v_out), zeros after: Pad(Slice(x, keep), cap - keep). It makes, grows and
// cuts the caches, all on the device.
export function layerKvResizeGraph() {
  const graph = new Message();
  graph.message(GRAPH_NODE, makeNode("Concat", ["zeros6", "extra", "zero"], ["pads"], "pads", { axis: 0 }));
  for (const name of ["k", "v"]) {
    graph.message(GRAPH_NODE, makeNode("Slice", [name, "zero", "keep", "axis2"], [`${name}_kept`], `${name}_kept`));
    graph.message(GRAPH_NODE, makeNode("Pad", [`${name}_kept`, "pads"], [`${name}_out`], `${name}_out`));
  }
  graph.string(GRAPH_NAME, "layer_kv_resize");
  graph.message(GRAPH_INITIALIZER, int64Initializer("zero", [0]));
  graph.message(GRAPH_INITIALIZER, int64Initializer("zeros6", [0, 0, 0, 0, 0, 0]));
  graph.message(GRAPH_INITIALIZER, int64Initializer("axis2", [2]));
  const dims = ["batch", "heads", "rows", "head_dim"];
  graph.message(GRAPH_INPUT, floatInput("k", dims));
  graph.message(GRAPH_INPUT, floatInput("v", dims));
  graph.message(GRAPH_INPUT, tensorInput("keep", INT64, [1]));
  graph.message(GRAPH_INPUT, tensorInput("extra", INT64, [1]));
  graph.message(GRAPH_OUTPUT, floatInput("k_out", ["batch", "heads", "cap", "head_dim"]));
  graph.message(GRAPH_OUTPUT, floatInput("v_out", ["batch", "heads", "cap", "head_dim"]));
  return new Message()
    .varint(MODEL_IR_VERSION, 8)
    .message(MODEL_OPSET, new Message().string(OPSET_DOMAIN, "").varint(OPSET_VERSION, 17))
    .message(MODEL_GRAPH, graph)
    .finish();
}
