#!/usr/bin/env bash
# canon.sh —— EJSON(strict) -> canonical 归一化 (jq)。
# 与 js/canonical.js 同真值的关键归一:
#  - 键序无关: 递归按键排序 (jq sort_by)
#  - double: -0 -> 0, 尾零修剪 (JS doubleCanon 语义)
#  - decimal: 尾零修剪 (NumberDecimal("1.50") == NumberDecimal("1.5"))
#  - numericTolerance: {$numberInt/$numberLong/$numberDouble/$numberDecimal}
#    统一为 {$n:"<十进制串>"} (跨类型按值互通, -0->0)
#  - missingAsNull: 对象字段值为 null 的键递归删除 (数组元素不归一, 位置语义)
# 用法: norm_jq_filter <man:0|1> <tol:0|1>   (echo 到 jq 的 filter 文本)

canon_jq_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

norm_filter() {
  local man="$1" tol="$2"
  cat <<'JQEOF'
def trimzeros: if test("\\.") then
    (if test("\\.[0-9]*[1-9]0+$") then sub("(?<m>[0-9]*\\.[0-9]*[1-9])0+$"; .m)
     elif test("\\.0+$") then sub("\\.0+$"; "")
     else . end)
  else . end;
def normdouble($v): ($v|tostring) as $s |
  (if $s == "-0" or $s == "-0.0" or ($s|test("^-0\\.0+$")) then "0" else ($s|trimzeros) end);
def isnumobj: (type=="object") and (length==1) and ((to_entries[0].key |
  . == "$numberInt" or . == "$numberLong" or . == "$numberDouble" or . == "$numberDecimal"));
def numkey: to_entries[0].key;
def numval: to_entries[0].value;
JQEOF
  if [ "$tol" = "1" ]; then
    cat <<'JQEOF'
def fixnum: if isnumobj then
    (numkey) as $k | (numval) as $v |
    (if $k == "$numberInt" or $k == "$numberLong" then {("$n"): ($v|tostring|trimzeros)}
     elif $k == "$numberDouble" then {("$n"): normdouble($v)}
     else {("$n"): ($v|tostring|trimzeros)} end)
  else . end;
JQEOF
  else
    cat <<'JQEOF'
def fixnum: if isnumobj then
    (numkey) as $k | (numval) as $v |
    (if $k == "$numberDouble" then {($k): normdouble($v)}
     elif $k == "$numberDecimal" then {($k): ($v|tostring|trimzeros)}
     else {($k): $v} end)
  else . end;
JQEOF
  fi
  if [ "$man" = "1" ]; then
    cat <<'JQEOF'
def sk: if type=="object" then
    (if isnumobj then fixnum
     else [to_entries[] | select(.value != null) | {(.key): (.value|sk)}]
       | sort_by(. | keys[]) | add // {} end)
  elif type=="array" then map(sk)
  else . end;
JQEOF
  else
    cat <<'JQEOF'
def sk: if type=="object" then
    (if isnumobj then fixnum
     else [to_entries[] | {(.key): (.value|sk)}] | sort_by(. | keys[]) | add // {} end)
  elif type=="array" then map(sk)
  else . end;
JQEOF
  fi
}

# 输出 "key<TAB>canondoc" 一行 (输入一条 EJSON 文档)
emit_line() {
  local man="$1" tol="$2"
  echo '(.["_id"]) as $id | "\($id|sk|tojson)\t\(.|sk|tojson)"'
}

# L6 叶子路径 diff: 输入 [a, b] (已归一化文档), 输出 deltas 数组
# 语义对齐 js/canonical.js diffDocs: 点号路径/数组下标/modified/missing-in-a|b
# EJSON 标量包装对象 ({"$oid"}..{"$n"} 等单 "$" 键) 视为叶子, 不下钻 (与 JS 一致)
leafdiff_filter() {
  cat <<'JQEOF'
def isleaf: (type=="object") and (length==1) and ((to_entries[0].key|startswith("$")));
def deltas($a; $b; $p):
  if ($a|type)=="object" and ($b|type)=="object" and (($a|isleaf) or ($b|isleaf)) then
    (if $a == $b then [] else [{key: ($p | if . == "" then "<root>" else . end), type: "modified"}] end)
  elif ($a|type)=="object" and ($b|type)=="object" then
    [ (($a|keys) + ($b|keys) | unique[]) as $k |
      (if $p == "" then $k else $p + "." + $k end) as $path |
      (if ($a|has($k)) and ($b|has($k)) then deltas($a[$k]; $b[$k]; $path)
       elif ($a|has($k)) then {key: $path, type: "missing-in-b"}
       else {key: $path, type: "missing-in-a"} end) ]
    | flatten
  elif ($a|type)=="array" and ($b|type)=="array" then
    [ (range(0; ([$a|length, $b|length] | max))) as $i |
      (if $p == "" then "\($i)" else $p + ".\($i)" end) as $path |
      (if ($i < ($a|length)) and ($i < ($b|length)) then deltas($a[$i]; $b[$i]; $path)
       elif ($i < ($a|length)) then {key: $path, type: "missing-in-b"}
       else {key: $path, type: "missing-in-a"} end) ]
    | flatten
  elif $a == $b then []
  else [{key: ($p | if . == "" then "<root>" else . end), type: "modified"}] end;
def run: deltas(.[0]; .[1]; "");
run
JQEOF
}
