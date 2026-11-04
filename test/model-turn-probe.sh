#!/usr/bin/env bash
# test/model-turn-probe.sh —— 真实模型轮冒烟（UI 全绿抓不到的那一层）
#
# 为什么需要：右侧栏/编辑器/面板都正常，不等于会话可用。system prompt 装配、命令注册、
# `olap` 工具在真实 turn 里才会跑。历史上（preset persona 写 {{cwd}}）出现过「面板全正常、
# 对话一律处理失败」的静默回归。
#
# 本脚本：隔离 DSH_HOME + 独立端口起实例 → 打开右侧栏 OLAP 工具 → 发一轮 `/olap ...` 要求模型
# 调用 `olap` 工具（action=state）→ 断言：无「处理失败 / unknown prompt variable / 本轮运行失败」、
# 本轮完成、工具结果回显 tabs=。
#
# 成本：一次真实模型调用（几 k token）。需要 ~/.dsh/settings.yaml + .credentials.yaml 可用。
# 用法：bash test/model-turn-probe.sh            # 默认端口 5288
#       KEEP=1 bash test/model-turn-probe.sh     # 保留实例排查
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$REPO/plugin"
TMPBASE="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P || echo /tmp)"
VHOME="${YH_TURN_HOME:-$TMPBASE/yh-olap-turn-home}"
VWS="${YH_TURN_WS:-$TMPBASE/yh-olap-turn-ws}"
PROFILE="yh-olap-turn"
PORT="${PORT:-5288}"
DSH_BIN="${DSH_BIN:-dsh}"
PNPM_BIN="${PNPM_BIN:-pnpm}"
BASE="http://127.0.0.1:${PORT}"
LOG="$VHOME/dsh.log"
KEEP="${KEEP:-0}"
DASH_PID=""
cleanup() {
  if [ "$KEEP" = "1" ]; then echo "[keep] PID=${DASH_PID:-?} home=$VHOME log=$LOG"; return; fi
  [ -n "$DASH_PID" ] && kill "$DASH_PID" 2>/dev/null || true
  sleep 0.8
  pkill -f "profile ${PROFILE} --port ${PORT}" 2>/dev/null || true
  rm -rf "$VHOME" "$VWS"
}
trap cleanup EXIT

command -v ego-browser >/dev/null 2>&1 || { echo "缺 ego-browser"; exit 2; }
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "端口 ${PORT} 已被占用（换 PORT=...）"; exit 2; fi
(cd "$PLUGIN" && node build.mjs) >/dev/null 2>&1 || { echo "client 构建失败"; exit 2; }

