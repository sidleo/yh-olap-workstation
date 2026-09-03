#!/usr/bin/env bash
# yh-olap 独立工作站启动脚本
# - DSH_HOME 隔离到本仓库 .dsh-home（真隔离，不碰现有 3080 实例）
# - 首次启动：安装 profile（pnpm install）、拷贝 yh-data preset、播种 settings.yaml
# - 默认 5175；YH_OLAP_PORT 换端口；YH_OLAP_NO_OPEN=1 不自动开浏览器
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$SCRIPT_DIR"
PLUGIN_DIR="$REPO/plugin"
PROFILE_DIR="$REPO/profile"
PRESET_DIR="$REPO/preset/yh-data"
# 强制隔离：忽略外层继承的 DSH_HOME（本会话被主实例注入），默认本仓库 .dsh-home
export DSH_HOME="${YH_OLAP_DSH_HOME:-$REPO/.dsh-home}"
PROFILE_NAME="yh-olap"
PORT="${YH_OLAP_PORT:-5175}"
DSH_BIN="${DSH_BIN:-dsh}"

mkdir -p "${DSH_HOME}/profiles/${PROFILE_NAME}" "${DSH_HOME}/.agent-presets"

# 1) 播种 settings.yaml（模型 provider / 权限 / 默认 preset），仅首次
SETTINGS_SRC="$HOME/.dsh/settings.yaml"
SETTINGS_DST="${DSH_HOME}/settings.yaml"
if [ ! -f "$SETTINGS_DST" ]; then
  if [ -f "${SETTINGS_SRC}" ]; then
    cp "${SETTINGS_SRC}" "$SETTINGS_DST"
    perl -pi -e 's/^agent-presets:.*/agent-presets: { default: yh-data }/' "$SETTINGS_DST"
    if ! grep -q '^agent-presets:' "$SETTINGS_DST"; then
      printf '\nagent-presets: { default: yh-data }\n' >> "$SETTINGS_DST"
    fi
    echo "[start] seeded settings.yaml from ${SETTINGS_SRC} (default preset -> yh-data)"
  else
    echo "[start] WARNING: ${SETTINGS_SRC} 不存在，未播种模型 provider —— 会话将无法跑模型。"
  fi
fi

# 1b) 播种凭据（API key 仓库），仅首次：拷贝主实例 .credentials.yaml
CRED_SRC="$HOME/.dsh/.credentials.yaml"
CRED_DST="${DSH_HOME}/.credentials.yaml"
if [ ! -f "$CRED_DST" ] && [ -f "${CRED_SRC}" ]; then
  cp "${CRED_SRC}" "$CRED_DST"
  chmod 600 "$CRED_DST"
  echo "[start] seeded credentials from ${CRED_SRC} (API keys)"
elif [ ! -f "$CRED_DST" ]; then
  echo "[start] WARNING: ${CRED_SRC} 不存在，模型无法认证（可后续在 UI 里补 API Key）。"
fi

# 1c) 首次启动自动注册本项目为工作区（registry 缺失或为空时），免去手动选目录
WS_STORE="${DSH_HOME}/storages/workspace.json"
if [ ! -f "$WS_STORE" ] || grep -q '"workspaceIds": *\[ *\]' "$WS_STORE"; then
  mkdir -p "${DSH_HOME}/storages"
  python3 - "$WS_STORE" "$REPO" <<'PY2'
import json, sys, uuid, os
from datetime import datetime, timezone
store, path = sys.argv[1], sys.argv[2]
if os.path.exists(store):
    d = json.load(open(store))
else:
    d = {"unit": {"name": "workspace", "version": 2},
         "global": {"initialized": True, "workspaceIds": [], "archivedSessionIds": []},
         "tables": {"workspaces": {}}}
# 幂等：该 path 已注册则不重复建
for w in d.setdefault("tables", {}).setdefault("workspaces", {}).values():
    if w.get("path") == path:
        print("[start] workspace already registered, skip"); sys.exit(0)
wid = str(uuid.uuid4())
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
d["tables"]["workspaces"][wid] = {
    "path": path, "title": "yh-olap 工作站", "sessionIds": [],
    "createdAt": now, "updatedAt": now,
}
d.setdefault("global", {})["workspaceIds"] = [wid] + d.get("global", {}).get("workspaceIds", [])
json.dump(d, open(store, "w"), ensure_ascii=False, indent=2)
print("[start] seeded default workspace -> " + path)
PY2
fi

