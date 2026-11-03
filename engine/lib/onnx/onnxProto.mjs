// Just enough of ONNX's protobuf wire format to rewrite a model's graph in
// place: read nodes and initializers, write new ones. Shared by the decoder
// graph rewrites (decoderInPlace.mjs, decoderLayerKv.mjs).

function readVarint(buf, pos) {
  let value = 0;
  let scale = 1;
  for (;;) {
    const b = buf[pos++];
    value += (b & 0x7f) * scale;
    if (b < 0x80) return [value, pos];
    scale *= 128;
  }
}

// [{ no, wire, start, end, value }] for one message; start..end is the whole
// field (tag included), value is a varint's value or a length field's bytes,
// raw a varint's own bytes.
function readFields(buf, start = 0, end = buf.length) {
  const fields = [];
  let pos = start;
  while (pos < end) {
    const fieldStart = pos;
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const no = Math.floor(tag / 8);
    const wire = tag & 7;
    let value;
    let raw = null;
    if (wire === 0) {
      const valueStart = pos;
      [value, pos] = readVarint(buf, pos);
      raw = buf.subarray(valueStart, pos);
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 1) { value = buf.subarray(pos, pos + 8); pos += 8; }
    else if (wire === 5) { value = buf.subarray(pos, pos + 4); pos += 4; }
    else throw new Error(`protobuf wire type ${wire}`);
    fields.push({ no, wire, start: fieldStart, end: pos, value, raw });
  }
  return fields;
}

const utf8 = new TextDecoder();
const text = (bytes) => utf8.decode(bytes);
const encoder = new TextEncoder();

function varintBytes(value) {
  const out = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

// A message under construction: a list of byte chunks.
class Message {
  constructor() { this.chunks = []; this.size = 0; }
  raw(bytes) { this.chunks.push(bytes); this.size += bytes.length; return this; }
  varint(no, value) { return this.raw(Uint8Array.from([...varintBytes(no * 8), ...varintBytes(value)])); }
  bytes(no, bytes) {
    this.raw(Uint8Array.from([...varintBytes(no * 8 + 2), ...varintBytes(bytes.length)]));
    return this.raw(bytes);
  }
  string(no, s) { return this.bytes(no, encoder.encode(s)); }
  float(no, value) {
    const raw = new Uint8Array(4);
    new DataView(raw.buffer).setFloat32(0, value, true);
    this.raw(Uint8Array.from(varintBytes(no * 8 + 5)));
    return this.raw(raw);
  }
  message(no, m) { return this.bytes(no, m.finish()); }
  finish() {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}

// ONNX field numbers.
const MODEL_IR_VERSION = 1, MODEL_OPSET = 8, MODEL_GRAPH = 7;
const OPSET_DOMAIN = 1, OPSET_VERSION = 2;
const GRAPH_NODE = 1, GRAPH_NAME = 2, GRAPH_INITIALIZER = 5, GRAPH_INPUT = 11, GRAPH_OUTPUT = 12, GRAPH_VALUE_INFO = 13;
const NODE_INPUT = 1, NODE_OUTPUT = 2, NODE_NAME = 3, NODE_OP = 4, NODE_ATTR = 5, NODE_DOMAIN = 7;
const ATTR_NAME = 1, ATTR_FLOAT = 2, ATTR_INT = 3, ATTR_TENSOR = 5, ATTR_INTS = 8, ATTR_TYPE = 20;
const ATTR_TYPE_FLOAT = 1, ATTR_TYPE_INT = 2, ATTR_TYPE_INTS = 7;
const TENSOR_DIMS = 1, TENSOR_TYPE = 2, TENSOR_FLOAT = 4, TENSOR_INT64 = 7, TENSOR_NAME = 8, TENSOR_RAW = 9, TENSOR_LOCATION = 14;
const INT64 = 7, FLOAT = 1;
const VI_NAME = 1, VI_TYPE = 2, TYPE_TENSOR = 1, TT_ELEM = 1, TT_SHAPE = 2, SHAPE_DIM = 1, DIM_VALUE = 1, DIM_PARAM = 2;

function parseNode(buf, field) {
  const node = { raw: buf.subarray(field.start, field.end), inputs: [], outputs: [], name: "", op: "", domain: "", attrs: [] };
  for (const f of readFields(field.value)) {
    if (f.no === NODE_INPUT) node.inputs.push(text(f.value));
    else if (f.no === NODE_OUTPUT) node.outputs.push(text(f.value));
    else if (f.no === NODE_NAME) node.name = text(f.value);
    else if (f.no === NODE_OP) node.op = text(f.value);
    else if (f.no === NODE_DOMAIN) node.domain = text(f.value);
    else if (f.no === NODE_ATTR) node.attrs.push(f.value);
  }
  return node;
}

// An attribute's fields by name, or null.
function attribute(node, name) {
  for (const bytes of node.attrs) {
    const fields = readFields(bytes);
    const nameField = fields.find((f) => f.no === ATTR_NAME);
    if (nameField && text(nameField.value) === name) return fields;
  }
  return null;
}

// int64 attributes are two's complement varints; negatives take ten bytes.
function intAttr(node, name) {
  const fields = attribute(node, name);
  const f = fields && fields.find((x) => x.no === ATTR_INT);
  return f ? signedVarint(f.raw) : null;
}

function signedVarint(bytes) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) v = (v << 7n) | BigInt(bytes[i] & 0x7f);
  return Number(BigInt.asIntN(64, v));
}

