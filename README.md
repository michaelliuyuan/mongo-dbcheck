# mongo-dbcheck（shell 版）

双 MongoDB 数据一致性校验工具，**纯 Linux shell 实现**（bash + jq + coreutils +
mongoexport/mongosh），与 `js/` 参考实现**同真值**（同 seed 集合上 overall、delta
明细、退出码一致）。

## 快速开始（三步走）

**第 1 步：安装依赖**（Ubuntu/Debian 为例，其他发行版把 apt 换成 yum/dnf 即可）

```bash
sudo apt-get update && sudo apt-get install -y bash jq coreutils
# mongosh 与 mongoexport（mongodb-database-tools）不在发行版仓库，去官方下载页取对应平台包：
#   mongosh:                https://www.mongodb.com/try/download/shell
#   database-tools(含 mongoexport): https://www.mongodb.com/try/download/database-tools
# 例（Ubuntu amd64，版本号请按下载页最新替换）：
# sudo dpkg -i mongosh-2.x.x-linux-x64.deb mongodb-database-tools-ubuntu2204-x86_64-100.x.x.deb
```

**第 2 步：跑第一次比对**（整条命令可直接复制，替换 URI 里的主机/账号即可）

```bash
bin/mongo-dbcheck.sh \
  --src "mongodb://user:pass@host1:27020/admin" \
  --dst "mongodb://user:pass@host2:27021/admin" \
  --level schema,index,count,hash,diff --buckets 8 --out report
echo "exit=$?"   # 0 全一致 / 1 有差异 / 2 运行错误
```

**第 3 步：看结果**——打开 `report/summary.json`：

| 字段 | 含义 |
|---|---|
| `overall` | 三态总判定：`equal` 全一致 / `diff` 有差异 / `error` 有运行错误 |
| `counts.equal` / `counts.diff` | 一致 / 有差异的集合个数（error 单独计数，不入 diff） |
| `counts.ttlSkip` | TTL 集合自动跳过数据比对的个数（仅比索引结构） |
| `collections[].checks.hash` | 该集合分桶哈希：`buckets` 总桶数、`mismatch` 不一致桶数 |
| `collections[].checks.diff.count` | 该集合不一致文档条数 |

有差异时逐条明细看 `report/diff/<db>.<coll>.ndjson`（每行一个 `_id`，
`type`=missing/modified，`fields` 精确到叶子路径），样例见下节。

## 真实输出样例（验收环境实跑截取）

`summary.json` 关键片段（11 集合、8 桶、并发 4，两端埋有差异种子）：

```json
{
  "overall": "diff",
  "counts": { "equal": 5, "diff": 5, "error": 0, "ttlSkip": 1 },
  "collections": [
    { "db": "md_data", "coll": "eq.float",  "overall": "equal",
      "checks": { "hash": { "buckets": 8, "mismatch": 0 }, "diff": { "count": 0 } } },
    { "db": "md_data", "coll": "diff.array", "overall": "diff",
      "checks": { "hash": { "buckets": 8, "mismatch": 3 }, "diff": { "count": 3 } } }
  ]
}
```

对应 `diff/md_data.diff.array.ndjson`（字段级明细，`v.2` 即数组下标路径）：

```json
{"_id":{"$numberInt":"1"},"type":"modified","fields":[{"key":"v.0","type":"modified"},{"key":"v.2","type":"modified"}]}
{"_id":{"$numberInt":"2"},"type":"modified","fields":[{"key":"v","type":"modified"}]}
{"_id":{"$numberInt":"4"},"type":"modified","fields":[{"key":"v.1","type":"missing-in-b"}]}
```

字段缺失方向示例（`diff/md_data.diff.missing.ndjson`，`missing-in-a`=源侧缺、
`missing-in-b`=目标侧缺）：

```json
{"_id":{"$numberInt":"1"},"type":"modified","fields":[{"key":"v","type":"missing-in-a"}]}
{"_id":{"$numberInt":"2"},"type":"modified","fields":[{"key":"v","type":"missing-in-b"}]}
{"_id":{"$numberInt":"3"},"type":"modified","fields":[{"key":"a.c","type":"missing-in-a"}]}
```

