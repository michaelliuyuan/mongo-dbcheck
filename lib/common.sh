#!/usr/bin/env bash
# common.sh —— 参数/日志/通用工具
set -o pipefail

MD_VERSION="1.0.0-shell"

log()  { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die()  { log "FATAL: $*"; exit 2; }

# usage 解析: --key value / --flag
md_getopt() {
  # $1=argv string list; 其余为调用方直接读 MD_VARS
  MD_SRC=""; MD_DST=""; MD_OUT="./report"; MD_LEVEL="schema,index,count,hash,diff"
  MD_BUCKETS=64; MD_PCOLL=2; MD_PBUCK=4
  MD_MAN=0; MD_TOL=0; MD_RESUME=0; MD_ONLY=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --src) MD_SRC="$2"; shift 2 ;;
      --dst) MD_DST="$2"; shift 2 ;;
      --out) MD_OUT="$2"; shift 2 ;;
      --level) MD_LEVEL="$2"; shift 2 ;;
      --buckets) MD_BUCKETS="$2"; shift 2 ;;
      --parallel-colls) MD_PCOLL="$2"; shift 2 ;;
      --parallel-buckets) MD_PBUCK="$2"; shift 2 ;;
      --missingAsNull) MD_MAN=1; shift ;;
      --numericTolerance) MD_TOL=1; shift ;;
      --resume) MD_RESUME=1; shift ;;
      --only) MD_ONLY="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) usage; die "unknown arg: $1" ;;
    esac
  done
  [ -n "$MD_SRC" ] && [ -n "$MD_DST" ] || { usage; die "--src/--dst required"; }
  has_level() { case ",$MD_LEVEL," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
}

has_level() { case ",$MD_LEVEL," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

usage() {
  cat >&2 <<'USG'
mongo-dbcheck.sh (shell implementation)
usage: bin/mongo-dbcheck.sh --src URI --dst URI [options]
  --level schema,index,count,hash,diff   checks to run (default all)
  --buckets N           bucket count per collection (default 64; shell 版建议 16~64)
  --parallel-colls P    collection-level concurrency (default 2)
  --parallel-buckets P  bucket-level concurrency (default 4)
  --missingAsNull       explicit null field == missing field (objects only, recursive)
  --numericTolerance    numeric types compare by value (Int/Long/Double/Decimal)
  --resume              reuse per-bucket checkpoints in OUT/.checkpoints
  --only db.coll,...    collection whitelist
  --out DIR             output dir (default ./report)
USG
}

# jq 定位: PATH 或 ~/bin/jq
md_jq() {
  local j=""
  if command -v jq >/dev/null 2>&1; then j="$(command -v jq)"; fi
  if [ -z "$j" ] && [ -x "$HOME/bin/jq" ]; then j="$HOME/bin/jq"; fi
  if [ -z "$j" ]; then return 1; fi
  echo "$j"
}