function floatAttr(node, name) {
  const fields = attribute(node, name);
  const f = fields && fields.find((x) => x.no === ATTR_FLOAT && x.wire === 5);
  return f ? new DataView(f.value.buffer, f.value.byteOffset, 4).getFloat32(0, true) : null;
}

function intsAttr(node, name) {
  const fields = attribute(node, name);
  if (!fields) return null;
  const out = [];
  for (const f of fields) {
    if (f.no !== ATTR_INTS) continue;
    if (f.wire === 0) out.push(f.value);
    else for (let p = 0; p < f.value.length;) { let v; [v, p] = readVarint(f.value, p); out.push(v); }
  }
  return out;
}

// A Constant node's value: an int64 or float scalar, or with asList a 1-D
// int64 list; null for anything else.
function constantValue(node, asList = false) {
  const fields = attribute(node, "value");
  const t = fields && fields.find((f) => f.no === ATTR_TENSOR);
  if (!t) return null;
  const tf = readFields(t.value);
  const type = tf.find((f) => f.no === TENSOR_TYPE);
  const dims = tf.filter((f) => f.no === TENSOR_DIMS).map((f) => f.value);
  if (asList ? dims.length !== 1 : dims.length !== 0) return null;
  const raw = tf.find((f) => f.no === TENSOR_RAW);
  const count = asList ? dims[0] : 1;
  if (!type) return null;
  let values = null;
  if (type.value === INT64) {
    if (raw) {
      if (raw.value.length !== 8 * count) return null;
      const view = new DataView(raw.value.buffer, raw.value.byteOffset, raw.value.length);
      values = Array.from({ length: count }, (_, i) => Number(view.getBigInt64(i * 8, true)));
    } else {
      values = [];
      for (const f of tf.filter((x) => x.no === TENSOR_INT64)) {
        if (f.wire === 0) values.push(signedVarint(f.raw));
        else for (let p = 0; p < f.value.length;) { const s0 = p; [, p] = readVarint(f.value, p); values.push(signedVarint(f.value.subarray(s0, p))); }
      }
    }
  } else if (type.value === FLOAT && !asList) {
    if (raw && raw.value.length === 4) values = [new DataView(raw.value.buffer, raw.value.byteOffset, 4).getFloat32(0, true)];
    const fd = tf.find((f) => f.no === TENSOR_FLOAT);
    if (!values && fd) values = [new DataView(fd.value.buffer, fd.value.byteOffset, 4).getFloat32(0, true)];
  }
  if (!values || values.length !== count) return null;
  return asList ? values : values[0];
}

function makeNode(op, inputs, outputs, name, attrs = {}, domain = "") {
  const m = new Message();
  for (const i of inputs) m.string(NODE_INPUT, i);
  for (const o of outputs) m.string(NODE_OUTPUT, o);
  m.string(NODE_NAME, name).string(NODE_OP, op);
  if (domain) m.string(NODE_DOMAIN, domain);
  for (const [key, value] of Object.entries(attrs)) {
    const a = new Message().string(ATTR_NAME, key);
    if (Array.isArray(value)) {
      for (const v of value) a.varint(ATTR_INTS, v);
      a.varint(ATTR_TYPE, ATTR_TYPE_INTS);
    } else if (value && typeof value === "object" && typeof value.float === "number") {
      a.float(ATTR_FLOAT, value.float).varint(ATTR_TYPE, ATTR_TYPE_FLOAT);
    } else {
      a.varint(ATTR_INT, value).varint(ATTR_TYPE, ATTR_TYPE_INT);
    }
    m.message(NODE_ATTR, a);
  }
  return m;
}

