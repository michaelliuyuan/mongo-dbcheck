"use strict";
const { canonical, canonicalHash, diffDocs, bucketHash, DEFAULTS } = require("../js/canonical.js");
const { Int32, Double, Long, Decimal128, ObjectId, Binary, Timestamp, MinKey, MaxKey, BSONRegExp } = require("mongodb");

function check(n, g, w) { const ok = JSON.stringify(g) === JSON.stringify(w); console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " got=" + JSON.stringify(g) + " want=" + JSON.stringify(w))); return ok; }
let pass = 0, fail = 0;
const C = (n, g, w) => { check(n, g, w) ? pass++ : fail++; };

const d1 = { a: new Int32(1), b: new Double(1) };
C("canonical(x) equals canonical(x,{})", canonical(d1) === canonical(d1, {}), true);
C("canonicalHash deterministic", canonicalHash(d1) === canonicalHash(d1), true);
C("opts undefined no-throw", (() => { try { canonical(d1, undefined); return true; } catch (e) { return e.message; } })(), true);

C("int32", canonical(new Int32(1)), "c:1");
C("double", canonical(new Double(1)), "d:1");
C("long", canonical(Long.fromString("1")), "g:1");
C("decimal 1.50", canonical(Decimal128.fromString("1.50")), "m:1.5");
C("decimal NaN", canonical(Decimal128.fromString("NaN")), "m:NaN");
C("double NaN", canonical(new Double(NaN)), "d:NaN");
C("double -0", canonical(new Double(-0)), "d:0");
C("double +Inf", canonical(new Double(Infinity)), "d:Infinity");
C("double 0.1", canonical(new Double(0.1)), "d:0.1");
C("oid", canonical(new ObjectId("000000000000000000000001")), "i:000000000000000000000001");
C("date", canonical(new Date(0)), "D:0");
C("regex sorted flags", canonical(new BSONRegExp("^a$", "mi")), "r:/^a$/im");
C("timestamp t1i2", canonical(new Timestamp({ t: 1, i: 2 })), "t:1:2");
C("minkey", canonical(new MinKey()), "n:MinKey");
C("maxkey", canonical(new MaxKey()), "x:MaxKey");
C("binary", canonical(new Binary(Buffer.from("hello"), 0)), "b:0:" + Buffer.from("hello").toString("base64"));

C("keyorder", canonical({ a: 1, b: { c: 2, d: 3 } }), canonical({ b: { d: 3, c: 2 }, a: 1 }));
C("array ordered diff", canonical({ v: [1, 2, 3] }) !== canonical({ v: [3, 2, 1] }), true);

C("missing vs null (canonical)", canonical({ a: 1 }) !== canonical({ a: 1, v: null }), true);
C("diffDocs missingAsNull a-side-null", diffDocs({ a: 1 }, { a: 1, v: null }, { missingAsNull: true }).equal, true);
C("diffDocs missingAsNull b-side-null", diffDocs({ v: null }, {}, { missingAsNull: true }).equal, true);
C("diffDocs strict missing diff", diffDocs({ a: 1 }, { a: 1, v: null }, { missingAsNull: false }).equal, false);

C("tolerance int32==long", canonical(new Int32(1), { numericTolerance: true }) === canonical(Long.fromString("1"), { numericTolerance: true }), true);
C("tolerance double==decimal 1", canonical(new Double(1), { numericTolerance: true }) === canonical(Decimal128.fromString("1.0"), { numericTolerance: true }), true);
C("tolerance 1.5 != 1", canonical(new Double(1.5), { numericTolerance: true }) !== canonical(Long.fromString("1"), { numericTolerance: true }), true);
C("strict int32!=long", canonical(new Int32(1)) !== canonical(Long.fromString("1")), true);

const rows = [{ _id: new Int32(2), v: 1 }, { _id: new Int32(1), v: 1 }];
C("bucketHash deterministic", bucketHash(rows) === bucketHash(rows), true);

console.log("\n==== pass=" + pass + " fail=" + fail + " ====");
process.exit(fail ? 1 : 0);