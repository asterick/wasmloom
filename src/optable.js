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
// select is type-polymorphic (one opcode); the veneer layer types it per
// namespace, and reference arms switch to the typed encoding (0x1C) at emit.
// Params/results here are placeholders.
op("select", "select", 0x1b, ["t", "t", "i32"], ["t"], { select: true });

// --- references ---
op("ref", "is_null", 0xd1, ["ref"], ["i32"]);

// --- tables (immediate encoding via `imm`) ---
op("table", "get", 0x25, ["i32"], ["ref"], { imm: "table" });
op("table", "set", 0x26, ["i32", "ref"], [], { imm: "table" });
op("table", "init", [0xfc, 12], ["i32", "i32", "i32"], [], { imm: "elem+table" });
op("elem", "drop", [0xfc, 13], [], [], { imm: "elem" });
op("table", "copy", [0xfc, 14], ["i32", "i32", "i32"], [], { imm: "table+table" });
op("table", "grow", [0xfc, 15], ["ref", "i32"], ["i32"], { imm: "table" });
op("table", "size", [0xfc, 16], [], ["i32"], { imm: "table" });
op("table", "fill", [0xfc, 17], ["i32", "ref", "i32"], [], { imm: "table" });

// --- bulk memory / data segments (immediate encoding via `imm`) ---
op("memory", "size", 0x3f, [], ["i32"], { imm: "mem" });
op("memory", "grow", 0x40, ["i32"], ["i32"], { imm: "mem" });
op("memory", "init", [0xfc, 0x08], ["i32", "i32", "i32"], [], { imm: "data+mem" });
op("data", "drop", [0xfc, 0x09], [], [], { imm: "data" });
op("memory", "copy", [0xfc, 0x0a], ["i32", "i32", "i32"], [], { imm: "mem+mem" });
op("memory", "fill", [0xfc, 0x0b], ["i32", "i32", "i32"], [], { imm: "mem" });

// --- SIMD (0xFD prefix; sub-opcode is LEB128) ---

function simd(ns, name, subop, params, results, extra) {
  const bytes = subop < 0x80 ? [subop] : [(subop & 0x7f) | 0x80, subop >> 7];
  op(ns, name, [0xfd, ...bytes], params, results, extra);
}

// loads/stores (lane variants carry a lane immediate after the memarg)
simd("v128", "load", 0, ["i32"], ["v128"], { mem: "load", size: 16 });
simd("v128", "load8x8_s", 1, ["i32"], ["v128"], { mem: "load", size: 8 });
simd("v128", "load8x8_u", 2, ["i32"], ["v128"], { mem: "load", size: 8 });
simd("v128", "load16x4_s", 3, ["i32"], ["v128"], { mem: "load", size: 8 });
simd("v128", "load16x4_u", 4, ["i32"], ["v128"], { mem: "load", size: 8 });
simd("v128", "load32x2_s", 5, ["i32"], ["v128"], { mem: "load", size: 8 });
simd("v128", "load32x2_u", 6, ["i32"], ["v128"], { mem: "load", size: 8 });
simd("v128", "load8_splat", 7, ["i32"], ["v128"], { mem: "load", size: 1 });
simd("v128", "load16_splat", 8, ["i32"], ["v128"], { mem: "load", size: 2 });
simd("v128", "load32_splat", 9, ["i32"], ["v128"], { mem: "load", size: 4 });
simd("v128", "load64_splat", 10, ["i32"], ["v128"], { mem: "load", size: 8 });
simd("v128", "store", 11, ["i32", "v128"], [], { mem: "store", size: 16 });
simd("v128", "load8_lane", 84, ["i32", "v128"], ["v128"], { mem: "load", size: 1, lane: 16 });
simd("v128", "load16_lane", 85, ["i32", "v128"], ["v128"], { mem: "load", size: 2, lane: 8 });
simd("v128", "load32_lane", 86, ["i32", "v128"], ["v128"], { mem: "load", size: 4, lane: 4 });
simd("v128", "load64_lane", 87, ["i32", "v128"], ["v128"], { mem: "load", size: 8, lane: 2 });
simd("v128", "store8_lane", 88, ["i32", "v128"], [], { mem: "store", size: 1, lane: 16 });
simd("v128", "store16_lane", 89, ["i32", "v128"], [], { mem: "store", size: 2, lane: 8 });
simd("v128", "store32_lane", 90, ["i32", "v128"], [], { mem: "store", size: 4, lane: 4 });
simd("v128", "store64_lane", 91, ["i32", "v128"], [], { mem: "store", size: 8, lane: 2 });
simd("v128", "load32_zero", 92, ["i32"], ["v128"], { mem: "load", size: 4 });
simd("v128", "load64_zero", 93, ["i32"], ["v128"], { mem: "load", size: 8 });

