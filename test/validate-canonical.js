"use strict";
// 校验 canonical.js 对 md_data 双实例样本的正确性（对照 matrix.md v2 期望结论）
const { MongoClient } = require("mongodb");
const { canonical, canonicalHash, diffDocs, bsonTypeOf } = require("../js/canonical.js");

const SRC = process.env.MD_SRC_URI || "mongodb://127.0.0.1:27020/?directConnection=true";
const DST = process.env.MD_DST_URI || "mongodb://127.0.0.1:27021/?directConnection=true";
const OPTS = { promoteValues: false, promoteLongs: false };

let pass = 0, fail = 0;
const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log("PASS", name); }
  else { fail++; failures.push({ name, got, want }); console.log("FAIL", name, "got=", JSON.stringify(got), "want=", JSON.stringify(want)); }
}

(async () => {
  const c1 = new MongoClient(SRC, OPTS);
  const c2 = new MongoClient(DST, OPTS);
  await c1.connect(); await c2.connect();
  const src = c1.db("md_data");
  const dst = c2.db("md_data");

  // ---- eq.types：type-tag 覆盖，期望 src 每条 canonical 都带正确标签 ----
  const types = await src.collection("eq.types").find({}).toArray();
  const tmap = {}; types.forEach(d => tmap[d.k] = d.v);
  const T = {
    double: "d:1", int32: "c:1", int64: "g:1", decimal: "m:1.5", string: "s:1",
    oid: "i:000000000000000000000001", bool: "l:true", date: "D:0", null: "z:null",
    array: "a:[c:1,s:1,d:1]", object: "o:{a:o:{x:d:3,y:d:2},z:d:1}",
  };
  for (const k of Object.keys(T)) check("eq.types " + k, canonical(tmap[k]), T[k]);

  // regex / bindata / timestamp / minkey / maxkey 只做类型标签断言（串值单独校验）
  check("eq.types regex prefix", canonical(tmap.regex).startsWith("r:/"), true);
  check("eq.types bindata prefix", canonical(tmap.bindata).startsWith("b:0:"), true);
  check("eq.types timestamp", canonical(tmap.timestamp), "t:1:2");
  check("eq.types minkey", canonical(tmap.minkey), "n:MinKey");
  check("eq.types maxkey", canonical(tmap.maxkey), "x:MaxKey");

  // ---- eq.keyorder / eq.nest：键排序 equal ----
  const keySrc = await src.collection("eq.keyorder").find({}).toArray();
  const keyDst = await dst.collection("eq.keyorder").find({}).toArray();
  check("eq.keyorder equal", canonical(keySrc[0]) === canonical(keyDst[0]), true);
  const nestSrc = await src.collection("eq.nest").find({}).toArray();
  const nestDst = await dst.collection("eq.nest").find({}).toArray();
  check("eq.nest equal", canonical(nestSrc[0]) === canonical(nestDst[0]), true);

  // ---- diff.numtype：默认 diff；numericTolerance 打通 _id1/_id2 ----
  const numSrc = await src.collection("diff.numtype").find({}).sort({_id:1}).toArray();
  const numDst = await dst.collection("diff.numtype").find({}).sort({_id:1}).toArray();
  for (let i = 0; i < numSrc.length; i++) {
    check("numtype default diff _id" + numSrc[i]._id, canonical(numSrc[i].v) === canonical(numDst[i].v), false);
  }
  check("numtype tolerance _id1", canonical(numSrc[0].v, { numericTolerance: true }) === canonical(numDst[0].v, { numericTolerance: true }), true);
  check("numtype tolerance _id2", canonical(numSrc[1].v, { numericTolerance: true }) === canonical(numDst[1].v, { numericTolerance: true }), true);
  check("numtype tolerance _id3 stays diff", canonical(numSrc[2].v, { numericTolerance: true }) === canonical(numDst[2].v, { numericTolerance: true }), false);

  // ---- eq.float：NaN==NaN, -0==0, ±Inf, 0.1 ----
  const fSrc = await src.collection("eq.float").find({}).sort({_id:1}).toArray();
  const fDst = await dst.collection("eq.float").find({}).sort({_id:1}).toArray();
  for (let i = 0; i < fSrc.length; i++) {
    check("eq.float _id" + fSrc[i]._id, canonical(fSrc[i].v) === canonical(fDst[i].v), true);
  }

  // ---- diff.missing：默认 diff；missingAsNull 转 equal（除 undefined） ----
  const mSrc = await src.collection("diff.missing").find({}).sort({_id:1}).toArray();
  const mDst = await dst.collection("diff.missing").find({}).sort({_id:1}).toArray();
  // difference via diffDocs (default strict)
  check("missing _id1 default diff", diffDocs(mSrc[0], mDst[0]).equal, false);
  check("missing _id2 default diff", diffDocs(mSrc[1], mDst[1]).equal, false);
  check("missing _id3 default diff", diffDocs(mSrc[2], mDst[2]).equal, false);
  // missingAsNull 递归生效 (bug#4 口径): _id1/_id2/_id3 均 equal (v3 已移除 undefined 用例)
  check("missing _id1 asNull equal", diffDocs(mSrc[0], mDst[0], { missingAsNull: true }).equal, true);
  check("missing _id2 asNull equal", diffDocs(mSrc[1], mDst[1], { missingAsNull: true }).equal, true);
  check("missing _id3 asNull equal (recursive)", diffDocs(mSrc[2], mDst[2], { missingAsNull: true }).equal, true);

  // ---- eq.missing：两端一致 equal ----
  const emSrc = await src.collection("eq.missing").find({}).sort({_id:1}).toArray();
  const emDst = await dst.collection("eq.missing").find({}).sort({_id:1}).toArray();
  for (let i = 0; i < emSrc.length; i++) check("eq.missing _id" + emSrc[i]._id, canonical(emSrc[i]) === canonical(emDst[i]), true);

  // ---- diff.array：_id1 diff, _id2 diff, _id3 equal ----
  const aSrc = await src.collection("diff.array").find({}).sort({_id:1}).toArray();
  const aDst = await dst.collection("diff.array").find({}).sort({_id:1}).toArray();
  check("array _id1 diff", canonical(aSrc[0]) === canonical(aDst[0]), false);
  check("array _id2 diff", canonical(aSrc[1]) === canonical(aDst[1]), false);
  check("array _id3 equal", canonical(aSrc[2]) === canonical(aDst[2]), true);
  // v3 数组口径锁定: [int(1),null] vs [int(1)] 位置语义不归一, 默认与 missingAsNull 均判 diff
  check("array _id4 diff (default)", diffDocs(aSrc[3], aDst[3]).equal, false);
  check("array _id4 diff (asNull, positional)", diffDocs(aSrc[3], aDst[3], { missingAsNull: true }).equal, false);
  check("array _id4 leaf path v.1", JSON.stringify(diffDocs(aSrc[3], aDst[3]).deltas.map(d => d.key + ":" + d.type)), JSON.stringify(["v.1:missing-in-b"]));

  // ---- diff.oid：ObjectId vs string diff ----
  const o1 = await src.collection("diff.oid").findOne({});
  const o2 = await dst.collection("diff.oid").findOne({});
  check("oid typeTag", canonical(o1._id).startsWith("i:") && canonical(o2._id).startsWith("s:"), true);
  check("oid diff", canonical(o1) === canonical(o2), false);

  // ---- diff.big：blob 一致仅 note 不同，diff 点只在 note ----
  const b1 = await src.collection("diff.big").findOne({});
  const b2 = await dst.collection("diff.big").findOne({});
  const bigRes = diffDocs(b1, b2);
  check("big diff overall", bigRes.equal, false);
  check("big diff only note", JSON.stringify(bigRes.deltas.map(d => d.key)), JSON.stringify(["note"]));

  // ---- eq.ttl：确认 TTL 索引存在（供上层 skip/ttl 判定） ----
  const ttlIdx = await src.collection("eq.ttl").indexes();
  check("ttl index present", ttlIdx.some(i => i.expireAfterSeconds > 0), true);

  await c1.close(); await c2.close();
  console.log("\n==== RESULT: pass=" + pass + " fail=" + fail + " ====");
  if (fail) { console.log("FAILURES:"); failures.forEach(f => console.log(" -", f.name)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error("HARNESS ERR", e.stack); process.exit(2); });