# 2) 拷贝 yh-data preset（覆盖，编辑后重启即生效）
cp -R "$PRESET_DIR/." "${DSH_HOME}/.agent-presets/yh-data/"
echo "[start] preset yh-data -> ${DSH_HOME}/.agent-presets/yh-data"

# 3) 安装 profile（幂等）：package.json 模板替换插件绝对路径
PROFILE_ROOT="${DSH_HOME}/profiles/${PROFILE_NAME}"
sed "s|__PLUGIN_PATH__|$PLUGIN_DIR|g" "$PROFILE_DIR/package.template.json" > "$PROFILE_ROOT/package.json"
cp "$PROFILE_DIR/pnpm-workspace.yaml" "$PROFILE_ROOT/pnpm-workspace.yaml"
cp "$PROFILE_DIR/cordis.yml" "$PROFILE_ROOT/cordis.yml"
cp "$PROFILE_DIR/cordis.patch.yml" "$PROFILE_ROOT/cordis.patch.yml"
# 每次都跑 pnpm install（幂等，~200ms）：link: 依赖 + 新装/改插件都即时生效
echo "[start] pnpm install profile ${PROFILE_NAME} ..."
(cd "$PROFILE_ROOT" && pnpm install)

# 4) 启动（--no-open 可选）
# 注意：bash 3.2 下 set -u + 空数组 "${EXTRA[@]}" 会报 unbound variable，用 ${var+x} 守卫
EXTRA=()
if [ "${YH_OLAP_NO_OPEN:-0}" = "1" ]; then EXTRA+=(--no-open); fi
PID_FILE="${DSH_HOME}/yh-olap.pid"
# 若已有实例在跑（PID 文件有效）→ 直接提示并退出，避免同端口双实例。
# 启动宽限期：进程刚启动（<10s）时 dsh 可能还在初始化，kill -0 短暂失败
# 不应误判"已死"而清 PID 起双实例。
if [ -f "${PID_FILE}" ]; then
  OLD_PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [ -n "${OLD_PID}" ] && kill -0 "${OLD_PID}" 2>/dev/null; then
    echo "[start] yh-olap 工作站已在运行（PID ${OLD_PID}, port ${PORT}）。如要重启请先 ./stop.sh"
    exit 0
  fi
  # 进程探测失败：区分「刚启动宽限期」与「确已死亡」
  if [ -n "${OLD_PID}" ]; then
    PFILE_AGE="$(($(date +%s) - $(stat -f %m "${PID_FILE}" 2>/dev/null || echo "$(date +%s)")))"
    if [ "${PFILE_AGE}" -lt 10 ] 2>/dev/null; then
      echo "[start] PID 文件 ${OLD_PID} 刚写入（<10s），视为启动中；若确认已退出请稍后重试或先 ./stop.sh"
      exit 1
    fi
    echo "[start] 清理失效 PID 文件（进程 ${OLD_PID} 已不存在）"
    rm -f "${PID_FILE}"
  fi
fi
echo "[start] DSH_HOME=${DSH_HOME}  dsh --profile ${PROFILE_NAME} --port ${PORT}"
# 后台启动并把 PID 写入文件（供 stop.sh 精确停止）；dsh 自己可能 fork，写 shell 的 PID 即可，
# stop.sh 首杀 shell PID 后再按 --port 命令行兜底杀子进程。日志输出到 DSH_HOME 下便于排障。
LOG_FILE="${DSH_HOME}/yh-olap.log"
nohup env DSH_HOME="${DSH_HOME}" "$DSH_BIN" --profile "${PROFILE_NAME}" --port "${PORT}" "${EXTRA[@]+"${EXTRA[@]}"}" >>"${LOG_FILE}" 2>&1 &
echo $! > "${PID_FILE}"
echo "[start] 已后台启动 PID $(cat "${PID_FILE}")，日志: ${LOG_FILE}"
# 等待端口就绪（最多 ~15s），避免脚本返回太快让用户以为失败
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}" 2>/dev/null; then
    echo "[start] 就绪: http://127.0.0.1:${PORT}"
    if [ "${YH_OLAP_NO_OPEN:-0}" != "1" ]; then
      (command -v open >/dev/null 2>&1 && open "http://127.0.0.1:${PORT}") || true
    fi
    exit 0
  fi
  sleep 0.5
done
echo "[start] 等待 ${PORT} 超时，请查看日志: ${LOG_FILE} （进程可能仍在启动中）"
exit 1