// shuffle/swizzle/splat
simd("i8x16", "shuffle", 13, ["v128", "v128"], ["v128"], { imm: "shuffle" });
simd("i8x16", "swizzle", 14, ["v128", "v128"], ["v128"]);
simd("i8x16", "splat", 15, ["i32"], ["v128"]);
simd("i16x8", "splat", 16, ["i32"], ["v128"]);
simd("i32x4", "splat", 17, ["i32"], ["v128"]);
simd("i64x2", "splat", 18, ["i64"], ["v128"]);
simd("f32x4", "splat", 19, ["f32"], ["v128"]);
simd("f64x2", "splat", 20, ["f64"], ["v128"]);

// lane access (laneidx immediate; `lane` is the valid count)
simd("i8x16", "extract_lane_s", 21, ["v128"], ["i32"], { lane: 16 });
simd("i8x16", "extract_lane_u", 22, ["v128"], ["i32"], { lane: 16 });
simd("i8x16", "replace_lane", 23, ["v128", "i32"], ["v128"], { lane: 16 });
simd("i16x8", "extract_lane_s", 24, ["v128"], ["i32"], { lane: 8 });
simd("i16x8", "extract_lane_u", 25, ["v128"], ["i32"], { lane: 8 });
simd("i16x8", "replace_lane", 26, ["v128", "i32"], ["v128"], { lane: 8 });
simd("i32x4", "extract_lane", 27, ["v128"], ["i32"], { lane: 4 });
simd("i32x4", "replace_lane", 28, ["v128", "i32"], ["v128"], { lane: 4 });
simd("i64x2", "extract_lane", 29, ["v128"], ["i64"], { lane: 2 });
simd("i64x2", "replace_lane", 30, ["v128", "i64"], ["v128"], { lane: 2 });
simd("f32x4", "extract_lane", 31, ["v128"], ["f32"], { lane: 4 });
simd("f32x4", "replace_lane", 32, ["v128", "f32"], ["v128"], { lane: 4 });
simd("f64x2", "extract_lane", 33, ["v128"], ["f64"], { lane: 2 });
simd("f64x2", "replace_lane", 34, ["v128", "f64"], ["v128"], { lane: 2 });

