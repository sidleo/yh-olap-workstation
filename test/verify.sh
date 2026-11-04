#!/usr/bin/env bash
# test/verify.sh —— dsh-yh-olap-workstation（右侧栏工具版）运行时验证
#
# 在**隔离 DSH_HOME + 临时 profile + 独立工作区**上启动真实实例，验证：
#   1) 构建/静态检查/单测；
#   2) profile 组合干净（无 skip、无 yh-data preset 劫持）；
#   3) Host RPC（含桌面 App 必需的 CORS 预检）、favicon 不再被劫持；
#   4) Client boot graph 含插件；右侧栏引导页出现 OLAP 工具、点击出 tab、CM 编辑器挂载；
#   5) 编辑器写入 → 自动保存到隔离工作区 → 刷新恢复；
#   6) 编辑器补全含 impala 函数（ndv）。
#
# 用法：
#   bash test/verify.sh                 # 全量（需要 ego-browser；没有则 REQUIRE_BROWSER=0 跳过浏览器段）
#   KEEP=1 bash test/verify.sh          # 失败排查：保留实例/home，打印清理命令
#   PORT=5275 bash test/verify.sh       # 换端口
#   REQUIRE_BROWSER=0 bash test/verify.sh
#
# 红线：不触碰真实 ~/.dsh、不读写 ~/.yh-olap/workspace（用 YH_OLAP_WORKSPACE_ROOT 重定向）。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$REPO/plugin"
# macOS 的 /tmp、/var 是指向 /private/* 的符号链接；workspace attach 要求路径与 realpath 一致，
# 故先解析 TMPDIR 的规范路径，测试目录一律建在规范路径下。
TMPBASE="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P || echo /tmp)"
VHOME="${YH_VERIFY_HOME:-$TMPBASE/yh-olap-verify-home}"
VWS="${YH_VERIFY_WS:-$TMPBASE/yh-olap-verify-ws}"
PROFILE="yh-olap-verify"
PORT="${PORT:-5275}"
DSH_BIN="${DSH_BIN:-dsh}"
PNPM_BIN="${PNPM_BIN:-pnpm}"
BASE="http://127.0.0.1:${PORT}"
BBASE="http://localhost:${PORT}"
LOG="$VHOME/dsh.log"
REQUIRE_BROWSER="${REQUIRE_BROWSER:-1}"
KEEP="${KEEP:-0}"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL  %s\n' "$*"; }
say() { printf '%s\n' "$*"; }
head2() { printf '\n== %s ==\n' "$*"; }

DASH_PID=""
cleanup() {
  if [ "$KEEP" = "1" ]; then
    say "[keep] 实例 PID=${DASH_PID:-?}  home=$VHOME  log=$LOG"
    say "[keep] 停止：kill ${DASH_PID:-<pid>}"
    return
  fi
  if [ -n "$DASH_PID" ]; then
    kill "$DASH_PID" 2>/dev/null || true
    sleep 0.8
    pkill -f "profile ${PROFILE} --port ${PORT}" 2>/dev/null || true
  fi
  rm -rf "$VHOME" "$VWS"
}
trap cleanup EXIT

# ---------- 0. 构建 / 静态 / 单测 ----------
head2 "0. 构建与单测"
if [ ! -d "$PLUGIN/node_modules" ]; then
  say "  installing plugin devDependencies ..."
  (cd "$PLUGIN" && npm install --no-audit --no-fund --silent) || { bad "npm install 失败"; exit 1; }