function int64Initializer(name, values) {
  const raw = new Uint8Array(values.length * 8);
  const view = new DataView(raw.buffer);
  values.forEach((v, i) => view.setBigInt64(i * 8, BigInt(v), true));
  return new Message().varint(TENSOR_DIMS, values.length).varint(TENSOR_TYPE, INT64).string(TENSOR_NAME, name).bytes(TENSOR_RAW, raw);
}

function floatScalarInitializer(name, value) {
  const raw = new Uint8Array(4);
  new DataView(raw.buffer).setFloat32(0, value, true);
  return new Message().varint(TENSOR_TYPE, FLOAT).string(TENSOR_NAME, name).bytes(TENSOR_RAW, raw);
}

// A float32 initializer.
function floatInitializer(name, dims, data) {
  const m = new Message();
  for (const d of dims) m.varint(TENSOR_DIMS, d);
  m.varint(TENSOR_TYPE, FLOAT).string(TENSOR_NAME, name);
  return m.bytes(TENSOR_RAW, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

// An initializer's name, dims, element type and (for float32 stored in the
// model itself) its values; data is null for anything else.
function parseTensor(bytes) {
  const out = { name: "", dims: [], type: 0, data: null };
  let raw = null, floats = null, external = false;
  for (const f of readFields(bytes)) {
    if (f.no === TENSOR_NAME) out.name = text(f.value);
    else if (f.no === TENSOR_TYPE) out.type = f.value;
    else if (f.no === TENSOR_DIMS) {
      if (f.wire === 0) out.dims.push(f.value);
      else for (let p = 0; p < f.value.length;) { let v; [v, p] = readVarint(f.value, p); out.dims.push(v); }
    } else if (f.no === TENSOR_RAW) raw = f.value;
    else if (f.no === TENSOR_FLOAT && f.wire === 2) floats = f.value;
    else if (f.no === TENSOR_LOCATION && f.value === 1) external = true;
  }
  if (out.type !== FLOAT || external) return out;
  const count = out.dims.reduce((a, b) => a * b, 1);
  const bytesOf = raw || floats;
  if (!bytesOf || bytesOf.length !== count * 4) return out;
  out.data = new Float32Array(count);
  new Uint8Array(out.data.buffer).set(bytesOf);
  return out;
}

function floatInput(name, dims) {
  return tensorInput(name, FLOAT, dims);
}

// A graph input or output: name, element type, dims (numbers or names).
function tensorInput(name, elemType, dims) {
  const shape = new Message();
  for (const d of dims) {
    const dim = new Message();
    if (typeof d === "number") dim.varint(DIM_VALUE, d);
    else dim.string(DIM_PARAM, d);
    shape.message(SHAPE_DIM, dim);
  }
  const tensorType = new Message().varint(TT_ELEM, elemType).message(TT_SHAPE, shape);
  return new Message().string(VI_NAME, name).message(VI_TYPE, new Message().message(TYPE_TENSOR, tensorType));
}

function valueInfoName(bytes) {
  const f = readFields(bytes).find((x) => x.no === VI_NAME);
  return f ? text(f.value) : "";
}

// A node to add: its wire bytes and its inputs and outputs (for the cleanup).
function added(op, inputs, outputs, name, attrs, domain = "") {
  return { op, inputs, outputs, message: makeNode(op, inputs, outputs, name, attrs, domain) };
}

function isConstList(node, values) {
  if (!node || node.op !== "Constant") return false;
  const v = constantValue(node, true);
  return Array.isArray(v) && v.join(",") === values.join(",");
}

// The default-domain opset a model imports, or 0.
function onnxOpset(fields) {
  for (const f of fields) {
    if (f.no !== MODEL_OPSET) continue;
    const of = readFields(f.value);
    const domain = of.find((x) => x.no === OPSET_DOMAIN);
    const version = of.find((x) => x.no === OPSET_VERSION);
    if (!domain || text(domain.value) === "" || text(domain.value) === "ai.onnx") return version ? version.value : 0;
  }
  return 0;
}

export {
  readVarint, readFields, text, Message, parseNode, attribute, intAttr, floatAttr, intsAttr, signedVarint,
  constantValue, makeNode, int64Initializer, floatScalarInitializer, floatInitializer, parseTensor, floatInput, tensorInput,
  valueInfoName, added, isConstList, onnxOpset,
  MODEL_IR_VERSION, MODEL_OPSET, MODEL_GRAPH, GRAPH_NAME, OPSET_DOMAIN, OPSET_VERSION,
  GRAPH_NODE, GRAPH_INITIALIZER, GRAPH_INPUT, GRAPH_OUTPUT, GRAPH_VALUE_INFO,
  INT64, FLOAT,
};
