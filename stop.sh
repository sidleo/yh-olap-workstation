#!/usr/bin/env bash
# yh-olap 独立工作站停止脚本
# 停止策略（安全性优先，绝不误杀非本工作站的进程）：
#   1) 首选：按 start.sh 写入的 PID 文件（${DSH_HOME}/yh-olap.pid）停止主进程。
#   2) 兜底：仅当 PID 文件缺失/失效且存在**精确匹配**本工作站命令行
#      （dsh 可执行文件 + --profile yh-olap + --port ${PORT} 三个条件齐备）的进程时，
#      才按命令行停止；否则只提示，绝不按端口/模糊串杀进程。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${YH_OLAP_DSH_HOME:-$SCRIPT_DIR/.dsh-home}"
PROFILE_NAME="yh-olap"
PORT="${YH_OLAP_PORT:-5175}"
PID_FILE="${DSH_HOME}/yh-olap.pid"

killed=0

# 1) PID 文件精确停止
if [ -f "${PID_FILE}" ]; then
  PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
  rm -f "${PID_FILE}"
  if [ -n "${PID}" ] && kill -0 "${PID}" 2>/dev/null; then
    echo "[stop] killing PID ${PID} (port ${PORT})"
    kill "${PID}" 2>/dev/null || true
    sleep 1
    if kill -0 "${PID}" 2>/dev/null; then
      echo "[stop] 进程未退出，发送 SIGKILL"
      kill -9 "${PID}" 2>/dev/null || true
    fi
    killed=1
  else
    echo "[stop] PID 文件中的进程 ${PID} 已不存在，尝试命令行兜底"
  fi
fi

# 2) 命令行兜底：必须三个条件齐备才匹配（防误杀）。
#    用 ps + awk 精确解析（pgrep -f 的子串匹配太宽，曾误匹配无关进程）。
#    匹配对象：真实 dsh CLI（node .../dsh 或 dsh），带 --profile ${PROFILE_NAME} 与 --port ${PORT}。
TARGET=""
while IFS= read -r line; do
  pid="$(echo "$line" | awk '{print $1}')"
  cmd="$(echo "$line" | cut -d' ' -f2-)"
  has_dsh="$(echo "$cmd" | grep -E '(^|/)(dsh|dsh[^ ]*)( |$)' >/dev/null 2>&1 && echo 1 || echo 0)"
  has_profile="$(echo "$cmd" | grep -E -- "--profile[ =]${PROFILE_NAME}( |$)" >/dev/null 2>&1 && echo 1 || echo 0)"
  has_port="$(echo "$cmd" | grep -E -- "--port[ =]${PORT}( |$)" >/dev/null 2>&1 && echo 1 || echo 0)"
  if [ "$has_dsh" = "1" ] && [ "$has_profile" = "1" ] && [ "$has_port" = "1" ]; then
    TARGET="$TARGET $pid"
  fi
done < <(ps -axo pid=,command=)

if [ -n "$TARGET" ]; then
  echo "[stop] killing (精确命令行匹配):$TARGET"
  # shellcheck disable=SC2086
  kill $TARGET 2>/dev/null || true
  killed=1
fi

if [ "$killed" = "1" ]; then
  sleep 1
  echo "[stop] 已停止 yh-olap 工作站"
else
  echo "[stop] 未发现运行中的 yh-olap 工作站（--profile ${PROFILE_NAME} --port ${PORT}）"
  echo "[stop] 提示：若确认端口 ${PORT} 被其它程序占用，请手动检查: lsof -i tcp:${PORT}"
fi
exit 0