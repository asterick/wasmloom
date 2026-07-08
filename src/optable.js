/**
 * Data-driven instruction table. One entry per instruction; expr.js generates
 * the public constructors from this, and the encoder uses `op` bytes directly.
 *
 * Entry: { ns, name, op: number[], params: string[], results: string[], mem?: 'load'|'store', size?: bytes }
 * Type strings are resolved to ValType singletons by expr.js.
 */

const table = [];

function op(ns, name, code, params, results, extra) {
  table.push({ ns, name, op: Array.isArray(code) ? code : [code], params, results, ...extra });
}

// --- i32 comparisons ---
op("i32", "eqz", 0x45, ["i32"], ["i32"]);
op("i32", "eq", 0x46, ["i32", "i32"], ["i32"]);
op("i32", "ne", 0x47, ["i32", "i32"], ["i32"]);
op("i32", "lt_s", 0x48, ["i32", "i32"], ["i32"]);
op("i32", "lt_u", 0x49, ["i32", "i32"], ["i32"]);
op("i32", "gt_s", 0x4a, ["i32", "i32"], ["i32"]);
op("i32", "gt_u", 0x4b, ["i32", "i32"], ["i32"]);
op("i32", "le_s", 0x4c, ["i32", "i32"], ["i32"]);
op("i32", "le_u", 0x4d, ["i32", "i32"], ["i32"]);
op("i32", "ge_s", 0x4e, ["i32", "i32"], ["i32"]);
op("i32", "ge_u", 0x4f, ["i32", "i32"], ["i32"]);

// --- i64 comparisons (results are i32) ---
op("i64", "eqz", 0x50, ["i64"], ["i32"]);
op("i64", "eq", 0x51, ["i64", "i64"], ["i32"]);
op("i64", "ne", 0x52, ["i64", "i64"], ["i32"]);
op("i64", "lt_s", 0x53, ["i64", "i64"], ["i32"]);
op("i64", "lt_u", 0x54, ["i64", "i64"], ["i32"]);
op("i64", "gt_s", 0x55, ["i64", "i64"], ["i32"]);
op("i64", "gt_u", 0x56, ["i64", "i64"], ["i32"]);
op("i64", "le_s", 0x57, ["i64", "i64"], ["i32"]);
op("i64", "le_u", 0x58, ["i64", "i64"], ["i32"]);
op("i64", "ge_s", 0x59, ["i64", "i64"], ["i32"]);
op("i64", "ge_u", 0x5a, ["i64", "i64"], ["i32"]);

// --- f32 comparisons ---
op("f32", "eq", 0x5b, ["f32", "f32"], ["i32"]);
op("f32", "ne", 0x5c, ["f32", "f32"], ["i32"]);
op("f32", "lt", 0x5d, ["f32", "f32"], ["i32"]);
op("f32", "gt", 0x5e, ["f32", "f32"], ["i32"]);
op("f32", "le", 0x5f, ["f32", "f32"], ["i32"]);
op("f32", "ge", 0x60, ["f32", "f32"], ["i32"]);

// --- f64 comparisons ---
op("f64", "eq", 0x61, ["f64", "f64"], ["i32"]);
op("f64", "ne", 0x62, ["f64", "f64"], ["i32"]);
op("f64", "lt", 0x63, ["f64", "f64"], ["i32"]);
op("f64", "gt", 0x64, ["f64", "f64"], ["i32"]);
op("f64", "le", 0x65, ["f64", "f64"], ["i32"]);
op("f64", "ge", 0x66, ["f64", "f64"], ["i32"]);

