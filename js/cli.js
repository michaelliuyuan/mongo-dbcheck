"use strict";
// cli.js —— mongo-diff worker (M2)
// Node + 官方 mongodb 驱动, promoteValues:false 保类型精度 (architect 已定论)。
//
// M2 新增:
//   - ObjectId hex 范围分桶 (BigInt 精确插值)
//   - 集合级 + 桶级两级并发 (mapLimit 池)
//   - 游标批量读取 (batchSize)
//   - 断点续跑 (report/.checkpoints/<cname>.json)
//   - L6 下钻仅针对不一致桶
//   - TTL 集合 ttl_skip
//
// 用法: node cli.js --src URI --dst URI
//        [--level schema,index,count,hash,diff] [--buckets N]
//        [--parallel-colls P] [--parallel-buckets P] [--batch-size N]
//        [--missingAsNull] [--numericTolerance] [--resume] [--out dir]
const { MongoClient, ObjectId, Long } = require("mongodb");
const { canonical, canonicalHash, diffDocs, bucketHash, bsonTypeOf, makeBucketHasher, compareIds } = require("./canonical.js");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function arg(args, name, def) { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : def; }
function flag(args, name) { return args.includes(name); }

const argv = process.argv.slice(2);
const SRC = arg(argv, "--src", "");
const DST = arg(argv, "--dst", "");
const OUT = arg(argv, "--out", "./report");
const BUCKETS = parseInt(arg(argv, "--buckets", "64"), 10);
const PCOLL = parseInt(arg(argv, "--parallel-colls", "4"), 10);
const PBUCK = parseInt(arg(argv, "--parallel-buckets", "4"), 10);
const BATCH = parseInt(arg(argv, "--batch-size", "1000"), 10);
const RESUME = flag(argv, "--resume");
const ONLY = (arg(argv, "--only", "")).split(",").map(s => s.trim()).filter(Boolean);
const levels = (arg(argv, "--level", "schema,index,count,hash,diff")).split(",");
const opts = {
  missingAsNull: flag(argv, "--missingAsNull"),
  numericTolerance: flag(argv, "--numericTolerance"),
  maxDepth: 100,
};

if (!SRC || !DST) { console.error("usage: cli.js --src URI --dst URI [--level ...] [--out dir]"); process.exit(2); }
fs.mkdirSync(path.join(OUT, "diff"), { recursive: true });
fs.mkdirSync(path.join(OUT, ".checkpoints"), { recursive: true });

const CONN = { promoteValues: false, promoteLongs: false };

