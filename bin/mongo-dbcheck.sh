#!/usr/bin/env bash
# mongo-dbcheck.sh —— 双 MongoDB 数据一致性校验 (shell 实现)
# 依赖: bash4+, jq, coreutils(sort/sha256sum/join/wc/xargs), mongosh
# 设计: mongosh EJSON strict 导出 (类型保真) -> jq 归一化 -> sort/sha256sum 桶哈希
#       -> join 归并叶子路径 diff; 与 js/ 参考实现同真值。
set -u

BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$BIN_DIR/../lib"
. "$LIB_DIR/common.sh"
. "$LIB_DIR/conn.sh"
. "$LIB_DIR/hash.sh"
. "$LIB_DIR/diff.sh"

WORKER=0
[ "${1:-}" = "--worker" ] && WORKER=1
if [ $WORKER = 0 ]; then
  md_getopt "$@"
  export MD_SRC MD_DST MD_OUT MD_LEVEL MD_BUCKETS MD_PCOLL MD_PBUCK MD_MAN MD_TOL MD_RESUME MD_ONLY
fi
JQ="$(md_jq)" || die "jq not found (PATH or ~/bin/jq)"
"$JQ" --version >/dev/null 2>&1 || die "jq not found (PATH or ~/bin/jq)"
command -v mongosh >/dev/null 2>&1 || die "mongosh not found"

mkdir -p "$MD_OUT/diff" "$MD_OUT/.checkpoints"
CKPT="$MD_OUT/.checkpoints"

EQUAL=0; DIFF=0; ERROR=0; TTLSKIP=0
OVERALL=equal
NDJSON=""

# ---- 收集任务 ----
TASKS=$(msh_collections "$MD_SRC" | while read -r db coll; do
  if [ -n "$MD_ONLY" ]; then
    case ",$MD_ONLY," in *",$db.$coll,"*) ;; *) continue ;; esac
  fi
  echo "$db $coll"
done)
[ -n "$TASKS" ] || die "no collections found on source"