fi
(cd "$PLUGIN" && node build.mjs) >/dev/null 2>&1 || { bad "client 构建失败"; exit 1; }
ok "client 构建成功"
node --check "$PLUGIN/src/host.js" >/dev/null 2>&1 && ok "host.js 语法" || bad "host.js 语法"
node --check "$PLUGIN/dist/client.js" >/dev/null 2>&1 && ok "dist/client.js 语法" || bad "dist/client.js 语法"
if (cd "$REPO" && node --test test/unit/*.test.mjs >/tmp/yh-olap-unit.log 2>&1); then
  ok "单测通过（$(grep -oE 'tests [0-9]+' /tmp/yh-olap-unit.log | tail -1)）"
else
  bad "单测失败（见 /tmp/yh-olap-unit.log）"
fi
node --check "$PLUGIN/build.mjs" >/dev/null 2>&1 && ok "build.mjs 语法" || bad "build.mjs 语法"

# ---------- 1. 搭隔离环境 ----------
head2 "1. 隔离 DSH_HOME / profile / 工作区"
rm -rf "$VHOME" "$VWS"
mkdir -p "$VHOME/profiles/$PROFILE" "$VHOME/storages" "$VWS"
[ -f "$HOME/.dsh/settings.yaml" ] && cp "$HOME/.dsh/settings.yaml" "$VHOME/settings.yaml"
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
           "tables": {"workspaces": {wid: {"path": path, "title": "verify ws", "sessionIds": [],
                                            "createdAt": now, "updatedAt": now}}}},
          open(store, "w"), ensure_ascii=False, indent=2)
PY
(cd "$VHOME/profiles/$PROFILE" && "$PNPM_BIN" install --silent) >/dev/null 2>&1 || { bad "profile pnpm install 失败"; exit 1; }
ok "临时 profile 安装完成（${VHOME}）"

# ---------- 2. 启动 ----------
head2 "2. 启动实例（port ${PORT}）"
nohup env DSH_HOME="$VHOME" YH_OLAP_WORKSPACE_ROOT="$VWS" "$DSH_BIN" --profile "$PROFILE" --port "$PORT" --no-open >"$LOG" 2>&1 &
DASH_PID=$!
TOKEN=""
for _ in $(seq 1 80); do
  TOKEN="$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
  [ -n "$TOKEN" ] && break
  kill -0 "$DASH_PID" 2>/dev/null || break
  sleep 0.5
done
if [ -n "$TOKEN" ] && kill -0 "$DASH_PID" 2>/dev/null; then ok "实例已启动（token ${#TOKEN} chars）"; else bad "实例未启动（见 ${LOG}）"; exit 1; fi
if grep -q 'skipping profile bundle' "$LOG" 2>/dev/null; then bad "兼容门 skip 了插件 bundle"; else ok "无 skipping profile bundle"; fi
if grep -nE 'warning: [0-9]+ entry did not activate|ReferenceError|TypeError' "$LOG" >/dev/null 2>&1; then
  bad "启动日志有未激活/异常条目：$(grep -nE 'warning: [0-9]+ entry did not activate|ReferenceError|TypeError' "$LOG" | head -2 | tr '\n' ' ')"
else ok "启动日志无未激活/异常条目"; fi

# ---------- 3. profile 组合 ----------
head2 "3. profile 组合"
DSH_HOME="$VHOME" "$DSH_BIN" --profile "$PROFILE" --dump-config >"$VHOME/dump.yml" 2>"$VHOME/dump.err"
if [ -s "$VHOME/dump.err" ]; then bad "dump-config stderr 非空：$(head -2 "$VHOME/dump.err" | tr '\n' ' ')"; else ok "dump-config stderr 为空"; fi
grep -q 'id: yh-olap-workstation' "$VHOME/dump.yml" && ok "插件 entry 在组合树中" || bad "插件 entry 不在组合树中"
grep -q 'yh-data' "$VHOME/dump.yml" && bad "仍存在 yh-data preset（不应劫持主 profile）" || ok "无 yh-data preset 劫持"
grep -q 'default: standard' "$VHOME/dump.yml" && ok "默认 preset 未被覆盖（standard）" || say "  WARN  未在 dump 中匹配到 default: standard（不同 profile 模板可能用别的默认）"

# ---------- 4. Host RPC / CORS / 路由 ----------
head2 "4. Host RPC / CORS / 路由"
rpc() { curl -s -o "$VHOME/rpc.out" -w '%{http_code}' -X POST "$BASE/api/yh-olap/rpc" -H 'content-type: application/json' -d "$1"; }
CODE="$(rpc '{"method":"olap.mode.get","args":{"sessionId":""}}')"
[ "$CODE" = "200" ] && grep -q '"ok":true' "$VHOME/rpc.out" && ok "olap.mode.get → 200 ok" || bad "olap.mode.get 异常（code=$CODE body=$(head -c 120 "$VHOME/rpc.out")）"
CODE="$(rpc '{"method":"no.such.method","args":{}}')"
[ "$CODE" = "404" ] && ok "未知方法 → 404" || bad "未知方法应为 404（got ${CODE}）"
CODE="$(rpc '{"method":"ws.sessions.list","args":{}}')"
[ "$CODE" = "404" ] && ok "已删除的 ws.sessions.list → 404" || bad "ws.sessions.list 应已删除（got ${CODE}）"
HDR="$(curl -s -D - -o /dev/null -X OPTIONS "$BASE/api/yh-olap/rpc" -H 'Origin: dsh-app://app' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type')"
echo "$HDR" | grep -qi '^HTTP/1.1 204' && echo "$HDR" | grep -qi 'access-control-allow-origin: dsh-app://app' && ok "桌面 App 预检：204 + CORS 回显" || bad "桌面 App 预检失败：$(echo "$HDR" | head -3 | tr '\n' ' ')"
HDR="$(curl -s -D - -o /dev/null -X POST "$BASE/api/yh-olap/rpc" -H 'Origin: dsh-app://app' -H 'content-type: application/json' -d '{"method":"olap.mode.get","args":{}}')"
echo "$HDR" | grep -qi 'access-control-allow-origin: dsh-app://app' && ok "桌面 App 实际 POST 带 CORS 头" || bad "桌面 App POST 缺 CORS 头"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE/api/yh-olap/rpc" -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST')"
[ "$CODE" = "403" ] && ok "非法 Origin 预检 → 403" || bad "非法 Origin 预检应为 403（got ${CODE}）"
CT="$(curl -s -o "$VHOME/favicon" -w '%{content_type}' "$BASE/favicon.svg")"
echo "$CT" | grep -qi 'svg' && ok "favicon 是 DSH 自带 SVG（未被插件劫持）" || bad "favicon 仍被劫持/非 SVG（ct=${CT}）"

# ---------- 5. boot graph / client bundle ----------
head2 "5. Client boot graph"
JAR="$VHOME/cookies.txt"; rm -f "$JAR"
CODE_NO_TOKEN="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
[ "$CODE_NO_TOKEN" = "401" ] && ok "无 token 首页 401（鉴权生效）" || bad "无 token 首页期望 401（got ${CODE_NO_TOKEN}）"
EXCH="$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" "$BASE/?token=$TOKEN")"
[ "$EXCH" = "303" ] && ok "token 换 cookie（303）" || bad "token 交换期望 303（got ${EXCH}）"
CODE="$(curl -s -b "$JAR" -o "$VHOME/index.html" -w '%{http_code}' "$BASE/")"
[ "$CODE" = "200" ] && grep -q '__DSH_BOOT__' "$VHOME/index.html" && ok "首页 200 且含 __DSH_BOOT__" || bad "首页异常（code=${CODE}）"
if grep -q 'dsh-yh-olap-workstation' "$VHOME/index.html"; then ok "boot graph 含插件 client 行"; else bad "boot graph 缺少插件 client 行"; fi
BUNDLE_URL="$(grep -o 'plugins/??dsh-yh-olap-workstation/client.js[^"\\]*' "$VHOME/index.html" | head -1 | sed 's/&amp;/\&/g')"
if [ -n "$BUNDLE_URL" ]; then
  CODE="$(curl -s --globoff -b "$JAR" -o "$VHOME/client.js" -w '%{http_code}' "$BASE/$BUNDLE_URL")"
  SIZE="$(wc -c <"$VHOME/client.js" | tr -d ' ')"
  [ "$CODE" = "200" ] && [ "$SIZE" -gt 100000 ] && grep -q '__ModuleLoader__' "$VHOME/client.js" && ok "client bundle 可取且为 module-loader 格式（${SIZE} B）" || bad "client bundle 异常（code=${CODE} size=${SIZE}）"
else
  bad "index 中找不到 client bundle URL"
fi
if grep -q '__DSH_TRANSPORT__' "$VHOME/client.js" 2>/dev/null; then ok "client bundle 含桌面 RPC 基址适配"; else bad "client bundle 缺少 __DSH_TRANSPORT__ 基址适配"; fi


# ---------- 6. 浏览器断言 ----------
head2 "6. 浏览器断言（ego-browser）"
if [ "$REQUIRE_BROWSER" = "0" ]; then
  say "  SKIP  按要求跳过"
elif ! command -v ego-browser >/dev/null 2>&1; then
  say "  SKIP  没有 ego-browser 命令"
else
  BROWSER_OUT="$VHOME/browser.log"
  ego-browser nodejs >"$BROWSER_OUT" 2>&1 <<EOF
const BASE = "${BBASE}"
const TOKEN = "${TOKEN}"
const task = await taskSpace("yh-olap verify " + Date.now())
const page = task.page("p1")
const out = []
const log = (k, v) => out.push(k + '=' + String(v))
const dismissOnboarding = async () => { try { await page.click('loc=role:button[name="继续"]', { timeout: 1200 }) } catch (e) {} }
const ensureSession = async () => {
  let ok = await page.evaluate(() => !!document.querySelector('[data-slot="rightbar"] [data-sidebar-right-session]'))
  if (ok) return true
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button[aria-label]')].filter(b => /新建会话/.test(b.getAttribute('aria-label')))
    const b = btns.find(x => /中新建会话/.test(x.getAttribute('aria-label'))) || btns[0]
    if (b) { b.click(); return b.getAttribute('aria-label') }
    return null
  })
  await page.waitForTimeout(2500)
  return await page.evaluate(() => !!document.querySelector('[data-slot="rightbar"] [data-sidebar-right-session]'))
}
const ensureRightbar = async () => {
  const expanded = await page.evaluate(() => { const p = document.querySelector('[data-sidebar-right-panel]'); return !!p && p.getAttribute('aria-hidden') !== 'true' })
  if (!expanded) { try { await page.click('loc=role:button[name="打开右侧边栏"]', { timeout: 2000 }) } catch (e) {} await page.waitForTimeout(1200) }
}
await page.goto(BASE + "/?token=" + TOKEN + "&r=" + Date.now(), { timeout: 30000 })
await page.waitForTimeout(3500)
await dismissOnboarding()
log('session', await ensureSession())
await ensureRightbar()
const guide = await page.evaluate(() => (document.querySelector('[data-slot="rightbar"]') || {}).innerText || '')
log('guideHasOlap', guide.includes('OLAP 查询'))
let panel = await page.evaluate(() => !!document.querySelector('[data-yh-olap-root]'))
if (!panel) {
  try { await page.click('text=OLAP 查询', { timeout: 2500 }) } catch (e) {}
  await page.waitForTimeout(2500)
  panel = await page.evaluate(() => !!document.querySelector('[data-yh-olap-root]'))
}
log('panel', panel)
log('cm', await page.evaluate(() => !!document.querySelector('.cm-editor')))
log('tabChip', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('[data-dockkit-tab]')].map(e => e.textContent.trim()))))
const rect = await page.evaluate(() => { const el = document.querySelector('.cm-content'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + 30, y: r.top + 20 } })
if (rect) {
  await page.mouse.click(rect.x, rect.y, { label: 'focus editor' })
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('select 1 as final_col', { delay: 15 })
  await page.waitForTimeout(1200)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('select nd', { delay: 30 })
  await page.waitForTimeout(1200)
}
log('completion', await page.evaluate(() => {
  const el = document.querySelector('.cm-tooltip-autocomplete')
  return el ? [...el.querySelectorAll('li')].map(li => li.textContent).slice(0, 10).join(',') : ''
}))
// 补全类型列（函数/表/字段）应右对齐：所有 detail 的右边缘应一致
const detailAlign = await page.evaluate(() => {
  const details = [...document.querySelectorAll('.cm-tooltip-autocomplete .cm-completionDetail')]
  const rights = details.map(function (d) { return Math.round(d.getBoundingClientRect().right) })
  return { count: rights.length, spread: rights.length ? Math.max.apply(null, rights) - Math.min.apply(null, rights) : -1, rights: rights.slice(0, 6) }
})
log('completionDetailCount', detailAlign.count)
log('completionDetailSpread', detailAlign.spread)
// Tab 接受补全（新增交互）：弹层打开时 Tab 应选中当前项并插入，而不是缩进
let docAfterTab = ''
if (rect) {
  await page.keyboard.press('Tab')
  await page.waitForTimeout(600)
  docAfterTab = await page.evaluate(() => (document.querySelector('.cm-content') || {}).innerText || '')
}
log('docAfterTab', JSON.stringify(docAfterTab))
log('completionOpenAfterTab', await page.evaluate(() => !!document.querySelector('.cm-tooltip-autocomplete')))
// Tab 行为回归（用户约定：无选区不整行缩进；有选区才整行缩进/反缩进）
const readDoc = () => page.evaluate(() => (document.querySelector('.cm-content') || {}).textContent || '')
if (rect) {
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('select 1', { delay: 10 })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  await page.waitForTimeout(300)
  const collapsedTab = await readDoc()
  log('collapsedTabNoLineIndent', collapsedTab.indexOf('select 1') === 0 && !/^\s/.test(collapsedTab))
  log('collapsedTabSoftInsert', collapsedTab !== 'select 1')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Tab')
  await page.waitForTimeout(300)
  const selectedTab = await readDoc()
  log('selectedTabIndented', selectedTab.indexOf('    select 1') === 0)
  await page.keyboard.press('Shift+Tab')
  await page.waitForTimeout(300)
  const selectedShiftTab = await readDoc()
  log('selectedShiftTabRestored', selectedShiftTab.indexOf('select 1') === 0)
  await page.keyboard.press('ArrowRight')
  const beforeCollapsedShift = await readDoc()
  await page.keyboard.press('Shift+Tab')
  await page.waitForTimeout(300)
  const afterCollapsedShift = await readDoc()
  log('collapsedShiftTabNoop', beforeCollapsedShift === afterCollapsedShift)
}
// 深色模式回归（用户反馈：深色下补全白字白底/选中行消失）
await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
await page.waitForTimeout(800)
log('darkPanelTheme', await page.evaluate(() => { const p = document.querySelector('.yh-olap-panel'); return p ? p.getAttribute('data-yh-theme') : null }))
if (rect) {
  await page.mouse.click(rect.x, rect.y)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('select dd', { delay: 30 })
  await page.waitForTimeout(1400)
}
const darkColors = await page.evaluate(() => {
  const parse = function (c) { const m = String(c).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null }
  const blend = function (fg, bg) { return fg && bg ? { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 } : null }
  const lum = function (c) { if (!c) return null; const f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b) }
  const contrast = function (a, b) { const l1 = Math.max(lum(a), lum(b)); const l2 = Math.min(lum(a), lum(b)); return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100 }
  const tip = document.querySelector('.cm-tooltip-autocomplete')
  const lis = tip ? Array.from(tip.querySelectorAll('ul > li')) : []
  const sel = lis.find(function (li) { return li.getAttribute('aria-selected') === 'true' })
  const normal = lis.find(function (li) { return li.getAttribute('aria-selected') !== 'true' })
  const tipBg = tip ? parse(getComputedStyle(tip).backgroundColor) : null
  const selBg = sel ? blend(parse(getComputedStyle(sel).backgroundColor), tipBg) : null
  const selFg = sel ? blend(parse(getComputedStyle(sel).color), selBg) : null
  const normFg = normal ? blend(parse(getComputedStyle(normal).color), tipBg) : null
  return {
    tipBg: tip ? getComputedStyle(tip).backgroundColor : '',
    tipDark: tipBg ? lum(tipBg) < 0.35 : false,
    selContrast: selBg && selFg ? contrast(selBg, selFg) : 0,
    normalContrast: tipBg && normFg ? contrast(tipBg, normFg) : 0,
  }
})
log('darkTipDark', darkColors.tipDark)
log('darkSelContrast', darkColors.selContrast)
log('darkNormalContrast', darkColors.normalContrast)
await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
await page.waitForTimeout(600)
// 查找面板：中文化 + 两行紧凑布局
if (rect) {
  await page.mouse.click(rect.x, rect.y)
  await page.keyboard.press('ControlOrMeta+f')
  await page.waitForTimeout(700)
}
const sp = await page.evaluate(() => {
  const p = document.querySelector('.cm-panel.cm-search')
  if (!p) return { found: false }
  const search = p.querySelector('input.cm-textfield[name=search]')
  const replace = p.querySelector('input.cm-textfield[name=replace]')
  const btns = Array.from(p.querySelectorAll('button')).map(function (b) { return b.textContent.trim() })
  const labels = Array.from(p.querySelectorAll('label')).map(function (l) { return l.textContent.trim() })
  return {
    found: true,
    placeholders: Array.from(p.querySelectorAll('input.cm-textfield')).map(function (i) { return i.placeholder }),
    buttons: btns,
    labels: labels,
    twoRows: !!(search && replace && search.getBoundingClientRect().y < replace.getBoundingClientRect().y),
    stacked: !!(search && replace && replace.getBoundingClientRect().top >= search.getBoundingClientRect().bottom - 0.5),
    searchWidth: search ? Math.round(search.getBoundingClientRect().width) : 0,
  }
})
log('searchPanelLocalized', sp.found && sp.placeholders.join(',') === '查找,替换' &&
  ['下一个', '上一个', '全部选中', '替换', '全部替换'].every(function (t) { return sp.buttons.indexOf(t) >= 0 }) &&
  ['区分大小写', '正则', '全词匹配'].every(function (t) { return sp.labels.indexOf(t) >= 0 }))
log('searchPanelTwoRows', !!sp.twoRows)
log('searchInputsStacked', !!sp.stacked)
log('searchPanelInputWidth', sp.searchWidth)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
// 回归：OLAP 打开不得让 DSH 页面出现滚动（历史 bug：CM tooltip 容器被主题 height:100% 撑出视口）
log('scrollH', await page.evaluate(() => document.documentElement.scrollHeight))
log('innerH', await page.evaluate(() => window.innerHeight))
log('scrollTopAfter', await page.evaluate(() => { window.scrollTo(0, 300); const t = document.documentElement.scrollTop || document.body.scrollTop || 0; window.scrollTo(0, 0); return t }))
// 最终内容：写回 final_col 并等自动保存（800ms 防抖）落盘，再刷新验证恢复
if (rect) {
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('select 1 as final_col', { delay: 15 })
  await page.waitForTimeout(1800)
}
await page.reload()
await page.waitForTimeout(3500)
await dismissOnboarding()
await ensureRightbar()
log('restoredDoc', await page.evaluate(() => (document.querySelector('.cm-content') || {}).innerText || ''))
console.log('BROWSER_JSON ' + JSON.stringify(out))
await task.finish()
EOF
  if grep -q 'BROWSER_JSON' "$BROWSER_OUT"; then
    J="$(grep 'BROWSER_JSON' "$BROWSER_OUT" | sed 's/^BROWSER_JSON //')"
    echo "$J" | grep -q '"session=true"' && ok "浏览器内已创建/打开会话" || bad "浏览器内没有会话（$(echo "$J" | head -c 200)）"
    echo "$J" | grep -q '"guideHasOlap=true"' && ok "右侧栏引导页有 OLAP 工具卡" || bad "引导页缺少 OLAP 工具卡（$(head -c 300 "$BROWSER_OUT")）"
    echo "$J" | grep -q '"panel=true"' && ok "点击后 OLAP tab 正文挂载" || bad "OLAP tab 正文未挂载"
    echo "$J" | grep -q '"cm=true"' && ok "CodeMirror 编辑器挂载" || bad "CodeMirror 编辑器未挂载"
    echo "$J" | grep -q 'ndv' && ok "impala 补全包含函数 ndv" || bad "impala 补全缺少 ndv（$(echo "$J" | grep -o '"completion=[^,]*' | head -1)）"
    DCNT="$(echo "$J" | grep -o '"completionDetailCount=[0-9]*"' | head -1 | cut -d= -f2 | tr -d '"')"
    DSPREAD="$(echo "$J" | grep -o '"completionDetailSpread=[0-9-]*"' | head -1 | cut -d= -f2 | tr -d '"')"
    if [ -n "$DCNT" ] && [ "$DCNT" -ge 2 ] && [ -n "$DSPREAD" ] && [ "$DSPREAD" -le 1 ]; then
      ok "补全类型列右对齐（${DCNT} 项，右边缘差 ${DSPREAD}px）"
    else
      bad "补全类型列未右对齐（count=${DCNT:-?} spread=${DSPREAD:-?}）"
    fi
    echo "$J" | grep -q '"docAfterTab=.*ndv()' && ok "Tab 接受补全（插入 ndv()）" || bad "Tab 未接受补全（$(echo "$J" | grep -o '"docAfterTab=[^,]*' | head -1)）"
    echo "$J" | grep -q '"completionOpenAfterTab=false"' && ok "Tab 接受后补全弹层关闭" || bad "Tab 接受后补全弹层未关闭"
    echo "$J" | grep -q '"collapsedTabNoLineIndent=true"' && ok "无选区 Tab 不整行缩进" || bad "无选区 Tab 仍整行缩进"
    echo "$J" | grep -q '"collapsedTabSoftInsert=true"' && ok "无选区 Tab 在光标处补软缩进" || bad "无选区 Tab 未在光标处补缩进"
    echo "$J" | grep -q '"selectedTabIndented=true"' && ok "有选区 Tab 整行缩进（4 空格）" || bad "有选区 Tab 未整行缩进"
    echo "$J" | grep -q '"selectedShiftTabRestored=true"' && ok "有选区 Shift+Tab 反缩进还原" || bad "有选区 Shift+Tab 未还原"
    echo "$J" | grep -q '"collapsedShiftTabNoop=true"' && ok "无选区 Shift+Tab 不整行反缩进" || bad "无选区 Shift+Tab 仍整行反缩进"
    echo "$J" | grep -q '"darkPanelTheme=dark"' && ok "深色模式下方面板主题切换" || bad "深色模式下方面板主题未切换（$(echo "$J" | grep -o '"darkPanelTheme=[^,]*' | head -1)）"
    echo "$J" | grep -q '"darkTipDark=true"' && ok "深色模式补全弹层背景为深色" || bad "深色模式补全弹层背景仍为浅色"
    DS="$(echo "$J" | grep -o '"darkSelContrast=[0-9.]*"' | head -1 | cut -d= -f2 | tr -d '"')"
    DN="$(echo "$J" | grep -o '"darkNormalContrast=[0-9.]*"' | head -1 | cut -d= -f2 | tr -d '"')"
    if awk -v v="${DS:-0}" 'BEGIN{exit !(v>=3)}'; then ok "深色模式补全选中行对比度 ${DS}（>=3）"; else bad "深色模式补全选中行对比度过低（${DS:-?}）"; fi
    if awk -v v="${DN:-0}" 'BEGIN{exit !(v>=3)}'; then ok "深色模式补全普通行对比度 ${DN}（>=3）"; else bad "深色模式补全普通行对比度过低（${DN:-?}）"; fi
    echo "$J" | grep -q "\"searchPanelLocalized=true\"" && ok "查找面板已中文化（查找/替换/下一个/区分大小写…）" || bad "查找面板未中文化（$(echo "$J" | grep -o "\"searchPanelLocalized=[^,]*\"" | head -1)）"
    echo "$J" | grep -q "\"searchPanelTwoRows=true\"" && ok "查找面板两行紧凑布局" || bad "查找面板不是两行布局"
    echo "$J" | grep -q "\"searchInputsStacked=true\"" && ok "查找/替换输入框上下排列（非同一行）" || bad "查找/替换输入框仍在同一行"
    SW="$(echo "$J" | grep -o "\"searchPanelInputWidth=[0-9]*\"" | head -1 | cut -d= -f2 | tr -d "\"")"
    if [ -n "$SW" ] && [ "$SW" -ge 140 ]; then ok "查找输入框自适应宽度（${SW}px）"; else bad "查找输入框过窄（${SW:-?}px）"; fi
    SH="$(echo "$J" | grep -o '"scrollH=[0-9]*"' | head -1 | cut -d= -f2 | tr -d '"')"
    IH="$(echo "$J" | grep -o '"innerH=[0-9]*"' | head -1 | cut -d= -f2 | tr -d '"')"
    ST="$(echo "$J" | grep -o '"scrollTopAfter=[0-9-]*"' | head -1 | cut -d= -f2 | tr -d '"')"
    if [ -n "$SH" ] && [ -n "$IH" ] && [ "$SH" -le $((IH + 2)) ] && [ "$ST" = "0" ]; then
      ok "OLAP 打开后页面无滚动（scrollH=${SH} innerH=${IH}）"
    else
      bad "OLAP 打开后页面出现滚动（scrollH=${SH:-?} innerH=${IH:-?} scrollTop=${ST:-?}）"
    fi
    echo "$J" | grep -q 'final_col' && ok "刷新后 SQL 从隔离工作区恢复" || bad "刷新后 SQL 未恢复"
    if find "$VWS" -name '*.sql' -exec grep -qs 'final_col' {} \; 2>/dev/null; then ok "工作区落盘（${VWS}）"; else bad "隔离工作区未见落盘文件"; fi
  else
    bad "浏览器脚本失败（$(tail -3 "$BROWSER_OUT" | tr '\n' ' ')）"
  fi
fi

# ---------- 汇总 ----------
head2 "汇总"
printf '  PASS=%d  FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ] && { say "  ALL PASS"; exit 0; } || { say "  FAILED"; exit 1; }
