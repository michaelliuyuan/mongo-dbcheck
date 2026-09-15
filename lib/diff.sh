#!/usr/bin/env bash
# diff.sh —— L6 归并 diff: 双侧已按 key 排序的 .lines 文件,
# join 找公共 key, comm 找单侧; 公共 key 且 canon 不等 -> jq 叶子路径 delta

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/canon.sh"

# diff_bucket wd srcbase dstbase out —— 对 <wd>/<base>.lines 两个已排序文件做归并 diff
# 行格式: key<TAB>canondoc (key 为 _id 归一化 JSON 文本)
diff_bucket() {
  local wd="$1" sb="$2" db_="$3" out="$4"
  local jq; jq="$(md_jq)"

  # 单侧存在 -> missing (按 key 排序输出)
  join -t $'\t' -v 1 "$wd/$sb.lines" "$wd/$db_.lines" \
    | while IFS=$'\t' read -r key doc; do
        printf '{"_id":%s,"type":"missing-in-target"}\n' "$(unkey "$key")"
      done >> "$out"
  join -t $'\t' -v 2 "$wd/$sb.lines" "$wd/$db_.lines" \
    | while IFS=$'\t' read -r key doc; do
        printf '{"_id":%s,"type":"missing-in-source"}\n' "$(unkey "$key")"
      done >> "$out"

  # 公共 key 且文档不同 -> modified + 叶子路径 fields
  { leafdiff_filter; } > "$wd/leafdiff.jq"
  join -t $'\t' "$wd/$sb.lines" "$wd/$db_.lines" \
    | awk -F'\t' '$2 != $3' \
    | while IFS=$'\t' read -r key d1 d2; do
        printf '[%s,%s]' "$d1" "$d2" \
          | "$jq" -c -f "$wd/leafdiff.jq" \
          | "$jq" -c --arg key "$key" '{_id: ($key|fromjson), type: "modified", fields: .}'
      done >> "$out"
}

# unkey: canonical _id key 行文本 -> 原 EJSON _id (参数文本即 JSON, 恒等紧凑化)
unkey() { printf '%s' "$1" | "$(md_jq)" -c '.'; }
