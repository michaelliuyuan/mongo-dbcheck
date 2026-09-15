"use strict";

/*
 * canonical BSON 归一化实现 —— 依据 docs/canonical-bson-spec.md v1 + 团队接口约定。
 *
 * 接口（与团队最终确认一致）：
 *   canonical(x, opts?)     -> string   对单个 BSON 值/文档做确定性序列化，输出 "T:value" 串
 *   canonicalHash(x, opts?) -> string   sha256 hex of canonical(x, opts)
 *   diffDocs(a, b, opts?)   -> { equal, deltas[] }  带开关的文档级比较（缺失字段/数值容差在 diff 层生效）
 *
 * opts 全可选，默认：
 *   { missingAsNull: false, numericTolerance: false, maxDepth: 100, hashAlgo: "sha256" }
 *
 * 关键约束（实现前必读）：
 *  1. BSON int32 与 double 在 JS 里同为 "number"，驱动默认 promoteValues=true 会把两者都压成
 *     JS number，无法区分。必须用 plain node + mongodb 驱动，且以 promoteValues:false /
 *     promoteLongs:false 建立连接，让 int32->Int32 包装、int64->Long、double->Double 等类型
 *     全部保留 wrapper，才能做到「类型敏感」比较。mongosh 全局 JS 上下文无此能力。
 *  2. missingAsNull / numericTolerance 本质是 "diff 期" 语义（需要对另一个文档的字段集/数值做
 *     容差），canonical(x) 作为纯序列化器不感知它们；统一放在 diffDocs() 里实现。
 */

const crypto = require("crypto");

const DEFAULTS = Object.freeze({
  missingAsNull: false,
  numericTolerance: false,
  maxDepth: 100,
  hashAlgo: "sha256",
});

/* ------------------------------------------------------------------ */
/* 类型识别：以 promoteValues:false 载入的 BSON wrapper 为准             */
/* ------------------------------------------------------------------ */
function bsonTypeOf(x) {
  if (x == null) return x === null ? "Null" : "Undefined";
  const bt = x._bsontype;
  if (bt) return bt === "BSONRegExp" ? "Regex" : bt;  // Int32 Double Long Decimal128 ObjectId Binary Timestamp MinKey MaxKey Code DBRef BSONSymbol ...
  if (Array.isArray(x)) return "Array";
  if (x instanceof Date) return "Date";
  if (x instanceof RegExp) return "Regex";
  switch (typeof x) {
    case "string": return "String";
    case "boolean": return "Boolean";
    case "number": return "Double";   // 兜底：promote 后的裸 number 一律按 double 处理
    case "object": return "Object";
    default: return typeof x;
  }
}

/* ------------------------------------------------------------------ */
/* 数值类：统一转成「规范化十进制字符串」用于 numericTolerance            */
/* ------------------------------------------------------------------ */
function numericString(x) {
  const t = bsonTypeOf(x);
  if (t === "Double") {
    const v = typeof x === "number" ? x : x.value;
    if (Number.isNaN(v)) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    if (Object.is(v, -0)) return "0";
    return trimZeros(String(v));
  }
  if (t === "Int32") return String(typeof x === "number" ? x : x.value);
  if (t === "Long") return x.toString();
  if (t === "Decimal128") return trimZeros(x.toString());
  return "";
}

