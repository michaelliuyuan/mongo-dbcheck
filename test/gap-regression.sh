#!/usr/bin/env bash
# test/gap-regression.sh —— 末桶边界 off-by-one 回归用例
# 背景: 曾因末桶 gte bounds[L-1] 造成 [bounds[N-1], max) 区间漏检。
# 构造: _id 数值 0..100, 4 桶 => 边界 [0,25,50,75,100], 危险区 = [75,100)。
# 在 80 与 99 (危险区) + 10 (正常区, 对照) 埋 modified, 断言 3 条全部检出。
set -u
export PATH="$HOME/bin:${PATH:-/usr/bin:/bin}"
cd "$(dirname "$0")/.." || exit 2
JQ="${JQ:-$(command -v jq || echo "$HOME/bin/jq")}"

if [ -z "${MD_SRC_URI:-}" ] || [ -z "${MD_DST_URI:-}" ]; then
  echo "需要环境变量 MD_SRC_URI / MD_DST_URI（可写测试库的 mongo URI），不内置默认值避免凭证入库" >&2
  exit 2
fi
SRC="$MD_SRC_URI"
DST="$MD_DST_URI"
COLL="__gap_test"
OUT="${OUT:-/tmp/md-gap-reg}"

cleanup() {
  mongosh "$SRC" --quiet --eval "db.getSiblingDB('md_data').getCollection('$COLL').drop()" >/dev/null 2>&1
  mongosh "$DST" --quiet --eval "db.getSiblingDB('md_data').getCollection('$COLL').drop()" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup

seed() {
  local uri="$1" m10="$2" m80="$3" m99="$4"
  mongosh "$uri" --quiet --eval "
    const c = db.getSiblingDB('md_data').getCollection('$COLL');
    c.insertMany([
      {_id: 0,  v: 'base'}, {_id: 10, v: '$m10'}, {_id: 30, v: 'base'},
      {_id: 60, v: 'base'}, {_id: 80, v: '$m80'}, {_id: 99, v: '$m99'}, {_id: 100, v: 'base'}
    ]);"
}
seed "$SRC" "x" "gap" "gap"        # src: 基准
seed "$DST" "X-MOD" "GAP-MOD" "GAP2"   # dst: 对照(10) + 危险区(80,99) 均被改

rm -rf "$OUT"
bin/mongo-dbcheck.sh --src "$SRC" --dst "$DST" --only "md_data.$COLL" \
  --buckets 4 --parallel-colls 1 --out "$OUT" >/dev/null 2>&1
rc=$?
nd=$(ls "$OUT"/diff/*.ndjson 2>/dev/null | head -1)
n=$(grep -c . "$nd" 2>/dev/null || echo 0)
ids=$("$JQ" -r 'select(.type=="modified") | ._id."$numberInt"' "$nd" 2>/dev/null | sort | tr '\n' ',')

echo "rc=$rc deltas=$n modified_ids=$ids"
if [ "$rc" = "1" ] && [ "$n" = "3" ] && [ "$ids" = "10,80,99," ]; then
  echo "PASS: gap-zone modified docs (80,99) + control (10) all detected"
  exit 0
else
  echo "FAIL: expected rc=1 deltas=3 modified=10,80,99 (末桶区间漏检回归?)"
  exit 1
fi
