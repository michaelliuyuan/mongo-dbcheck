#!/usr/bin/env bash
# hash.sh —— L5 分桶哈希: mongosh 导出 -> jq 归一化 -> sort -> sha256sum
# 桶结果: "<count> <sha256hex>" (与 JS 版同真值: count 相等 + multiset 相等)

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/canon.sh"

# hash_one_side URI db coll queryJSON workdir tag man tol
# 产出 workdir/tag.lines (key<TAB>canondoc, LC_ALL=C 排序); 导出失败则退出 3 (勿当空集合)
hash_one_side() {
  local uri="$1" db="$2" coll="$3" q="$4" wd="$5" tag="$6" man="$7" tol="$8"
  local jq; jq="$(md_jq)"
  # 每次调用独立 filter 文件 (桶级并发下共享文件有读写竞态)
  local nf="$wd/norm.$tag.jq"
  { norm_filter "$man" "$tol"; emit_line "$man" "$tol"; } > "$nf"
  if ! msh_export "$uri" "$db" "$coll" "$q" \
      | "$jq" -r -c -f "$nf" \
      | LC_ALL=C sort -t $'\t' -k1,1 > "$wd/$tag.lines"; then
    echo "FATAL: export/normalize failed: $db.$coll bucket=$tag" >&2
    exit 3
  fi
  rm -f "$nf"
}

# bucket_query boundsJson i N —— 组装第 i 桶的 query JSON
bucket_query() {
  local bounds="$1" i="$2" n="$3" jq; jq="$(md_jq)"
  "$jq" -n -r -c --argjson b "$bounds" --argjson i "$i" --argjson n "$n" '
    ($b|length) as $L |
    if $L < 2 or $n == 1 then "{}"
    elif $i == 0 then {_id: {lt: ($b[1]|fromjson)}}
    elif $i == $n - 1 then {_id: {gte: ($b[$L - 2]|fromjson)}}
    else {_id: {gte: ($b[$i]|fromjson), lt: ($b[$i + 1]|fromjson)}} end' \
  | sed -e 's/"lt"/"$lt"/' -e 's/"gte"/"$gte"/'
}

# bucket_digest wd tag —— "<count> <hash>"
bucket_digest() {
  local wd="$1" tag="$2"
  local h c
  c=$(wc -l < "$wd/$tag.lines" | tr -d ' ')
  if [ "$c" = "0" ]; then echo "0 $(printf '' | sha256sum | cut -d' ' -f1)"; return; fi
  h=$(cut -f2 "$wd/$tag.lines" | sha256sum | cut -d' ' -f1)
  echo "$c $h"
}
