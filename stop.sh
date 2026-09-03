#!/usr/bin/env bash
# yh-olap 独立工作站停止脚本：按命令行匹配本 DSH_HOME 的 yh-olap 实例，兜底按端口
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DSH_HOME="${YH_OLAP_DSH_HOME:-$SCRIPT_DIR/.dsh-home}"
PORT="${YH_OLAP_PORT:-5175}"

PIDS="$(pgrep -f "dsh.*--profile yh-olap" 2>/dev/null || true)"
if [ -z "$PIDS" ]; then
  PIDS="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
fi
if [ -n "$PIDS" ]; then
  echo "[stop] killing: $PIDS"
  kill $PIDS 2>/dev/null || true
  sleep 1
else
  echo "[stop] 未发现运行中的 yh-olap 工作站进程（端口 ${PORT}）"
fi