// comparisons (results are lane masks)
for (const [ns, base] of [["i8x16", 35], ["i16x8", 45], ["i32x4", 55]]) {
  const names = ["eq", "ne", "lt_s", "lt_u", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u"];
  names.forEach((n, i) => simd(ns, n, base + i, ["v128", "v128"], ["v128"]));
}
for (const [ns, base] of [["f32x4", 65], ["f64x2", 71]]) {
  ["eq", "ne", "lt", "gt", "le", "ge"].forEach((n, i) => simd(ns, n, base + i, ["v128", "v128"], ["v128"]));
}
["eq", "ne", "lt_s", "gt_s", "le_s", "ge_s"].forEach((n, i) =>
  simd("i64x2", n, 214 + i, ["v128", "v128"], ["v128"]));

// bitwise (lane-agnostic)
simd("v128", "not", 77, ["v128"], ["v128"]);
simd("v128", "and", 78, ["v128", "v128"], ["v128"]);
simd("v128", "andnot", 79, ["v128", "v128"], ["v128"]);
simd("v128", "or", 80, ["v128", "v128"], ["v128"]);
simd("v128", "xor", 81, ["v128", "v128"], ["v128"]);
simd("v128", "bitselect", 82, ["v128", "v128", "v128"], ["v128"]);
simd("v128", "any_true", 83, ["v128"], ["i32"]);

// integer lane arithmetic
function simdInt(ns, base) {
  // base points at <ns>.abs; fixed offsets follow the spec layout per shape
  simd(ns, "abs", base, ["v128"], ["v128"]);
  simd(ns, "neg", base + 1, ["v128"], ["v128"]);
  simd(ns, "all_true", base + 3, ["v128"], ["i32"]);
  simd(ns, "bitmask", base + 4, ["v128"], ["i32"]);
  simd(ns, "shl", base + 11, ["v128", "i32"], ["v128"]);
  simd(ns, "shr_s", base + 12, ["v128", "i32"], ["v128"]);
  simd(ns, "shr_u", base + 13, ["v128", "i32"], ["v128"]);
  simd(ns, "add", base + 14, ["v128", "v128"], ["v128"]);
  simd(ns, "sub", base + 17, ["v128", "v128"], ["v128"]);
}
simdInt("i8x16", 96);
simdInt("i16x8", 128);
simdInt("i32x4", 160);
simdInt("i64x2", 192);

// 8/16-lane saturating add/sub, min/max, avgr
for (const [ns, base] of [["i8x16", 96], ["i16x8", 128]]) {
  simd(ns, "add_sat_s", base + 15, ["v128", "v128"], ["v128"]);
  simd(ns, "add_sat_u", base + 16, ["v128", "v128"], ["v128"]);
  simd(ns, "sub_sat_s", base + 18, ["v128", "v128"], ["v128"]);
  simd(ns, "sub_sat_u", base + 19, ["v128", "v128"], ["v128"]);
  simd(ns, "min_s", base + 22, ["v128", "v128"], ["v128"]);
  simd(ns, "min_u", base + 23, ["v128", "v128"], ["v128"]);
  simd(ns, "max_s", base + 24, ["v128", "v128"], ["v128"]);
  simd(ns, "max_u", base + 25, ["v128", "v128"], ["v128"]);
  simd(ns, "avgr_u", base + 27, ["v128", "v128"], ["v128"]);
}
simd("i8x16", "popcnt", 98, ["v128"], ["v128"]);
simd("i16x8", "q15mulr_sat_s", 130, ["v128", "v128"], ["v128"]);
simd("i16x8", "mul", 149, ["v128", "v128"], ["v128"]);
simd("i32x4", "mul", 181, ["v128", "v128"], ["v128"]);
simd("i64x2", "mul", 213, ["v128", "v128"], ["v128"]);
simd("i32x4", "min_s", 182, ["v128", "v128"], ["v128"]);
simd("i32x4", "min_u", 183, ["v128", "v128"], ["v128"]);
simd("i32x4", "max_s", 184, ["v128", "v128"], ["v128"]);
simd("i32x4", "max_u", 185, ["v128", "v128"], ["v128"]);
simd("i32x4", "dot_i16x8_s", 186, ["v128", "v128"], ["v128"]);

// narrow / extend / extadd / extmul
simd("i8x16", "narrow_i16x8_s", 101, ["v128", "v128"], ["v128"]);
simd("i8x16", "narrow_i16x8_u", 102, ["v128", "v128"], ["v128"]);
simd("i16x8", "narrow_i32x4_s", 133, ["v128", "v128"], ["v128"]);
simd("i16x8", "narrow_i32x4_u", 134, ["v128", "v128"], ["v128"]);
simd("i16x8", "extadd_pairwise_i8x16_s", 124, ["v128"], ["v128"]);
simd("i16x8", "extadd_pairwise_i8x16_u", 125, ["v128"], ["v128"]);
simd("i32x4", "extadd_pairwise_i16x8_s", 126, ["v128"], ["v128"]);
simd("i32x4", "extadd_pairwise_i16x8_u", 127, ["v128"], ["v128"]);
for (const [ns, src, base] of [["i16x8", "i8x16", 135], ["i32x4", "i16x8", 167], ["i64x2", "i32x4", 199]]) {
  simd(ns, `extend_low_${src}_s`, base, ["v128"], ["v128"]);
  simd(ns, `extend_high_${src}_s`, base + 1, ["v128"], ["v128"]);
  simd(ns, `extend_low_${src}_u`, base + 2, ["v128"], ["v128"]);
  simd(ns, `extend_high_${src}_u`, base + 3, ["v128"], ["v128"]);
}
for (const [ns, src, base] of [["i16x8", "i8x16", 156], ["i32x4", "i16x8", 188], ["i64x2", "i32x4", 220]]) {
  simd(ns, `extmul_low_${src}_s`, base, ["v128", "v128"], ["v128"]);
  simd(ns, `extmul_high_${src}_s`, base + 1, ["v128", "v128"], ["v128"]);
  simd(ns, `extmul_low_${src}_u`, base + 2, ["v128", "v128"], ["v128"]);
  simd(ns, `extmul_high_${src}_u`, base + 3, ["v128", "v128"], ["v128"]);
}

// float lane arithmetic
for (const [ns, base] of [["f32x4", 224], ["f64x2", 236]]) {
  simd(ns, "abs", base, ["v128"], ["v128"]);
  simd(ns, "neg", base + 1, ["v128"], ["v128"]);
  simd(ns, "sqrt", base + 3, ["v128"], ["v128"]);
  simd(ns, "add", base + 4, ["v128", "v128"], ["v128"]);
  simd(ns, "sub", base + 5, ["v128", "v128"], ["v128"]);
  simd(ns, "mul", base + 6, ["v128", "v128"], ["v128"]);
  simd(ns, "div", base + 7, ["v128", "v128"], ["v128"]);
  simd(ns, "min", base + 8, ["v128", "v128"], ["v128"]);
  simd(ns, "max", base + 9, ["v128", "v128"], ["v128"]);
  simd(ns, "pmin", base + 10, ["v128", "v128"], ["v128"]);
  simd(ns, "pmax", base + 11, ["v128", "v128"], ["v128"]);
}
simd("f32x4", "ceil", 103, ["v128"], ["v128"]);
simd("f32x4", "floor", 104, ["v128"], ["v128"]);
simd("f32x4", "trunc", 105, ["v128"], ["v128"]);
simd("f32x4", "nearest", 106, ["v128"], ["v128"]);
simd("f64x2", "ceil", 116, ["v128"], ["v128"]);
simd("f64x2", "floor", 117, ["v128"], ["v128"]);
simd("f64x2", "trunc", 122, ["v128"], ["v128"]);
simd("f64x2", "nearest", 148, ["v128"], ["v128"]);

// vector conversions
simd("i32x4", "trunc_sat_f32x4_s", 248, ["v128"], ["v128"]);
simd("i32x4", "trunc_sat_f32x4_u", 249, ["v128"], ["v128"]);
simd("f32x4", "convert_i32x4_s", 250, ["v128"], ["v128"]);
simd("f32x4", "convert_i32x4_u", 251, ["v128"], ["v128"]);
simd("i32x4", "trunc_sat_f64x2_s_zero", 252, ["v128"], ["v128"]);
simd("i32x4", "trunc_sat_f64x2_u_zero", 253, ["v128"], ["v128"]);
simd("f64x2", "convert_low_i32x4_s", 254, ["v128"], ["v128"]);
simd("f64x2", "convert_low_i32x4_u", 255, ["v128"], ["v128"]);
simd("f32x4", "demote_f64x2_zero", 94, ["v128"], ["v128"]);
simd("f64x2", "promote_low_f32x4", 95, ["v128"], ["v128"]);

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
  call_indirect: 0x11,
  select_typed: 0x1c,
  ref_null: 0xd0,
  ref_func: 0xd2,
  local_get: 0x20,
  local_set: 0x21,
  global_get: 0x23,
  global_set: 0x24,
  i32_const: 0x41,
  i64_const: 0x42,
  f32_const: 0x43,
  f64_const: 0x44,
  v128_const: [0xfd, 12],
  blocktype_empty: 0x40,
  functype: 0x60,
};