# ---- 单集合比对 (子进程安全: 全部输出写文件) ----
# check_coll db coll -> 写 $MD_OUT/.coll/<db>__<coll>.json (条目 JSON, 无尾逗号)
check_coll() {
  local db="$1" coll="$2"
  local cname="${db}__${coll}"
  local cwd="$MD_OUT/.work/$cname"
  local res="$MD_OUT/.coll"
  mkdir -p "$cwd" "$res"
  local entry="{\"db\":\"$db\",\"coll\":\"$coll\""
  local overall=equal

  # schema: 目标缺集合
  if [ "$(msh_hascoll "$MD_DST" "$db" "$coll")" != "1" ]; then
    echo "{\"db\":\"$db\",\"coll\":\"$coll\",\"overall\":\"diff\",\"checks\":{\"schema\":{\"diff\":[\"missing-in-target\"]}}}" > "$res/$cname.json"
    return
  fi

  # index 层 + TTL 探测
  msh_indexes "$MD_SRC" "$db" "$coll" | LC_ALL=C sort > "$cwd/src.idx"
  msh_indexes "$MD_DST" "$db" "$coll" | LC_ALL=C sort > "$cwd/dst.idx"
  local idxdiff=""
  [ -n "$(comm -23 "$cwd/src.idx" "$cwd/dst.idx")" ] && idxdiff="missing-in-target"
  [ -n "$(comm -13 "$cwd/src.idx" "$cwd/dst.idx")" ] && idxdiff="${idxdiff:+$idxdiff,}missing-in-source"
  local ttl; ttl=$(msh_ttl "$MD_SRC" "$db" "$coll")
  if [ -n "$idxdiff" ]; then
    entry="$entry,\"checks\":{\"index\":{\"diff\":[\"$idxdiff\"]}}"
    overall=diff
  fi
  if [ "$ttl" = "1" ]; then
    echo "{\"db\":\"$db\",\"coll\":\"$coll\",\"overall\":\"ttl_skip\",\"ttl\":true,\"checks\":{\"skipped\":\"ttl\"}}" > "$res/$cname.json"
    return
  fi

  # count 层
  if has_level count; then
    local sc tc
    sc=$(msh_count "$MD_SRC" "$db" "$coll"); tc=$(msh_count "$MD_DST" "$db" "$coll")
    entry="$entry,\"count\":{\"src\":$sc,\"dst\":$tc,\"ok\":$([ "$sc" = "$tc" ] && echo true || echo false)}"
    [ "$sc" != "$tc" ] && overall=diff
  fi

  # L5/L6
  local ndjson="$MD_OUT/diff/$cname.ndjson"; : > "$ndjson"
  local bounds plan
  bounds=$(msh_plan "$MD_SRC" "$db" "$coll" "$MD_BUCKETS")
  [ "$bounds" = "[]" ] && bounds='["x","x"]'   # 空集合: 单空桶
  local nb; nb=$("$JQ" -n --argjson b "$bounds" 'if ($b|length) < 2 then 1 else ($b|length) - 1 end')

  # 桶哈希单任务 (供并行调用)
  hash_bucket_job() {
    local i="$1"
    local ckf="$CKPT/$cname.b$i"
    if [ "$MD_RESUME" = "1" ] && [ -s "$ckf" ]; then return 0; fi
    local q; q=$(bucket_query "$bounds" "$i" "$nb")
    hash_one_side "$MD_SRC" "$db" "$coll" "$q" "$cwd" "src$i" "$MD_MAN" "$MD_TOL" || exit 3
    hash_one_side "$MD_DST" "$db" "$coll" "$q" "$cwd" "dst$i" "$MD_MAN" "$MD_TOL" || exit 3
    local ds dh dd dh2
    read -r ds dh <<< "$(bucket_digest "$cwd" "src$i")"
    read -r dd dh2 <<< "$(bucket_digest "$cwd" "dst$i")"
    printf '%s %s\n%s %s\n' "$ds" "$dh" "$dd" "$dh2" > "$ckf"
    rm -f "$cwd/src$i.lines" "$cwd/dst$i.lines"   # 默认不留桶数据 (下钻再导)
  }

  # Pass1: 桶级并行哈希 (作业池, MD_PBUCK 并发)
  local j=0 i=0
  while [ "$i" -lt "$nb" ]; do
    hash_bucket_job "$i" &
    j=$((j + 1))
    if [ $((j % MD_PBUCK)) -eq 0 ]; then wait; fi
    i=$((i + 1))
  done
  wait

  # Pass2: 比对 + 不一致桶下钻 (串行, 保证 ndjson 追加有序)
  local mm=0 total=0
  i=0
  while [ "$i" -lt "$nb" ]; do
    local ckf="$CKPT/$cname.b$i"
    if [ ! -s "$ckf" ]; then
      echo "{\"db\":\"$db\",\"coll\":\"$coll\",\"overall\":\"error\",\"checks\":{\"error\":\"bucket $i hash failed\"}}" > "$res/$cname.json"
      return
    fi
    local scnt sh dc dh2
    read -r scnt sh < <(head -1 "$ckf")
    read -r dc dh2 < <(tail -1 "$ckf")
    total=$((total + 1))
    if [ "$scnt $sh" != "$dc $dh2" ]; then
      mm=$((mm + 1))
      local q; q=$(bucket_query "$bounds" "$i" "$nb")
      hash_one_side "$MD_SRC" "$db" "$coll" "$q" "$cwd" "srcX" "$MD_MAN" "$MD_TOL" || exit 3
      hash_one_side "$MD_DST" "$db" "$coll" "$q" "$cwd" "dstX" "$MD_MAN" "$MD_TOL" || exit 3
      diff_bucket "$cwd" srcX dstX "$ndjson"
      rm -f "$cwd/srcX.lines" "$cwd/dstX.lines"
    fi
    i=$((i + 1))
  done
  [ "$mm" -gt 0 ] && overall=diff
  local nd; nd=$(wc -l < "$ndjson" | tr -d ' ')
  [ "$nd" -gt 0 ] && overall=diff
  echo "{\"db\":\"$db\",\"coll\":\"$coll\",\"overall\":\"$overall\",\"checks\":{\"hash\":{\"buckets\":$total,\"mismatch\":$mm},\"diff\":{\"count\":$nd}}}" > "$res/$cname.json"
}
# ---- worker 入口 (须在 check_coll 定义之后; 配置经环境变量传入) ----
if [ $WORKER = 1 ]; then
  JQ="$(md_jq)" || exit 2
  check_coll "$2" "$3"
  exit 0