// --- i32 arithmetic ---
op("i32", "clz", 0x67, ["i32"], ["i32"]);
op("i32", "ctz", 0x68, ["i32"], ["i32"]);
op("i32", "popcnt", 0x69, ["i32"], ["i32"]);
op("i32", "add", 0x6a, ["i32", "i32"], ["i32"]);
op("i32", "sub", 0x6b, ["i32", "i32"], ["i32"]);
op("i32", "mul", 0x6c, ["i32", "i32"], ["i32"]);
op("i32", "div_s", 0x6d, ["i32", "i32"], ["i32"]);
op("i32", "div_u", 0x6e, ["i32", "i32"], ["i32"]);
op("i32", "rem_s", 0x6f, ["i32", "i32"], ["i32"]);
op("i32", "rem_u", 0x70, ["i32", "i32"], ["i32"]);
op("i32", "and", 0x71, ["i32", "i32"], ["i32"]);
op("i32", "or", 0x72, ["i32", "i32"], ["i32"]);
op("i32", "xor", 0x73, ["i32", "i32"], ["i32"]);
op("i32", "shl", 0x74, ["i32", "i32"], ["i32"]);
op("i32", "shr_s", 0x75, ["i32", "i32"], ["i32"]);
op("i32", "shr_u", 0x76, ["i32", "i32"], ["i32"]);
op("i32", "rotl", 0x77, ["i32", "i32"], ["i32"]);
op("i32", "rotr", 0x78, ["i32", "i32"], ["i32"]);

// --- i64 arithmetic ---
op("i64", "clz", 0x79, ["i64"], ["i64"]);
op("i64", "ctz", 0x7a, ["i64"], ["i64"]);
op("i64", "popcnt", 0x7b, ["i64"], ["i64"]);
op("i64", "add", 0x7c, ["i64", "i64"], ["i64"]);
op("i64", "sub", 0x7d, ["i64", "i64"], ["i64"]);
op("i64", "mul", 0x7e, ["i64", "i64"], ["i64"]);
op("i64", "div_s", 0x7f, ["i64", "i64"], ["i64"]);
op("i64", "div_u", 0x80, ["i64", "i64"], ["i64"]);
op("i64", "rem_s", 0x81, ["i64", "i64"], ["i64"]);
op("i64", "rem_u", 0x82, ["i64", "i64"], ["i64"]);
op("i64", "and", 0x83, ["i64", "i64"], ["i64"]);
op("i64", "or", 0x84, ["i64", "i64"], ["i64"]);
op("i64", "xor", 0x85, ["i64", "i64"], ["i64"]);
op("i64", "shl", 0x86, ["i64", "i64"], ["i64"]);
op("i64", "shr_s", 0x87, ["i64", "i64"], ["i64"]);
op("i64", "shr_u", 0x88, ["i64", "i64"], ["i64"]);
op("i64", "rotl", 0x89, ["i64", "i64"], ["i64"]);
op("i64", "rotr", 0x8a, ["i64", "i64"], ["i64"]);

// --- f32 arithmetic ---
op("f32", "abs", 0x8b, ["f32"], ["f32"]);
op("f32", "neg", 0x8c, ["f32"], ["f32"]);
op("f32", "ceil", 0x8d, ["f32"], ["f32"]);
op("f32", "floor", 0x8e, ["f32"], ["f32"]);
op("f32", "trunc", 0x8f, ["f32"], ["f32"]);
op("f32", "nearest", 0x90, ["f32"], ["f32"]);
op("f32", "sqrt", 0x91, ["f32"], ["f32"]);
op("f32", "add", 0x92, ["f32", "f32"], ["f32"]);
op("f32", "sub", 0x93, ["f32", "f32"], ["f32"]);
op("f32", "mul", 0x94, ["f32", "f32"], ["f32"]);
op("f32", "div", 0x95, ["f32", "f32"], ["f32"]);
op("f32", "min", 0x96, ["f32", "f32"], ["f32"]);
op("f32", "max", 0x97, ["f32", "f32"], ["f32"]);
op("f32", "copysign", 0x98, ["f32", "f32"], ["f32"]);

