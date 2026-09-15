#!/usr/bin/env bash
# test/units-shell.sh —— jq 归一化/叶子diff 单元测试 (shell 实现 vs JS 语义)
cd "$(dirname "$0")/.." || exit 2
JQ="${JQ:-$(command -v jq || echo "$HOME/bin/jq")}"
. lib/canon.sh
for man in 0 1; do for tol in 0 1; do
  { norm_filter $man $tol; emit_line $man $tol; } > /tmp/emit-$man$tol.jq
done; done
leafdiff_filter > /tmp/leaf.jq

pass=0; fail=0
chk() { local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $name"; echo " got=$got"; echo " want=$want"; fi; }

E() { echo "$1" | $JQ -r -c -f "$2"; }

# 1. 键序无关 + 类型标签保留 + double/decimal 尾零
g=$(E '{"_id":1,"v":{"b":2,"a":{"$numberDecimal":"1.50"},"c":{"$numberDouble":"-0.0"},"d":{"$numberInt":"3"}}}' /tmp/emit-00.jq)
want=$'1\t{"_id":1,"v":{"a":{"$numberDecimal":"1.5"},"b":2,"c":{"$numberDouble":"0"},"d":{"$numberInt":"3"}}}'
chk keysort-trim "$g" "$want"

# 2. missingAsNull: 对象 null 字段删除, 数组保位
g=$(E '{"_id":2,"arr":[null,1],"b":{"c":null,"d":1},"a":null}' /tmp/emit-10.jq)
chk man-object-null "$g" $'2\t{"_id":2,"arr":[null,1],"b":{"d":1}}'

# 3. 默认不删 null
g=$(E '{"_id":2,"a":null}' /tmp/emit-00.jq)
chk no-man-keep-null "$g" $'2\t{"_id":2,"a":null}'

# 4. numericTolerance 四数值统一 $n
g=$(E '{"_id":3,"a":{"$numberInt":"1"},"b":{"$numberDouble":"1.0"},"c":{"$numberLong":"1"},"d":{"$numberDecimal":"1.00"},"e":{"$numberDouble":"-0.0"}}' /tmp/emit-01.jq)
chk tol-unify "$g" $'3\t{"_id":3,"a":{"$n":"1"},"b":{"$n":"1"},"c":{"$n":"1"},"d":{"$n":"1"},"e":{"$n":"0"}}'

# 5. 两个同值文档 tolerance 下哈希输入一致 (int1 vs double1.0)
g1=$(E '{"_id":{"$numberInt":"1"},"v":{"$numberInt":"1"}}' /tmp/emit-01.jq | cut -f2)
g2=$(E '{"_id":{"$numberInt":"1"},"v":{"$numberDouble":"1.0"}}' /tmp/emit-01.jq | cut -f2)
chk tol-doc-equiv "$g1" "$g2"

# 6. leafdiff: 叶子路径/数组下标/missing/modified
ld() { printf '[%s,%s]' "$1" "$2" | $JQ -c -f /tmp/leaf.jq; }
chk leaf-modify "$(ld '{"a":{"b":1,"c":2}}' '{"a":{"b":1,"c":3}}')" '[{"key":"a.c","type":"modified"}]'
chk leaf-arr "$(ld '{"arr":[{"c":1},{"c":2}]}' '{"arr":[{"c":1},{"c":9}]}')" '[{"key":"arr.1.c","type":"modified"}]'
chk leaf-missing "$(ld '{"a":{"b":1}}' '{"a":{}}')" '[{"key":"a.b","type":"missing-in-b"}]'
chk leaf-arrshrink "$(ld '{"arr":[1,2,3]}' '{"arr":[1,2]}')" '[{"key":"arr.2","type":"missing-in-b"}]'
chk leaf-mixed "$(ld '{"x":{"p":1,"q":2}}' '{"x":{"p":1,"r":3}}')" '[{"key":"x.q","type":"missing-in-b"},{"key":"x.r","type":"missing-in-a"}]'
chk leaf-typechg "$(ld '{"a":{"b":1}}' '{"a":"s"}')" '[{"key":"a","type":"modified"}]'
chk leaf-eq "$(ld '{"a":[1,{"b":2}]}' '{"a":[1,{"b":2}]}')" '[]'
# 数组 null 位置不归一 (missingAsNull 归一化已在上游完成, diff 层看 [null] vs [])
chk leaf-arrnull "$(ld '{"a":[null]}' '{"a":[]}')" '[{"key":"a.0","type":"missing-in-b"}]'
# EJSON 包装对象为叶子, 不下钻 (路径不含 $numberInt 等)
chk leaf-ejsonleaf "$(ld '{"v":[{"$numberInt":"1"},{"$numberInt":"2"}]}' '{"v":[{"$numberInt":"3"},{"$numberInt":"2"}]}')" '[{"key":"v.0","type":"modified"}]'
chk leaf-ejsonnull "$(ld '{"v":{"$numberInt":"1"}}' '{"v":null}')" '[{"key":"v","type":"modified"}]'

echo "==== RESULT: pass=$pass fail=$fail ===="
[ $fail -eq 0 ]