fi

# ---- 集合并发 (任务池; mongosh 在 Windows 下输出带 \r, 统一清洗) ----
TASKS_FILE="$MD_OUT/.tasks"
: > "$TASKS_FILE"
while read -r db coll; do
  db="${db%$'\r'}"; coll="${coll%$'\r'}"
  [ -n "$db" ] && [ -n "$coll" ] && echo "$db $coll" >> "$TASKS_FILE"
done <<< "$TASKS"
n=0
while read -r db coll <&3; do
  "$0" --worker "$db" "$coll" < /dev/null &
  n=$((n + 1))
  if [ $((n % MD_PCOLL)) -eq 0 ]; then wait; fi
done 3< "$TASKS_FILE"
wait

# worker 崩溃(如导出失败)未产出条目 -> 记 error, 不允许静默漏计
while read -r db coll <&3; do
  f="$MD_OUT/.coll/${db}__${coll}.json"
  [ -e "$f" ] || echo "{\"db\":\"$db\",\"coll\":\"$coll\",\"overall\":\"error\",\"checks\":{\"error\":\"worker failed (export/normalize)\"}}" > "$f"
done 3< "$TASKS_FILE"
rc=0

# ---- 汇总 ----
for f in "$MD_OUT"/.coll/*.json; do
  [ -e "$f" ] || continue
  ov=$("$JQ" -r .overall "$f")
  case "$ov" in
    equal) EQUAL=$((EQUAL+1)) ;;
    diff)  DIFF=$((DIFF+1)) ;;
    ttl_skip) TTLSKIP=$((TTLSKIP+1)) ;;
    *) ERROR=$((ERROR+1)) ;;
  esac
done
if   [ "$DIFF" -gt 0 ];   then OVERALL=diff;  rc=1
elif [ "$ERROR" -gt 0 ];  then OVERALL=error; rc=2
fi
{
  echo '{'
  echo "\"startedAt\":\"$(date -u +%FT%TZ)\",\"source\":\"$MD_SRC\",\"target\":\"$MD_DST\",\"overall\":\"$OVERALL\","
  echo "\"counts\":{\"equal\":$EQUAL,\"diff\":$DIFF,\"error\":$ERROR,\"ttlSkip\":$TTLSKIP},"
  echo "\"stats\":{\"buckets\":$MD_BUCKETS,\"parallelColls\":$MD_PCOLL,\"parallelBuckets\":$MD_PBUCK,\"resume\":$MD_RESUME,\"only\":\"$MD_ONLY\"},"
  echo '"collections":['
  first=1
  for f in "$MD_OUT"/.coll/*.json; do
    [ $first = 1 ] || echo ','
    first=0
    cat "$f"
  done
  echo ']}'
} > "$MD_OUT/summary.json"

rm -rf "$MD_OUT/.work" "$MD_OUT/.coll" "$MD_OUT/.tasks"
log "done: overall=$OVERALL equal=$EQUAL diff=$DIFF error=$ERROR ttlSkip=$TTLSKIP"
exit $rc