rm -rf "$VHOME" "$VWS"; mkdir -p "$VHOME/profiles/$PROFILE" "$VHOME/storages" "$VWS"
[ -f "$HOME/.dsh/settings.yaml" ] && cp "$HOME/.dsh/settings.yaml" "$VHOME/settings.yaml" || { echo "缺 ~/.dsh/settings.yaml"; exit 2; }
[ -f "$HOME/.dsh/.credentials.yaml" ] && cp "$HOME/.dsh/.credentials.yaml" "$VHOME/.credentials.yaml" && chmod 600 "$VHOME/.credentials.yaml"
cat > "$VHOME/profiles/$PROFILE/package.json" <<JSON
{
  "name": "dsh-profile-${PROFILE}",
  "private": true,
  "dependencies": { "dsh-yh-olap-workstation": "link:$PLUGIN" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-yh-olap-workstation"] } }
}
JSON
printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nminimumReleaseAge: 0\n' > "$VHOME/profiles/$PROFILE/pnpm-workspace.yaml"
printf '[]\n' > "$VHOME/profiles/$PROFILE/cordis.yml"
python3 - "$VHOME/storages/workspace.json" "$VWS" <<'PY'
import json, sys, uuid
from datetime import datetime, timezone
store, path = sys.argv[1], sys.argv[2]
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
wid = str(uuid.uuid4())
json.dump({"unit": {"name": "workspace", "version": 2},
           "global": {"initialized": True, "workspaceIds": [wid], "archivedSessionIds": []},
           "tables": {"workspaces": {wid: {"path": path, "title": "turn ws", "sessionIds": [],
                                            "createdAt": now, "updatedAt": now}}}},
          open(store, "w"), ensure_ascii=False, indent=2)
PY
(cd "$VHOME/profiles/$PROFILE" && "$PNPM_BIN" install --silent) >/dev/null 2>&1 || { echo "profile pnpm install 失败"; exit 2; }

nohup env DSH_HOME="$VHOME" YH_OLAP_WORKSPACE_ROOT="$VWS" "$DSH_BIN" --profile "$PROFILE" --port "$PORT" --no-open >"$LOG" 2>&1 &
DASH_PID=$!
TOKEN=""
for _ in $(seq 1 80); do
  TOKEN="$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
  [ -n "$TOKEN" ] && break
  sleep 0.5
done
[ -n "$TOKEN" ] || { echo "实例未就绪（见 $LOG）"; exit 2; }
echo "[turn] 实例已启动 port=${PORT}"

BJ="$VHOME/browser.log"
ego-browser nodejs >"$BJ" 2>&1 <<EGOEOF
const BASE = "${BASE}"; const TOKEN = "${TOKEN}";
const task = await taskSpace("yh-olap turn probe " + Date.now());
const page = task.page("p1");
const log = (...a) => console.log(...a);
const dismissOnboarding = async () => {
  for (let i = 0; i < 3; i++) {
    try { await page.click('loc=role:button[name="继续"]', { timeout: 1500 }); } catch (e) {}
    await page.waitForTimeout(700);
    const open = await page.evaluate(() => [...document.querySelectorAll('[role=dialog]')].some(d => /预览版说明/.test(d.textContent || '')))
    if (!open) return true;
  }
  return !(await page.evaluate(() => [...document.querySelectorAll('[role=dialog]')].some(d => /预览版说明/.test(d.textContent || ''))));
};
await page.goto(BASE + "/?token=" + TOKEN + "&r=" + Date.now(), { timeout: 30000 });
await page.waitForTimeout(3500);
log('onboardingClosed=' + (await dismissOnboarding()));
// 建/选会话：优先点 workspace 的「中新建会话」按钮
let has = await page.evaluate(() => !!document.querySelector('[data-slot="rightbar"] [data-sidebar-right-session]'));
if (!has) {
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button[aria-label]')].filter(b => /新建会话/.test(b.getAttribute('aria-label')));
    const b = btns.find(x => /中新建会话/.test(x.getAttribute('aria-label'))) || btns[0];
    if (b) { b.click(); return b.getAttribute('aria-label'); }
    return null;
  });
  await page.waitForTimeout(2500);
}
// 展开右侧栏并打开 OLAP 工具（保证 olap 面板在线）
const expanded = await page.evaluate(() => { const p = document.querySelector('[data-sidebar-right-panel]'); return !!p && p.getAttribute('aria-hidden') !== 'true'; });
if (!expanded) { try { await page.click('loc=role:button[name="打开右侧边栏"]', { timeout: 2000 }); } catch (e) {} await page.waitForTimeout(1200); }
for (let i = 0; i < 2 && !(await page.evaluate(() => !!document.querySelector('[data-yh-olap-root]'))); i++) {
  try { await page.click('text=OLAP 查询', { timeout: 2500 }); } catch (e) {}
  await page.waitForTimeout(2000);
}
log('panel=' + (await page.evaluate(() => !!document.querySelector('[data-yh-olap-root]'))));
// 输入 /olap 指令
await page.evaluate(() => { const ci = document.querySelector('[data-composer-input]'); if (!ci) return; ci.focus(); try { const s = window.getSelection(); const r = document.createRange(); r.selectNodeContents(ci); s.removeAllRanges(); s.addRange(r); } catch (e) {} });
await page.keyboard.press('Backspace').catch(() => {});
await page.waitForTimeout(300);
try { await page.click('[data-composer-input]'); } catch (e) {}
const PROMPT = "/olap Call the olap tool with action=state and no sessionId. Then reply with one short English line stating the number of tabs. Do not call any other tool.";
await page.keyboard.type(PROMPT);
await page.waitForTimeout(2000);
await page.keyboard.press('Enter').catch(() => {});
await page.waitForTimeout(800);
await page.keyboard.press('Enter').catch(() => {});
let last = -1, stable = 0;
let sawPrompt = false;
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(3000);
  const body = await page.evaluate(() => document.body.innerText || '');
  if (!sawPrompt && body.includes('olap')) sawPrompt = true;
  if (body.includes('处理失败') || body.includes('本轮运行失败') || body.includes('unknown prompt variable')) break;
  if (body.includes('已完成')) { if (body.length === last) { stable += 1; if (stable >= 1) break; } else stable = 0; }
  last = body.length;
}
const body = await page.evaluate(() => document.body.innerText || '');
console.log('sawPrompt=' + sawPrompt);
console.log('TURN_BODY ' + JSON.stringify(body.slice(-4000)));
await task.finish();
EGOEOF

if ! grep -q 'TURN_BODY' "$BJ"; then
  echo "FAIL ego-browser 未产出结果；尾部：$(tail -3 "$BJ" 2>/dev/null | tr '\n' ' ')"
  exit 1
fi
BODY="$(grep 'TURN_BODY' "$BJ" | sed 's/^TURN_BODY //' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s))}catch(e){console.log(s)}})')"
FAIL=0
pass() { echo "  PASS  $*"; }
bad() { FAIL=1; echo "  FAIL  $*"; }
# 环境性阻断（不是插件问题）：模型额度/余额/限流。区分出来，避免误判兼容性回归。
case "$BODY" in
  *"额度已用尽"*|*"额度不足"*|*"余额不足"*|*"Insufficient Balance"*|*"quota"*|*"rate limit"*)
    echo "  SKIP  模型账号额度/余额/限流不足，本轮无法跑完（环境问题，非插件失败）"
    exit 2
    ;;
esac
case "$BODY" in
  *"处理失败"*|*"本轮运行失败"*|*"unknown prompt variable"*|*"SessionCreateError"*)
    bad "本轮出现失败标记（兼容性回归）；body 尾部：$(printf '%s' "$BODY" | tail -c 400 | tr '\n' ' ')" ;;
  *) pass "无「处理失败 / unknown prompt variable / 本轮运行失败 / SessionCreateError」" ;;
esac
case "$BODY" in
  *"已完成"*) pass "本轮已完成" ;;
  *) bad "未见「已完成」——本轮没有正常收尾" ;;
esac
case "$BODY" in
  *"tabs="*) pass "olap 工具结果回显 tabs=" ;;
  *) bad "未见 olap 工具 tabs= 回显" ;;
esac
case "$BODY" in
  *"Failed to load plugins"*) bad "前端出现 Failed to load plugins" ;;
  *) pass "前端无插件加载失败" ;;
esac
[ "$FAIL" = "0" ] && { echo "  ALL PASS"; exit 0; } || exit 1