/* 简单并发池: 保持 limit 个并发任务 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const s = new MongoClient(SRC, CONN), t = new MongoClient(DST, CONN);
  await s.connect(); await t.connect();
  const summary = { startedAt: new Date().toISOString(), source: SRC, target: DST, collections: [], overall: "equal", ttlSkipped: [] };
  let rc = 0;

  await s.db("admin").command({ ping: 1 });
  await t.db("admin").command({ ping: 1 });

  const srcDbs = new Set();
  (await s.db("admin").admin().listDatabases()).databases.forEach(d => srcDbs.add(d.name));

  // 收集所有 (db, col) 任务
  const tasks = [];
  for (const db of srcDbs) {
    if (db === "admin" || db === "config" || db === "local") continue;
    const cols = await s.db(db).listCollections().toArray();
    for (const col of cols) {
      if (col.name.startsWith("system.")) continue;
      if (ONLY.length && !ONLY.includes(db + "." + col.name)) continue;
      tasks.push({ db, name: col.name });
    }
  }

  // 集合级并发
  const entries = await mapLimit(tasks, PCOLL, async ({ db, name }) => {
    const cname = db + "." + name;
    return compareCollection(s, t, db, name, cname);
  });

  // overall 三态: equal / diff / error (error 不入 diff 统计, 单独计数)
  summary.counts = { equal: 0, diff: 0, error: 0, ttlSkip: 0 };
  for (const entry of entries) {
    summary.collections.push(entry);
    if (entry.overall === "ttl_skip") { summary.ttlSkipped.push(entry.db + "." + entry.coll); summary.counts.ttlSkip++; continue; }
    if (entry.overall === "diff") { summary.counts.diff++; rc = 1; }
    else if (entry.overall === "error") { summary.counts.error++; if (rc === 0) rc = 2; }
    else summary.counts.equal++;
  }
  if (summary.counts.diff > 0) summary.overall = "diff";
  else if (summary.counts.error > 0) summary.overall = "error";

  summary.finishedAt = new Date().toISOString();
  summary.exitCode = rc;
  summary.durationSec = Number(((Date.now() - Date.parse(summary.startedAt)) / 1000).toFixed(1));
  try { summary.peakRssMB = Math.round(process.resourceUsage().maxRSS / 1024); } catch (e) { summary.peakRssMB = Math.round(process.memoryUsage().rss / 1048576); }
  summary.stats = { buckets: BUCKETS, parallelColls: PCOLL, parallelBuckets: PBUCK, batchSize: BATCH, resume: RESUME, only: ONLY };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  await s.close(); await t.close();
  process.exit(rc);
}

async function compareCollection(s, t, db, name, cname) {
  const entry = { db, coll: name, levels, overall: "equal", checks: {} };
  const sc = s.db(db).collection(name), tc = t.db(db).collection(name);
  const cpFile = path.join(OUT, ".checkpoints", cname.replace(/\./g, "__") + ".json");
  const cp = RESUME && fs.existsSync(cpFile) ? JSON.parse(fs.readFileSync(cpFile, "utf8")) : { buckets: {}, done: false };

  try {
    const tHas = await t.db(db).listCollections({ name }).hasNext();
    if (!tHas) { entry.overall = "diff"; entry.checks.schema = { diff: ["missing-in-target"] }; return entry; }

    // TTL 探测: 有 expireAfterSeconds 索引 => ttl_skip (仅结构比对)
    const idxArr = await sc.indexes();
    const hasTTL = idxArr.some(i => i.expireAfterSeconds != null);
    entry.ttl = hasTTL;

    if (levels.includes("index")) {
      const si = idxArr.map(normIdx);
      const ti = (await tc.indexes()).map(normIdx);
      const d = diffArr(si, ti);
      entry.checks.index = d.length ? { diff: d } : { ok: true };
      if (d.length && entry.overall === "equal") entry.overall = "diff";
    }

    if (hasTTL) {
      // TTL 集合不做 count/hash/diff 全量比对
      entry.overall = "ttl_skip";
      entry.checks.skipped = "ttl";
      return entry;
    }

    if (levels.includes("count")) {
      const scv = Number(await sc.countDocuments({})); const tcv = Number(await tc.countDocuments({}));
      entry.checks.count = { src: scv, dst: tcv, ok: scv === tcv };
      if (scv !== tcv) entry.overall = "diff";
    }

    let hashResult = null;
    if (levels.includes("hash") || levels.includes("diff")) {
      hashResult = await runHash(s, t, db, name, cname, cp);
      entry.checks.hash = hashResult.buckets;
      if (hashResult.buckets.some(b => b.match === false)) entry.overall = "diff";
    }

    if (levels.includes("diff")) {
      const diffBuckets = (hashResult ? hashResult.buckets : []).filter(b => b.match === false);
      // L6 仅对不一致桶下钻
      const deltas = await runDiff(s, t, db, name, cname, diffBuckets);
      if (deltas.length) { entry.overall = entry.overall === "ttl_skip" ? "ttl_skip" : "diff"; entry.checks.diff = { count: deltas.length }; }
      fs.writeFileSync(path.join(OUT, "diff", cname.replace(/\./g, "__") + ".ndjson"),
        deltas.map(d => JSON.stringify(d)).join("\n"));
    }

    // 全桶完成, 写 checkpoint 并标记 done
    cp.done = true;
    fs.writeFileSync(cpFile, JSON.stringify(cp, null, 2));
  } catch (e) {
    entry.overall = "error"; entry.checks.error = e.message;
  }
  return entry;
}

/* ---------------- 分桶 + 桶级并发哈希 (流式, O(1) 文档内存) ---------------- */
async function hashSide(col, query, opts) {
  const hh = makeBucketHasher(opts);
  await col.find(query).sort({ _id: 1 }).batchSize(BATCH).forEach(d => hh.update(d));
  return hh.digest(); // { count, hash }
}