// --- f64 arithmetic ---
op("f64", "abs", 0x99, ["f64"], ["f64"]);
op("f64", "neg", 0x9a, ["f64"], ["f64"]);
op("f64", "ceil", 0x9b, ["f64"], ["f64"]);
op("f64", "floor", 0x9c, ["f64"], ["f64"]);
op("f64", "trunc", 0x9d, ["f64"], ["f64"]);
op("f64", "nearest", 0x9e, ["f64"], ["f64"]);
op("f64", "sqrt", 0x9f, ["f64"], ["f64"]);
op("f64", "add", 0xa0, ["f64", "f64"], ["f64"]);
op("f64", "sub", 0xa1, ["f64", "f64"], ["f64"]);
op("f64", "mul", 0xa2, ["f64", "f64"], ["f64"]);
op("f64", "div", 0xa3, ["f64", "f64"], ["f64"]);
op("f64", "min", 0xa4, ["f64", "f64"], ["f64"]);
op("f64", "max", 0xa5, ["f64", "f64"], ["f64"]);
op("f64", "copysign", 0xa6, ["f64", "f64"], ["f64"]);

// --- conversions ---
op("i32", "wrap_i64", 0xa7, ["i64"], ["i32"]);
op("i32", "trunc_f32_s", 0xa8, ["f32"], ["i32"]);
op("i32", "trunc_f32_u", 0xa9, ["f32"], ["i32"]);
op("i32", "trunc_f64_s", 0xaa, ["f64"], ["i32"]);
op("i32", "trunc_f64_u", 0xab, ["f64"], ["i32"]);
op("i64", "extend_i32_s", 0xac, ["i32"], ["i64"]);
op("i64", "extend_i32_u", 0xad, ["i32"], ["i64"]);
op("i64", "trunc_f32_s", 0xae, ["f32"], ["i64"]);
op("i64", "trunc_f32_u", 0xaf, ["f32"], ["i64"]);
op("i64", "trunc_f64_s", 0xb0, ["f64"], ["i64"]);
op("i64", "trunc_f64_u", 0xb1, ["f64"], ["i64"]);
op("f32", "convert_i32_s", 0xb2, ["i32"], ["f32"]);
op("f32", "convert_i32_u", 0xb3, ["i32"], ["f32"]);
op("f32", "convert_i64_s", 0xb4, ["i64"], ["f32"]);
op("f32", "convert_i64_u", 0xb5, ["i64"], ["f32"]);
op("f32", "demote_f64", 0xb6, ["f64"], ["f32"]);
op("f64", "convert_i32_s", 0xb7, ["i32"], ["f64"]);
op("f64", "convert_i32_u", 0xb8, ["i32"], ["f64"]);
op("f64", "convert_i64_s", 0xb9, ["i64"], ["f64"]);
op("f64", "convert_i64_u", 0xba, ["i64"], ["f64"]);
op("f64", "promote_f32", 0xbb, ["f32"], ["f64"]);
op("i32", "reinterpret_f32", 0xbc, ["f32"], ["i32"]);
op("i64", "reinterpret_f64", 0xbd, ["f64"], ["i64"]);
op("f32", "reinterpret_i32", 0xbe, ["i32"], ["f32"]);
op("f64", "reinterpret_i64", 0xbf, ["i64"], ["f64"]);

// --- sign extension ---
op("i32", "extend8_s", 0xc0, ["i32"], ["i32"]);
op("i32", "extend16_s", 0xc1, ["i32"], ["i32"]);
op("i64", "extend8_s", 0xc2, ["i64"], ["i64"]);
op("i64", "extend16_s", 0xc3, ["i64"], ["i64"]);
op("i64", "extend32_s", 0xc4, ["i64"], ["i64"]);

// --- non-trapping float-to-int (0xFC prefix) ---
op("i32", "trunc_sat_f32_s", [0xfc, 0x00], ["f32"], ["i32"]);
op("i32", "trunc_sat_f32_u", [0xfc, 0x01], ["f32"], ["i32"]);
op("i32", "trunc_sat_f64_s", [0xfc, 0x02], ["f64"], ["i32"]);
op("i32", "trunc_sat_f64_u", [0xfc, 0x03], ["f64"], ["i32"]);
op("i64", "trunc_sat_f32_s", [0xfc, 0x04], ["f32"], ["i64"]);
op("i64", "trunc_sat_f32_u", [0xfc, 0x05], ["f32"], ["i64"]);
op("i64", "trunc_sat_f64_s", [0xfc, 0x06], ["f64"], ["i64"]);
op("i64", "trunc_sat_f64_u", [0xfc, 0x07], ["f64"], ["i64"]);