function trimZeros(s) {
  // 仅处理含小数点的十进制串：去除尾随零与多余小数点（1.50 -> 1.5, 1.00 -> 1）。
  // 特殊值 NaN/Infinity/-Infinity 原样返回。
  if (s === "NaN" || s === "Infinity" || s === "-Infinity") return s;
  if (s.indexOf(".") === -1 && s.indexOf("e") === -1 && s.indexOf("E") === -1) return s;
  const neg = s[0] === "-" ? "-" : "";
  const body = neg ? s.slice(1) : s;
  // 归一化：若为整数形态直接返回原串（无小数部分去尾逻辑）
  if (body.indexOf(".") !== -1) {
    let [i, f] = body.split(".");
    f = f.replace(/0+$/, "");
    return neg + (f.length ? i + "." + f : i);
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* 浮点 double 的 canonical（协议 §6）                                  */
/* ------------------------------------------------------------------ */
function doubleCanon(v) {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  if (Object.is(v, -0)) return "0";
  // 最短往返十进制串（JS String(double) 对每个不同 double 是单射且确定的）；
  // 等价于 spec 所述 Decimal128(String(v)).toString()，避免 $toString 跨版本漂移。
  return String(v);
}

/* ------------------------------------------------------------------ */
/* 文档键排序：UTF-8 字节序                                             */
/* ------------------------------------------------------------------ */
function sortedKeys(obj) {
  const k = Object.keys(obj);
  k.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  return k;
}

/* ------------------------------------------------------------------ */
/* 主序列化                                                            */
/* ------------------------------------------------------------------ */
function canonical(x, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  return serialize(x, o, 0);
}

function serialize(x, opts, depth) {
  if (depth > opts.maxDepth) return "u:undefined"; // 超深截断，计数交给上层

  const t = bsonTypeOf(x);
  switch (t) {
    case "Null": return "z:null";
    case "Undefined": return "u:undefined";
    case "Boolean": return "l:" + (x ? "true" : "false");
    case "String": return "s:" + escapeStr(x);
    case "Double": {
      const v = typeof x === "number" ? x : x.value;
      return (opts.numericTolerance) ? "n:" + numericString(x) : "d:" + doubleCanon(v);
    }
    case "Int32": {
      const v = typeof x === "number" ? x : x.value;
      return (opts.numericTolerance) ? "n:" + numericString(x) : "c:" + v;
    }
    case "Long": {
      return (opts.numericTolerance) ? "n:" + numericString(x) : "g:" + x.toString();
    }
    case "Decimal128": {
      return (opts.numericTolerance) ? "n:" + numericString(x) : "m:" + trimZeros(x.toString());
    }
    case "ObjectId": return "i:" + x.toHexString();
    case "Date": return "D:" + x.getTime();
    case "Regex": {
      const src = x.source || x.pattern;
      const raw = x.flags || x.options || "";
      const fl = String(raw).split("").sort().join("");
      return "r:/" + src + "/" + fl;
    }
    case "Binary": {
      const b64 = x.buffer ? x.buffer.toString("base64") : x.value ? x.value.toString("base64") : "";
      return "b:" + x.sub_type + ":" + b64;
    }
    case "Timestamp": return "t:" + x.high + ":" + x.low;
    case "MinKey": return "n:MinKey";
    case "MaxKey": return "x:MaxKey";
    case "Code": return "j:" + (x.code ? String(x.code) : "");
    case "DBRef": {
      const ns = x.namespace || "";
      const id = serialize(x.oid || x.oid, opts, depth + 1);
      return "p:" + ns + "\\0" + id;
    }
    case "BSONSymbol": return "y:" + escapeStr(String(x)); // deprecated
    case "Array": {
      // 有序语义，禁止排序（spec §3）
      const parts = x.map((el) => serialize(el, opts, depth + 1));
      return "a:[" + parts.join(",") + "]";
    }
    case "Object": {
      const keys = sortedKeys(x);
      // missingAsNull (bug#4 方案a): 显式 null 字段按缺失归一, 与 L6 diffDocs 语义同源,
      // 保证「L5 哈希判等 ⇔ L6 diff 判等」跨层一致。数组元素不归一(保序语义)。
      const parts = [];
      for (const k of keys) {
        if (opts.missingAsNull && x[k] === null) continue;
        parts.push(escapeStr(k) + ":" + serialize(x[k], opts, depth + 1));
      }
      return "o:{" + parts.join(",") + "}";
    }
    default: {
      // 未知类型兜底：给出稳定 hash 而非抛错
      let s;
      try { s = JSON.stringify(x); } catch (e) { s = String(x); }
      return "?:(" + t + "):" + encodeURIComponent(s || "");
    }
  }
}

function escapeStr(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\0/g, "\\u0000")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/:/g, "\\:");
}