async function runHash(s, t, db, name, cname, cp) {
  const sc = s.db(db).collection(name), tc = t.db(db).collection(name);
  const ag = await sc.aggregate([{ $group: { _id: null, min: { $min: "$_id" }, max: { $max: "$_id" }, n: { $sum: 1 } } }]).toArray();
  if (!ag.length || ag[0].n === 0) { cp.done = true; return { buckets: [] }; }
  const { min, max } = ag[0];

  const plan = planBuckets(min, max, BUCKETS);  // [{i, query, lo, hi}]
  const results = await mapLimit(plan, PBUCK, async (b) => {
    // 断点续跑: 复用已完桶结果, 但 query 一律取本次重新生成的桶计划
    // (checkpoint 里不保存 BSON 边界对象, 反序列化会失真; P1 重复计数修复)
    if (cp.buckets && cp.buckets[b.i]) return Object.assign({ query: b.query }, cp.buckets[b.i]);
    const src = await hashSide(sc, b.query, opts);
    const dst = await hashSide(tc, b.query, opts);
    const r = { bucket: b.i, match: src.hash === dst.hash && src.count === dst.count, srcCount: src.count, dstCount: dst.count, srcHash: src.hash, dstHash: dst.hash };
    cp.buckets[b.i] = r;
    fs.writeFileSync(path.join(OUT, ".checkpoints", cname.replace(/\./g, "__") + ".json"), JSON.stringify(cp, null, 2));
    return Object.assign({ query: b.query }, r);
  });
  return { buckets: results };
}

/* ---------------- 分桶规划 (数值/日期/ObjectId, 开放两端收边界外数据) ---------------- */
function planBuckets(min, max, N) {
  const t = bsonTypeOf(min);
  let bounds = null;  // 边界数组 [b0..bN], 内部边界 b[1..N-1]
  if (N < 2 || t == null) return singleBucketPlan();

  if (t === "ObjectId") bounds = oidBounds(min, max, N);
  else if (t === "Date") bounds = linearBounds(min.getTime(), max.getTime(), N, v => new Date(v));
  else if (t === "Int32" || t === "Long") {
    bounds = linearBoundsBig(BigInt(min.toString()), BigInt(max.toString()), N, v => toIntBound(min, v));
  } else if (t === "Double") {
    bounds = linearBounds(toNum(min), toNum(max), N, v => v);
  }

  if (!bounds || bounds.length < 2) return singleBucketPlan();

  const plan = [];
  for (let i = 0; i < N; i++) {
    let query;
    if (N === 1) query = {};
    else if (i === 0) query = { _id: { $lt: bounds[1] } };
    else if (i === N - 1) query = { _id: { $gte: bounds[N - 1] } };
    else query = { _id: { $gte: bounds[i], $lt: bounds[i + 1] } };
    plan.push({ i, query, lo: bounds[i], hi: bounds[i + 1] });
  }
  return plan;
}

function singleBucketPlan() { return [{ i: 0, query: {}, lo: null, hi: null }]; }

function oidBounds(min, max, N) {
  const lo = BigInt("0x" + min.toHexString());
  const hi = BigInt("0x" + max.toHexString());
  if (hi <= lo) return null;
  const out = [];
  for (let i = 0; i <= N; i++) {
    const v = lo + (hi - lo) * BigInt(i) / BigInt(N);
    out.push(new ObjectId(v.toString(16).padStart(24, "0")));
  }
  return out;
}
function linearBounds(lo, hi, N, map) {
  if (!(hi > lo)) return null;
  const out = [];
  for (let i = 0; i <= N; i++) out.push(map(lo + ((hi - lo) * i) / N));
  return out;
}
function linearBoundsBig(lo, hi, N, map) {
  if (hi <= lo) return null;
  const out = [];
  for (let i = 0; i <= N; i++) out.push(map(lo + (hi - lo) * BigInt(i) / BigInt(N)));
  return out;
}
function toIntBound(min, bigv) {
  return min._bsontype === "Long" ? Long.fromString(bigv.toString()) : Number(bigv);
}
function toNum(x) { return typeof x === "number" ? x : x.value; }

