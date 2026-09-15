# Canonical BSON 归一化规范 (v1 草稿)

> 本规范是全工具正确性的地基。目标是：同一文档经归一化后输出**唯一确定**的 canonical 字符串，与存储端、驱动、字段顺序、数值类型歧义无关。开发 `js/` 层必须严格照此实现。

## 0. 总原则
1. **确定性**：相同语义内容 ⇒ 相同 canonical 字符串；任何环境/驱动/字段顺序不影响输出。
2. **无损可比较**：两文档 `equal` ⟺ canonical 字符串相同（纯字符串比较，大小写/空白敏感）。
3. **单向性**：canonical 只用于哈希与比较，不用于还原 BSON。
4. **类型敏感（默认）**：不同 BSON 类型即使裸值相同也视为不等，靠类型标签强制区分。

## 1. 输出格式
- UTF-8 字符串，紧凑、无空白。
- 每个值带**类型标签** `T:value`。类型标签绝对必要：否则 `1`/`"1"`/`1.0`/`NumberLong("1")` 裸串可能相同。

## 2. 字段顺序：键字典序
- 文档内字段按 key 的 **UTF-8 字节序**升序排列后逐字段输出。
- BSON 字段顺序只是插入/驱动痕迹，无语义，必须消除。

## 3. 数组：有序语义（严禁排序）
- 数组保持元素顺序（BSON 数组索引 0..n-1 顺序是语义）。
- 输出 `[T1:v1,T2:v2,...]`。
- 空数组 `[]`、`null`、缺失字段三者严格区分。

## 4. 类型映射表（标签 + 规则）

| BSON 类型 | 标签 | canonical 值规则 |
|---|---|---|
| Double | `d` | 见 §6 浮点 |
| String | `s` | 原样（转义控制字符 `\u0000` 等） |
| Object(文档) | `o` | `{k:c,k:c,...}`，键排序后递归 |
| Array | `a` | `[...]` 有序递归 |
| BinData | `b` | `b:<subtype>:<base64>`，subtype 十进制 |
| ObjectId | `i` | 24 位 hex |
| Boolean | `l` | `true` / `false` |
| Date | `D` | 毫秒整数（自 epoch，含正负） |
| Null | `z` | `null` |
| Regex | `r` | `r:/<pattern>/<options>`，options 字母排序 |
| JavaScript | `j` | 代码字符串 |
| JavaScript(scope) | `J` | 代码 + scope（scope 递归归一化） |
| Symbol(deprecated) | `y` | 字符串 |
| Int32 | `c` | 十进制字符串 |
| Timestamp(BSON) | `t` | `t:<seconds>:<increment>` |
| Int64(NumberLong) | `g` | 十进制字符串 |
| Decimal128 | `m` | 见 §5 |
| MinKey | `n` | `MinKey` |
| MaxKey | `x` | `MaxKey` |
| Undefined(deprecated) | `u` | `undefined` |
| DBPointer(deprecated) | `p` | `p:<ref>\0:<objectid>` |

## 5. Decimal128 规范化
- 输出规范十进制字符串：`decimal.toString()`（去尾随零）。
- 特殊值：`NaN`、`Infinity`、`-Infinity`、`sNaN` 原样输出。
- 默认严格类型：`m` ≠ `d` ≠ `g` ≠ `c`（标签不同即不等）。可选数值容差模式见 §10。

## 6. Double（浮点）规范化与特殊值（最易错）
- `NaN` ⇒ `NaN`，并**约定 `NaN == NaN`**（用统一表示；BSON 里两个 NaN 不等于，canonical 里视为等）。
- `+Infinity` ⇒ `Infinity`；`-Infinity` ⇒ `-Infinity`。
- `-0` 与 `+0` ⇒ 统一为 `0`（消除 -0 差异）。
- 其余 double ⇒ 用 17 位有效数字十进制展开，等价于 `(new Decimal128(v)).toString()`。**禁止**用 `$toString(double)`（跨 server 版本精度不稳定），统一经 Decimal128 展开保证确定性。

## 7. 缺失字段 vs null vs undefined（易错点 2）
- 缺字段：canonical 中该键**不出现**。
- 显式 `null`：键出现，值 `z:null`。
- `undefined`（deprecated）：`u:undefined`。
- 默认严格：三者互不相等。可选 `missingAsNull=true` 时缺失字段按 `z:null` 填充（用于历史库「隐式 null」场景）。
- **实测提示（v1 修订）**：`undefined` 经 mongosh / 常规 BSON 序列化写入时会被坍缩为 `null`，MongoDB 已无法通过常规写入路径持久化 `Undefined` 类型。故 `undefined` 分支保留在 `canonical()` 实现中以备历史数据，但测试样本**不应**构造「undefined vs null」作为差异用例；差异样本改用「缺字段 vs null」或其它真实差异。

## 8. 键排序与缺失字段填充
- 默认**不填充**缺失字段。
- 递归深度上限 `maxDepth`（默认 100），超限截断并计数（防极深嵌套）。

