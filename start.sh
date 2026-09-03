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

mkdir -p "$DSH_HOME/profiles/$PROFILE_NAME" "$DSH_HOME/.agent-presets"

# 1) 播种 settings.yaml（模型 provider / 权限 / 默认 preset），仅首次
SETTINGS_SRC="$HOME/.dsh/settings.yaml"
SETTINGS_DST="$DSH_HOME/settings.yaml"
if [ ! -f "$SETTINGS_DST" ]; then
  if [ -f "$SETTINGS_SRC" ]; then
    cp "$SETTINGS_SRC" "$SETTINGS_DST"
    perl -pi -e 's/^agent-presets:.*/agent-presets: { default: yh-data }/' "$SETTINGS_DST"
    if ! grep -q '^agent-presets:' "$SETTINGS_DST"; then
      printf '\nagent-presets: { default: yh-data }\n' >> "$SETTINGS_DST"
    fi
    echo "[start] seeded settings.yaml from $SETTINGS_SRC (default preset -> yh-data)"
  else
    echo "[start] WARNING: $SETTINGS_SRC 不存在，未播种模型 provider —— 会话将无法跑模型。"
  fi
fi

# 1b) 播种凭据（API key 仓库），仅首次：拷贝主实例 .credentials.yaml
CRED_SRC="$HOME/.dsh/.credentials.yaml"
CRED_DST="$DSH_HOME/.credentials.yaml"
if [ ! -f "$CRED_DST" ] && [ -f "$CRED_SRC" ]; then
  cp "$CRED_SRC" "$CRED_DST"
  chmod 600 "$CRED_DST"
  echo "[start] seeded credentials from $CRED_SRC (API keys)"
elif [ ! -f "$CRED_DST" ]; then
  echo "[start] WARNING: $CRED_SRC 不存在，模型无法认证（可后续在 UI 里补 API Key）。"
fi

# 1c) 首次启动自动注册本项目为工作区（registry 缺失或为空时），免去手动选目录
WS_STORE="$DSH_HOME/storages/workspace.json"
if [ ! -f "$WS_STORE" ] || grep -q '"workspaceIds": *\[ *\]' "$WS_STORE"; then
  mkdir -p "$DSH_HOME/storages"
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
cp -R "$PRESET_DIR/." "$DSH_HOME/.agent-presets/yh-data/"
echo "[start] preset yh-data -> $DSH_HOME/.agent-presets/yh-data"

# 3) 安装 profile（幂等）：package.json 模板替换插件绝对路径
PROFILE_ROOT="$DSH_HOME/profiles/$PROFILE_NAME"
sed "s|__PLUGIN_PATH__|$PLUGIN_DIR|g" "$PROFILE_DIR/package.template.json" > "$PROFILE_ROOT/package.json"
cp "$PROFILE_DIR/pnpm-workspace.yaml" "$PROFILE_ROOT/pnpm-workspace.yaml"
cp "$PROFILE_DIR/cordis.yml" "$PROFILE_ROOT/cordis.yml"
cp "$PROFILE_DIR/cordis.patch.yml" "$PROFILE_ROOT/cordis.patch.yml"
# 每次都跑 pnpm install（幂等，~200ms）：link: 依赖 + 新装/改插件都即时生效
echo "[start] pnpm install profile $PROFILE_NAME ..."
(cd "$PROFILE_ROOT" && pnpm install)

# 4) 启动（--no-open 可选）
# 注意：bash 3.2 下 set -u + 空数组 "${EXTRA[@]}" 会报 unbound variable，用 ${var+x} 守卫
EXTRA=()
if [ "${YH_OLAP_NO_OPEN:-0}" = "1" ]; then EXTRA+=(--no-open); fi
echo "[start] DSH_HOME=$DSH_HOME  dsh --profile $PROFILE_NAME --port $PORT"
if [ "${#EXTRA[@]}" -gt 0 ]; then
  exec env DSH_HOME="$DSH_HOME" "$DSH_BIN" --profile "$PROFILE_NAME" --port "$PORT" "${EXTRA[@]}"
else
  exec env DSH_HOME="$DSH_HOME" "$DSH_BIN" --profile "$PROFILE_NAME" --port "$PORT"
fi