// --- memory loads/stores ---
op("i32", "load", 0x28, ["i32"], ["i32"], { mem: "load", size: 4 });
op("i64", "load", 0x29, ["i32"], ["i64"], { mem: "load", size: 8 });
op("f32", "load", 0x2a, ["i32"], ["f32"], { mem: "load", size: 4 });
op("f64", "load", 0x2b, ["i32"], ["f64"], { mem: "load", size: 8 });
op("i32", "load8_s", 0x2c, ["i32"], ["i32"], { mem: "load", size: 1 });
op("i32", "load8_u", 0x2d, ["i32"], ["i32"], { mem: "load", size: 1 });
op("i32", "load16_s", 0x2e, ["i32"], ["i32"], { mem: "load", size: 2 });
op("i32", "load16_u", 0x2f, ["i32"], ["i32"], { mem: "load", size: 2 });
op("i64", "load8_s", 0x30, ["i32"], ["i64"], { mem: "load", size: 1 });
op("i64", "load8_u", 0x31, ["i32"], ["i64"], { mem: "load", size: 1 });
op("i64", "load16_s", 0x32, ["i32"], ["i64"], { mem: "load", size: 2 });
op("i64", "load16_u", 0x33, ["i32"], ["i64"], { mem: "load", size: 2 });
op("i64", "load32_s", 0x34, ["i32"], ["i64"], { mem: "load", size: 4 });
op("i64", "load32_u", 0x35, ["i32"], ["i64"], { mem: "load", size: 4 });
op("i32", "store", 0x36, ["i32", "i32"], [], { mem: "store", size: 4 });
op("i64", "store", 0x37, ["i32", "i64"], [], { mem: "store", size: 8 });
op("f32", "store", 0x38, ["i32", "f32"], [], { mem: "store", size: 4 });
op("f64", "store", 0x39, ["i32", "f64"], [], { mem: "store", size: 8 });
op("i32", "store8", 0x3a, ["i32", "i32"], [], { mem: "store", size: 1 });
op("i32", "store16", 0x3b, ["i32", "i32"], [], { mem: "store", size: 2 });
op("i64", "store8", 0x3c, ["i32", "i64"], [], { mem: "store", size: 1 });
op("i64", "store16", 0x3d, ["i32", "i64"], [], { mem: "store", size: 2 });
op("i64", "store32", 0x3e, ["i32", "i64"], [], { mem: "store", size: 4 });

// --- parametric ---
// select is type-polymorphic over the numeric types (one opcode); the veneer
// layer types it per namespace. Params/results here are placeholders.
op("select", "select", 0x1b, ["t", "t", "i32"], ["t"]);

// --- bulk memory / data segments (immediate encoding via `imm`) ---
op("memory", "size", 0x3f, [], ["i32"], { imm: "mem" });
op("memory", "grow", 0x40, ["i32"], ["i32"], { imm: "mem" });
op("memory", "init", [0xfc, 0x08], ["i32", "i32", "i32"], [], { imm: "data+mem" });
op("data", "drop", [0xfc, 0x09], [], [], { imm: "data" });
op("memory", "copy", [0xfc, 0x0a], ["i32", "i32", "i32"], [], { imm: "mem+mem" });
op("memory", "fill", [0xfc, 0x0b], ["i32", "i32", "i32"], [], { imm: "mem" });

export const OPTABLE = table;

/** Miscellaneous opcode bytes used directly by the encoder. */
export const OPS = {
  unreachable: 0x00,
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  br_if: 0x0d,
  br_table: 0x0e,
  return: 0x0f,
  call: 0x10,
  drop: 0x1a,
  local_get: 0x20,
  local_set: 0x21,
  global_get: 0x23,
  global_set: 0x24,
  i32_const: 0x41,
  i64_const: 0x42,
  f32_const: 0x43,
  f64_const: 0x44,
  blocktype_empty: 0x40,
  functype: 0x60,
};