function canonicalHash(x, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const algo = o.hashAlgo || "sha256";
  return crypto.createHash(algo).update(canonical(x, o), "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* 文档级 diff：缺失字段 + 数值容差在此生效                             */
/* ------------------------------------------------------------------ */
function diffDocs(a, b, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const deltas = [];

  // 叶子路径 diff: 点号连接嵌套字段, 数组用下标 (arr.2.c);
  // missingAsNull / numericTolerance 递归生效于任意深度;
  // 超 maxDepth 退化为整枝 canonical 比较并报该路径, 不抛错。
  walk(a, b, "", 0);
  return { equal: deltas.length === 0, deltas };

  function push(path, type) { deltas.push({ key: path, type }); }

  function handleMissing(presentVal, path, type) {
    // missingAsNull: 缺失按 null; 仅当存在侧确实为 null 时视为相等
    if (o.missingAsNull && presentVal === null) return;
    push(path, type);
  }

  function walk(va, vb, prefix, depth) {
    if (depth > o.maxDepth) {
      if (canonical(va, o) !== canonical(vb, o)) push(prefix || "<root>", "modified");
      return;
    }
    if (o.numericTolerance && isNumeric(va) && isNumeric(vb)) {
      if (numericString(va) !== numericString(vb)) push(prefix, "modified");
      return;
    }
    const ta = bsonTypeOf(va), tb = bsonTypeOf(vb);
    if (ta === "Object" && tb === "Object") { walkObj(va, vb, prefix, depth); return; }
    if (ta === "Array" && tb === "Array") { walkArr(va, vb, prefix, depth); return; }
    if (canonical(va, o) !== canonical(vb, o)) push(prefix, "modified");
  }

  function walkObj(a, b, prefix, depth) {
    const keys = new Set(Object.keys(a).concat(Object.keys(b)));
    const sorted = Array.from(keys).sort((x, y) =>
      Buffer.compare(Buffer.from(x, "utf8"), Buffer.from(y, "utf8")));
    for (const k of sorted) {
      const p = prefix ? prefix + "." + k : k;
      const inA = Object.prototype.hasOwnProperty.call(a, k);
      const inB = Object.prototype.hasOwnProperty.call(b, k);
      if (inA && inB) walk(a[k], b[k], p, depth + 1);
      else if (inA) handleMissing(a[k], p, "missing-in-b");
      else if (inB) handleMissing(b[k], p, "missing-in-a");
    }
  }

  function walkArr(a, b, prefix, depth) {
    // 数组下标是位置语义, 不做 missingAsNull 归一 (与 L5 哈希的数组处理保持同源)
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const p = prefix ? prefix + "." + i : String(i);
      if (i < a.length && i < b.length) walk(a[i], b[i], p, depth + 1);
      else if (i < a.length) push(p, "missing-in-b");
      else push(p, "missing-in-a");
    }
  }
}

function isNumeric(x) {
  const t = bsonTypeOf(x);
  return t === "Double" || t === "Int32" || t === "Long" || t === "Decimal128";
}

/* 桶哈希（L5 层调用）—— 两种等价实现:
 *  - makeBucketHasher(opts): 流式累加器, O(1) 文档内存。组合方式为每文档
 *    sha256(canonical(_id)+"\n"+canonical(doc)+"\n") 的 256-bit 模加和,
 *    次序无关、无两两抵消 ({a,a,b} 之和 ≠ {a,b,b} 之和), 配合桶级 count
 *    相等检查后与「排序拼接哈希」同真值 (multiset 相等 ⇔ 排序序列相等)。
 *  - bucketHash(rows, opts): 早期排序拼接实现, 保留作交叉校验/单测基准。
 */
const MASK256 = (1n << 256n) - 1n;

function docHash(d, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const algo = o.hashAlgo || "sha256";
  const h = crypto.createHash(algo);
  hashDocInto(h, d, o);
  return h.digest("hex");
}

/* 流式序列化进哈希: 不物化整篇 canonical 字符串, 大文档场景显著降低峰值内存
 * (输出字节与 canonical(_id)+"\n"+canonical(doc)+"\n" 完全一致) */
function hashDocInto(h, d, opts) {
  serializeTo(h, d._id, opts, 0);
  h.update("\n", "utf8");
  serializeTo(h, d, opts, 0);
  h.update("\n", "utf8");
}

function serializeTo(h, x, opts, depth) {
  if (depth > opts.maxDepth) { h.update("u:undefined", "utf8"); return; }
  const t = bsonTypeOf(x);
  switch (t) {
    case "Array": {
      h.update("a:[", "utf8");
      for (let i = 0; i < x.length; i++) {
        if (i) h.update(",", "utf8");
        serializeTo(h, x[i], opts, depth + 1);
      }
      h.update("]", "utf8");
      return;
    }
    case "Object": {
      h.update("o:{", "utf8");
      let first = true;
      for (const k of sortedKeys(x)) {
        if (opts.missingAsNull && x[k] === null) continue;
        if (!first) h.update(",", "utf8");
        first = false;
        h.update(escapeStr(k) + ":", "utf8");
        serializeTo(h, x[k], opts, depth + 1);
      }
      h.update("}", "utf8");
      return;
    }
    default: h.update(serialize(x, opts, depth), "utf8");
  }
}

function makeBucketHasher(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const algo = o.hashAlgo || "sha256";
  let sum = 0n, n = 0;
  return {
    update(doc) { sum = (sum + BigInt("0x" + docHash(doc, o))) & MASK256; n++; },
    digest() { return { count: n, hash: sum.toString(16).padStart(64, "0") }; },
  };
}

function bucketHash(rows, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const sorted = rows.slice().sort((a, b) =>
    canonical(a._id, opts) < canonical(b._id, opts) ? -1 : 1);
  const algo = o.hashAlgo || "sha256";
  const h = crypto.createHash(algo);
  for (const r of sorted) {
    h.update(canonical(r._id, opts), "utf8");
    h.update("\n");
    h.update(canonical(r, opts), "utf8");
    h.update("\n");
  }
  return h.digest("hex");
}

/* _id 的 BSON 跨类型全序比较器 (L6 归并连接用):
 * 返回 <0/0/>0; 无法精确比较的异构 _id (Object/Array 等) 返回 null, 上层走 Map 兜底。
 * 序: MinKey < Null < Undefined < 数值(混型按值) < String < Object < Array < Binary
 *     < ObjectId < Boolean < Date < Timestamp < Regex < MaxKey   (BSON 规范序)
 */
const BSON_RANK = {
  MinKey: 0, Null: 1, Undefined: 2, Double: 3, Int32: 3, Long: 3, Decimal128: 3,
  String: 4, Object: 5, Array: 6, Binary: 7, ObjectId: 8, Boolean: 9,
  Date: 10, Timestamp: 11, Regex: 12, MaxKey: 13,
};

function compareIds(a, b) {
  const ta = bsonTypeOf(a), tb = bsonTypeOf(b);
  const ra = BSON_RANK[ta], rb = BSON_RANK[tb];
  if (ra == null || rb == null) return null;         // 未知类型 → 兜底
  if (ra !== rb) return ra - rb;
  if (ra === 3) return compareNumeric(a, b);          // 数值混型按值比较
  if (ra === 4) return Buffer.compare(Buffer.from(String(a), "utf8"), Buffer.from(String(b), "utf8"));
  if (ra === 5 || ra === 6 || ra === 12) return null; // 复合/正则序过复杂 → 兜底
  if (ra === 7) return a.sub_type !== b.sub_type ? (a.sub_type - b.sub_type)
    : Buffer.compare(toBuf(a), toBuf(b));
  if (ra === 8) return Buffer.compare(Buffer.from(a.toHexString(), "hex"), Buffer.from(b.toHexString(), "hex"));
  if (ra === 9) return (a ? 1 : 0) - (b ? 1 : 0);
  if (ra === 10) return a.getTime() - b.getTime();
  if (ra === 11) {
    if (a.high !== b.high) return a.high < b.high ? -1 : 1;
    return a.low === b.low ? 0 : (a.low < b.low ? -1 : 1);
  }
  return 0; // MinKey/Null/Undefined/MaxKey 同秩即相等
}

function toBuf(x) { return x.buffer || x.value || Buffer.alloc(0); }

function compareNumeric(a, b) {
  const na = numRep(a), nb = numRep(b);
  if (na.big != null && nb.big != null) return na.big < nb.big ? -1 : na.big > nb.big ? 1 : 0;
  const x = na.num, y = nb.num;
  return x < y ? -1 : x > y ? 1 : 0;
}
/* 数值统一表示: 优先精确 BigInt (整型/整值 double), 否则 number */
function numRep(x) {
  const t = bsonTypeOf(x);
  if (t === "Int32") return { big: BigInt(typeof x === "number" ? x : x.value) };
  if (t === "Long") return { big: BigInt(x.toString()) };
  if (t === "Decimal128") {
    const s = x.toString();
    return /^-?\d+$/.test(s) ? { big: BigInt(s) } : { num: Number(s) };
  }
  const v = typeof x === "number" ? x : x.value;
  return Number.isInteger(v) && Math.abs(v) < Number.MAX_SAFE_INTEGER ? { big: BigInt(v) } : { num: v };
}

module.exports = {
  DEFAULTS,
  canonical,
  canonicalHash,
  diffDocs,
  bucketHash,
  makeBucketHasher,
  docHash,
  compareIds,
  bsonTypeOf,
  numericString,
};