该次运行退出码 `1`（有差异，与 `overall:"diff"` 一致）。

## 架构与类型保真

BSON 的 int32/double/long/decimal 必须可区分。shell 版的保真路径：

- **数据出口用 `mongoexport --jsonFormat=canonical`**（首选）：wire 级序列化，
  `{"$numberInt":"1"}` / `{"$numberDouble":"1.0"}` / `{"$numberLong":"1"}` /
  `{"$oid"}` / `{"$date"}` 天然携带 BSON 类型标签。
  ⚠️ 不能用 mongosh 光标 + `EJSON.stringify` 做数据出口：mongosh 把整值 double
  坍缩为 JS number（`Double(0)` 会打成 `$numberInt`），类型失真。mongosh 仅用于
  元信息（集合清单/索引/计数/分桶边界）。
- **归一化用 jq**（`lib/canon.sh`）：递归键排序（键序无关）、`-0→0`、double/decimal
  尾零修剪、`--numericTolerance` 四数值类型统一为 `{$n:"值"}`、`--missingAsNull`
  递归删除对象 null 字段（数组位置语义不归一）——与 spec §10 及 JS 版语义一致。
- **L5 桶哈希**：桶内行按 `_id` 归一化键 `LC_ALL=C` 排序后 `sha256sum`
  （count+hash 双比较）。
- **L6 归并 diff**：`join` 按 `_id` 键归并，单侧行报 missing；公共键文档不等时
  jq 叶子路径 diff（`a.c` / `arr.2.c` / `missing-in-a|b` / `modified`）。
- 分桶边界由 mongosh 以 BigInt（ObjectId）/线性（数值/日期）插值生成，
  `EJSON.parse` 后作为范围查询；断点续跑按桶结果文件 `--resume`。

## 依赖

- bash 4+、jq ≥ 1.6、coreutils（sort/sha256sum/join/comm/wc）
- **mongoexport**（mongodb-database-tools，数据导出，强烈建议）+ **mongosh**（元信息/边界）

## 用法

```bash
bin/mongo-dbcheck.sh \
  --src "mongodb://user:pass@host1:27020/admin" \
  --dst "mongodb://user:pass@host2:27021/admin" \
  --level schema,index,count,hash,diff --buckets 8 --out report
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--src` / `--dst` | 必填 | 源/目标 URI（`user:pass@host/authdb`；密码特殊字符可 URL 编码） |
| `--level` | 全部 | schema,index,count,hash,diff 子集 |
| `--buckets` | 64 | 每集合分桶数。**shell 版建议 8~64**（每桶 = 2 次 mongoexport 进程） |
| `--parallel-colls` | 2 | 集合级并发 |
| `--parallel-buckets` | 4 | 桶级并发 |
| `--missingAsNull` | 关 | 显式 null ≡ 缺失，仅对象字段、递归；数组位置语义不归一 |
| `--numericTolerance` | 关 | Int/Long/Double/Decimal 按值互通 |
| `--resume` | 关 | 断点续跑（复用 `OUT/.checkpoints/` 已完桶） |
| `--only db.coll,...` | 空 | 集合白名单 |
| `--out` | ./report | 产物目录 |

退出码：`0` 全一致 / `1` 有差异 / `2` 运行错误（error 单独计数，不入 diff）。
TTL 集合自动 `ttl_skip`（仅比对索引结构）。

## 产物

- `summary.json`：overall 三态（equal/diff/error）+ counts 分开计数 + stats 参数
  快照 + 每集合明细（hash 桶数/不一致桶数、delta 条数）
- `diff/<db>.<coll>.ndjson`：每行 `{"_id":<canonical EJSON>,"type":...,"fields":[...]}`
  （`_id` 为 canonical EJSON 表示——与 JS 版的渲染差异已知，比对时请按键值语义对齐）
- `.checkpoints/`：逐桶 `count+hash` 结果，`--resume` 复用

## 已知局限（取舍）

