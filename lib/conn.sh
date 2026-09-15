#!/usr/bin/env bash
# conn.sh —— mongosh 封装: msh_eval / msh_export
# 数据出口统一 EJSON strict (relaxed:false), 天然保留 BSON 类型标签
# ({"$numberInt"} / {"$numberDouble"} / {"$numberLong"} / {"$oid"} ...)。

# msh_eval URI 'js'   —— eval 输出原样返回 (stdout, 清洗 CRLF)
msh_eval() {
  local uri="$1" js="$2"
  mongosh "$uri" --quiet --eval "$js" | tr -d '\r'
}

# msh_count URI db coll
msh_count() { msh_eval "$1" "db.getSiblingDB('$2').getCollection('$3').countDocuments({});"; }

# msh_collections URI —— 输出 db<space>coll 行 (排除 admin/config/local/system.*)
msh_collections() {
  msh_eval "$1" '
    db.getMongo().getDBNames().filter(n => !["admin","config","local"].includes(n))
      .forEach(n => db.getSiblingDB(n).getCollectionNames()
        .filter(c => !c.startsWith("system."))
        .forEach(c => print(n + " " + c)));'
}

# msh_hascoll URI db coll -> 0/1
msh_hascoll() {
  msh_eval "$1" "db.getSiblingDB('$2').getCollectionNames().includes('$3') ? 1 : 0;"
}

# msh_indexes URI db coll —— 每行一个索引 (去 v/ns, EJSON strict)
msh_indexes() {
  msh_eval "$1" '
    db.getSiblingDB("'"$2"'").getCollection('"'"'"$3"'"'"').getIndexes()
      .forEach(i => { const {v, ns, ...rest} = i;
        print(EJSON.stringify(rest, null, 0, {relaxed: false})); });'
}

# msh_ttl URI db coll -> 0/1 (是否存在 expireAfterSeconds 索引)
msh_ttl() {
  msh_eval "$1" '
    db.getSiblingDB("'"$2"'").getCollection("'"$3"'").getIndexes()
      .some(i => i.expireAfterSeconds !== undefined) ? 1 : 0;'
}

# msh_plan URI db coll N —— 桶边界: 输出 JSON 数组 (EJSON strict 边界串, 长 N+1)
# 沿用 JS 版插值: ObjectId hex BigInt 精确插值; 数值/日期线性; 未知类型单桶
msh_plan() {
  msh_eval "$1" '
    const c = db.getSiblingDB("'"$2"'").getCollection("'"$3"'");
    const N = '"$4"';
    const ag = c.aggregate([{$group: {_id: null, min: {$min: "$_id"}, max: {$max: "$_id"}, n: {$sum: 1}}}]).toArray()[0];
    if (!ag || ag.n === 0) { print("[]"); quit(0); }
    const ej = v => EJSON.stringify(v, null, 0, {relaxed: false});
    const tmin = ej(ag.min), tmax = ej(ag.max);
    const kind = s => s.startsWith("{\"$oid\"") ? "oid" : s.startsWith("{\"$date\"") ? "date"
      : (s.startsWith("{\"$numberInt\"") || s.startsWith("{\"$numberLong\"")
         || s.startsWith("{\"$numberDouble\"") || s.startsWith("{\"$numberDecimal\"")) ? "num" : "other";
    const k = kind(tmin);
    let bounds = null;
    if (N >= 2 && k === kind(tmax)) {
      if (k === "oid") {
        const lo = BigInt("0x" + ag.min.toHexString()), hi = BigInt("0x" + ag.max.toHexString());
        if (hi > lo) { bounds = [];
          for (let i = 0; i <= N; i++) bounds.push(ej(ObjectId(
            (lo + (hi - lo) * BigInt(i) / BigInt(N)).toString(16).padStart(24, "0")))); }
      } else if (k === "date") {
        const lo = ag.min.getTime(), hi = ag.max.getTime();
        if (hi > lo) { bounds = [];
          for (let i = 0; i <= N; i++) bounds.push(ej(new Date(lo + Math.round((hi - lo) * i / N)))); }
      } else if (k === "num") {
        const lo = Number(ag.min), hi = Number(ag.max);
        if (hi > lo) { bounds = [];
          for (let i = 0; i <= N; i++) bounds.push(ej(lo + (hi - lo) * i / N)); }
      }
    }
    print(JSON.stringify(bounds || [ej(ag.min), ej(ag.max)]));'
}

# md_uri_parts URI —— 解析 mongodb://user:pass@host:port/authdb
# (mongoexport 的 Go 驱动对 URI 内 %XX 密码解码有怪癖, 统一走显式参数)
md_uri_parts() {
  local u="$1"
  u="${u#mongodb://}"; u="${u#mongodb+srv://}"
  local creds="${u%%@*}" rest="${u#*@}"
  MU_USER="${creds%%:*}"
  MU_PASS="${creds#*:}"
  MU_PASS="${MU_PASS//%21/!}"; MU_PASS="${MU_PASS//%23/#}"; MU_PASS="${MU_PASS//%40/@}"
  MU_PASS="${MU_PASS//%25/%}"; MU_PASS="${MU_PASS//%2B/+}"; MU_PASS="${MU_PASS//%3A/:}"
  MU_PASS="${MU_PASS//%3D/=}"; MU_PASS="${MU_PASS//%2F//}"
  MU_HOST="${rest%%/*}"
  local path="${rest#*/}"
  MU_AUTHDB="${path%%\?*}"
  [ -z "$MU_AUTHDB" ] && MU_AUTHDB=admin
}

# msh_export URI db coll queryJSON —— 每行一条 canonical EJSON 文档
# 首选 mongoexport --jsonFormat=canonical (wire 级类型保真, mongosh 光标会把
# 整值 double 坍缩为 JS number -> $numberInt, 类型保真缺失);
# 无 mongoexport 时回退 mongosh EJSON.stringify (存在上述保真局限)
msh_export() {
  local uri="$1" db="$2" coll="$3" q="$4"
  if command -v mongoexport >/dev/null 2>&1; then
    md_uri_parts "$uri"
    mongoexport --quiet --host "$MU_HOST" -u "$MU_USER" -p "$MU_PASS" \
      --authenticationDatabase "$MU_AUTHDB" --db "$db" -c "$coll" \
      --query "$q" --jsonFormat=canonical 2>/dev/null
    return
  fi
  MD_Q="$q" msh_eval "$uri" '
    const q = EJSON.parse(process.env.MD_Q);
    const cur = db.getSiblingDB("'"$db"'").getCollection("'"$coll"'").find(q).sort({_id: 1});
    while (cur.hasNext()) print(EJSON.stringify(cur.next(), null, 0, {relaxed: false}));'
}