/* ---------------- L6 逐条 diff (下钻到不一致桶; 归并连接, O(1) 内存) ---------------- */
async function runDiff(s, t, db, name, cname, diffBuckets) {
  const sc = s.db(db).collection(name), tc = t.db(db).collection(name);
  const deltas = [];
  for (const b of diffBuckets) {
    const q = b.query || {};
    // 预取首对文档判断 _id 类型; 复合 _id (Object/Array/Regex) 走 Map 兜底
    const probe = await sc.find(q).sort({ _id: 1 }).limit(1).toArray();
    const exotic = probe.length && compareIds(probe[0]._id, probe[0]._id) === null;
    if (exotic) { await diffBucketMap(sc, tc, q, deltas); continue; }
    await diffBucketMerge(sc, tc, q, deltas);
  }
  return deltas;
}

async function* iterSorted(col, q) {
  yield* col.find(q).sort({ _id: 1 }).batchSize(BATCH);
}

async function diffBucketMerge(sc, tc, q, deltas) {
  // 双游标按 _id BSON 序归并; _id canonical 不同但 BSON 相等 (如 int vs double 同值)
  // 按口径视为两个不同文档, 互报 missing 并同步前进
  const itA = iterSorted(sc, q), itB = iterSorted(tc, q);
  let a = await itA.next(), b = await itB.next();
  while (!a.done && !b.done) {
    const c = compareIds(a.value._id, b.value._id);
    if (c === 0) {
      const ka = canonical(a.value._id, opts), kb = canonical(b.value._id, opts);
      if (ka === kb) {
        const r = diffDocs(a.value, b.value, opts);
        if (!r.equal) deltas.push({ _id: a.value._id, type: "modified", fields: r.deltas });
      } else {
        deltas.push({ _id: a.value._id, type: "missing-in-target" });
        deltas.push({ _id: b.value._id, type: "missing-in-source" });
      }
      a = await itA.next(); b = await itB.next();
    } else if (c < 0) {
      deltas.push({ _id: a.value._id, type: "missing-in-target" });
      a = await itA.next();
    } else {
      deltas.push({ _id: b.value._id, type: "missing-in-source" });
      b = await itB.next();
    }
  }
  for (; !a.done; a = await itA.next()) deltas.push({ _id: a.value._id, type: "missing-in-target" });
  for (; !b.done; b = await itB.next()) deltas.push({ _id: b.value._id, type: "missing-in-source" });
}

async function diffBucketMap(sc, tc, q, deltas) {
  // 复合 _id 兜底: 桶内全量 Map 连接 (仅不一致桶且异型 _id 时触发)
  const m = new Map();
  await sc.find(q).sort({ _id: 1 }).batchSize(BATCH).forEach(d => m.set(canonical(d._id, opts), d));
  await tc.find(q).sort({ _id: 1 }).batchSize(BATCH).forEach(d => {
    const k = canonical(d._id, opts);
    if (!m.has(k)) { deltas.push({ _id: d._id, type: "missing-in-source" }); return; }
    const r = diffDocs(m.get(k), d, opts);
    if (!r.equal) deltas.push({ _id: d._id, type: "modified", fields: r.deltas });
    m.delete(k);
  });
  for (const [, d] of m) deltas.push({ _id: d._id, type: "missing-in-target" });
}

function normIdx(ix) {
  const { v, ns, ...rest } = ix;
  return JSON.stringify(rest, Object.keys(rest).sort());
}
function diffArr(a, b) {
  const sa = new Set(a), sb = new Set(b), out = [];
  a.forEach(x => { if (!sb.has(x)) out.push("missing-in-target: " + x); });
  b.forEach(x => { if (!sa.has(x)) out.push("missing-in-source: " + x); });
  return out;
}

main().catch(e => { console.error("FATAL", e.stack); process.exit(2); });