- **数据出口仅 `mongoexport --jsonFormat=canonical` 保证数值类型保真；mongosh
  回退路径不保证数值类型保真**（mongosh 光标把整值 double 坍缩为 JS number，
  如 `Double(0)` 会打成 `{"$numberInt":"0"}`，eq.float 类样本会误判）。生产
  环境必须安装 mongodb-database-tools；回退路径仅供极端降级，结论不作为
  类型敏感验收依据。
- 性能较 JS 版慢 1.5~3 倍（进程 spawn + 文本管道），分钟级可接受；性能敏感
  场景用 `js/cli.js`。
- ndjson 的 `_id` 为 canonical EJSON 表示（`{"$oid":"..."}`），与 JS 版驱动的
  stringify 渲染不同；跨版本比对按**键值语义**对齐，不要求逐字节一致。
- jq 叶子 diff 未实现 maxDepth 截断（数据库文档常规深度远小于 100；如遇超深
  构造数据，以 JS 版结果为准）。

## 性能（远程双节点实测，~1M 文档/300MB×2）

| 场景 | shell 版 | JS 参考版 |
|---|---|---|
| 11 功能集合（8 桶/并发4） | ~92s | ~75s |
| oid50w 50 万单集合 | ~90s | ~30s |
| bigdoc 7×14MB | ~62s | ~26s |

**桶级并发实测（oid50w，buckets=16）**：`--parallel-buckets 1` → 117s；
`4` → 70s；`8` → 63s（默认 4，带宽/对端负载允许时 8 更优，结论 delta 不变）。

> **前提标注**：以上基线为公网远程双节点 + 空闲负载下的单轮实测，绝对值随
> 网络带宽、对端 mongod 负载、客户端 CPU 波动明显（同环境复测 oid50w pb4
> 亦出现过 38s ~ 70s 的区间）；**跨环境只比相对趋势，不比绝对秒数**。

比 JS 版慢 1.5~3 倍（进程 spawn + 文本管道），符合预期取舍；桶级并行
（`--parallel-buckets`）与集合级并行可部分补偿。性能敏感场景用 `js/cli.js`
（见下）。

## JS 参考实现（`js/`）

Node + 官方驱动（`promoteValues:false`）+ 驱动游标流式处理，性能更好；
接口与产物语义同真值。用法：`node js/cli.js --src URI --dst URI --buckets 256 ...`
（详见 `js/` 内 README 说明与 `docs/perf-tuning.md`）。

## 测试

**① jq 单测（离线，无需数据库，装好 jq 即可跑）**

```bash
test/units-shell.sh        # 期望输出：==== RESULT: pass=15 fail=0 ====
```

**② 末桶边界回归（需两端可写测试库，自建自清 `__gap_test` 集合）**

```bash
export MD_SRC_URI="mongodb://user:pass@host1:27020/admin"
export MD_DST_URI="mongodb://user:pass@host2:27021/admin"
test/gap-regression.sh     # 期望末行：PASS: gap-zone modified docs (80,99) + control (10) all detected
```

**③ JS 版 seed 回归（50 项，与 shell 版同真值基准；需 node + 依赖）**

```bash
export MD_SRC_URI="mongodb://user:pass@host1:27020/admin"
export MD_DST_URI="mongodb://user:pass@host2:27021/admin"
node test/validate-canonical.js
```

回归用例背景：`test/gap-regression.sh` 防的是历史上出现过的末桶
off-by-one（`_id∈[bounds[N-1], max)` 区间漏检），构造 4 桶 0..100、在危险区
80/99 + 对照 10 埋 modified，断言 3 条全检出（已验证对旧 bug 为 FAIL、修复后
PASS）。

## 目录

```
bin/mongo-dbcheck.sh   # shell 版主入口（默认）
lib/common.sh          # 参数/日志/jq 定位
lib/conn.sh            # mongosh/mongoexport 封装 (URI 解析/EJSON 边界)
lib/canon.sh           # jq 归一化 + 叶子路径 diff filter
lib/hash.sh            # L5 桶哈希 (导出→归一化→sort→sha256sum)
lib/diff.sh            # L6 归并 diff (join + jq leafdiff)
js/                    # Node 参考实现 (性能敏感场景)
docs/perf-tuning.md    # JS 版性能基线
```