## 9. 哈希输入与实现载体（v1 修订，重要）
- 对 canonical 串 `c` 计算 `sha256(c)`（类型已在串内，不额外追加）。
- 整桶哈希（v1 修订，M3 流式化）：桶内**每文档**计算 `h = sha256( canonical(_id) + "\n" + canonical(doc) )`，桶哈希 = 全部 `h` 的 **256-bit 模 2^256 加和**（次序无关组合）。流式 O(1) 文档内存；与旧「按 `_id` canonical 升序排序后 `sha256(concat(...))`」**同真值**（multiset 相等 ⇔ 排序序列相等，模加和无非平凡两两抵消），旧公式保留作交叉校验（56 case 三方一致：流式 = 旧版 = L6 判等）。桶级 count 检查随配。
- **类型保真的硬约束（v1 修订）**：服务端 `$function`、mongosh 全局 JS、以及 `$project`+`$toString` 快路径，都会把 `int32` 与 `double` 一并压成 JS `number`，**类型标签丢失**，无法满足 §4「类型敏感」要求。因此：
  - **归一化与哈希必须在客户端执行**，且必须用 **Node + 官方 mongodb 驱动 + `promoteValues:false` / `promoteLongs:false`** 读取，保留 `Int32` / `Long`(int64) / `Double` / `Decimal128` 等 wrapper，使 `canonical()` 能区分类型。
  - **服务端聚合仅用于分桶 `$match`（按 `_id` 范围过滤）**，不做归一化；分桶 `$match` 命中索引后可稳定定位差异段。
  - 成本代价：哈希需把桶内文档拉回客户端计算。这是类型正确的必要妥协；性能靠「分桶 + 桶级并发 + 游标批量读取」抵消，而非在服务端内完成。

## 10. 配置开关
- `missingAsNull`: bool，默认 `false`。
- `numericTolerance`: bool，默认 `false`；为 `true` 时 double/int32/int64/decimal128 数值相等视为等（先 `$toDecimal` 再比较）。
- `maxDepth`: int，默认 `100`。
- `hashAlgo`: 默认 `sha256`。

### §missingAsNull（哈希层归一，bug#4 方案 a，v1 修订）
`missingAsNull` 与 `numericTolerance` 均贯穿 L5 与 L6：桶哈希与逐条 diff 共用同一 canonical 语义与同一 opts 来源（CLI 一路透传）。
- `missingAsNull=true`：canonical 序列化 Object 时略去值为 null 的字段（显式 null ≡ 字段缺失），**仅作用于对象字段，递归生效于任意嵌套深度**；数组下标为位置语义不归一，`[1,null]` vs `[1]` 判 diff（叶子路径 `v.1: missing-in-b`），默认与开关下行为一致。
- `numericTolerance=true`：数值类（Double/Int32/Long/Decimal128）canonical 统一为 `n:<规范化十进制串>` 标签，L5/L6 同源。
- 不变式：任一 opts 组合下「L5 哈希判等 ⇔ L6 diff 判等」同真值（跨层一致性单测守护，56 case）。

## 11. 实现载体（js/ 接口）
- 暴露 `canonical(x, opts?) -> string`、`canonicalHash(x, opts?) -> hex`、`diffDocs(a,b,opts?)->{equal,deltas}`、`bucketHash(rows,opts?)->hex`。opts 全可选，默认 `{missingAsNull:false, numericTolerance:false, maxDepth:100, hashAlgo:"sha256"}`，`canonical(x)===canonical(x,{})` 且不传不抛错。
- **读取必须走 Node + 官方驱动 `promoteValues:false` / `promoteLongs:false`**，否则 int32/double 类型坍缩。
- **归一化与哈希在客户端做**；服务端仅用 `$match` 做分桶范围过滤，不做归一化。
- 客户端 diff（L6）阶段：双游标按 `_id` 归并，对每文档 `canonical()` 做字段级二次确认（桶哈希仅定位差异桶）。
- 大字段（>几 MB）走摘要/截断路径，不拉全量（见 §12）。

## 12. 测试矩阵（tester 落地样本时的 expected canonical 基线）
| 样例 | 期望语义 |
|---|---|
| `{a:1,b:{c:2}}` vs `{b:{c:2},a:1}` | equal（键排序） |
| `{a:1}` vs `{a:1.0}` (int32 vs double) | 默认 diff；numericTolerance 下 equal |
| `{a:NumberLong(1)}` vs `{a:1}` | 默认 diff |
| `{v:NaN}` vs `{v:NaN}` | equal |
| `{v:-0}` vs `{v:0}` | equal |
| `{}` vs `{v:null}` | diff（缺失 vs null） |
| `{v:null}` vs `{v:undefined}` | **移除**（undefined 写入即坍缩为 null，无法构造真实差异） |
| `{v:[1,2]}` vs `{v:[2,1]}` | diff（数组有序） |
| `{_id:ObjectId(...)}` vs `{_id:"<hex>"}` | diff（类型不同） |
| Decimal128 去尾随零 | `1.50` ⇒ `1.5`，equal |
| 超大字段（>几 MB） | 走摘要/截断路径，不拉全量 |

## 13. 结论口径（summary）
- 单个集合结论 `equal` 仅当：L3 count 一致 **且** L5 全桶哈希一致。
- summary 增加 `overall` 三态字段：`equal` / `diff` / `error`。`error` 覆盖超时、权限、网络失败等无法判定的集合，不并入 diff 统计。

## 14. 措辞修正
- 背景中的「Oracle 场景」为笔误，本工具是 MongoDB↔MongoDB；统一改为「用于 MongoDB 数据迁移 / 双写 / 主备之间的一致性验收」。