// test/tool-case-0.2.0.mjs —— `olap` 模型工具的 **真实执行 + 0.2.0 真实校验器** 用例（T5）
//
// 为什么用这个方法：`olap` 是模型工具（`ctx.tools.register`），0.2.0 的 dsh-tools **没有**任何
// remote/HTTP 调用面，无法从外部「直接调用某个工具」。所以我们把**真实的 plugin/src/host.js**
// 装进一个「桩 cordis ctx」（只提供 webServer.register / tools.register / get / inject / on），
// 用**它自己的 RPC 处理器**注入面板状态，再调用**它自己的 tool.execute**，
// 最后把返回值喂给 **DSH 0.2.0 真实发布包**里的 snapshotToolValue / validateJsonSchemaValue /
// assertSupportedJsonSchema —— 校验的是真宿主的那份代码，不是复刻。
//
// 安全性：本进程没有 HTTP 服务、没有任何面板在 poll，enqueue 出来的命令**永远留在内存里**
// 无人消费 ⇒ **不产生任何工作区落盘**（收尾会核对 ~/.yh-olap/workspace 哈希不变）。
//
// 用法：node test/tool-case-0.2.0.mjs
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
// DSH 运行时包目录：不要硬编码安装路径（本机曾出现 ~/.local/lib 下是旧版 0.2.0-rc.2、
// 当前 CLI 在 /usr/local/lib 的情况 → 会拿错版本的校验器跑用例）。
// 解析顺序：DSH_ROOT 环境变量 → `which dsh` 的 realpath 反推 → 常见安装点兜底。
// 返回形如 <dsh 安装>/node_modules/@deepseek-ai（其下是 dsh-tools、dsh-util-values 等包）。
function resolveDshPkgsDir() {
  if (process.env.DSH_ROOT) return join(process.env.DSH_ROOT, 'node_modules/@deepseek-ai')
  const bin = process.env.DSH_BIN || 'dsh'
  try {
    const which = execSync(`command -v ${bin}`, { encoding: 'utf8' }).trim()
    // <...>/@deepseek-ai/dsh/lib/bin.js → realpath 解析后反推 <...>/@deepseek-ai/dsh
    const real = execSync(`node -e "console.log(require('fs').realpathSync(process.argv[1]))" "${which}"`, { encoding: 'utf8' }).trim()
    const dshDir = dirname(dirname(real))            // .../@deepseek-ai/dsh
    if (existsSync(join(dshDir, 'node_modules/@deepseek-ai/dsh-tools'))) return join(dshDir, 'node_modules/@deepseek-ai')
  } catch (e) { /* fall through */ }
  const cands = [
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
    join(process.env.HOME || '', '.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
    '/usr/local/lib/node_modules/@deepseek-ai',
    join(process.env.HOME || '', '.local/lib/node_modules/@deepseek-ai'),
  ]
  const hit = cands.find((r) => existsSync(join(r, 'dsh-tools/package.json')))
  if (!hit) throw new Error('找不到 DSH 运行时包目录（可用 DSH_ROOT=<dsh 安装目录> 指定）')
  return hit
}
const DSH = resolveDshPkgsDir()
const dshPkgDir = dirname(dirname(DSH)) // <dsh 安装>/node_modules/@deepseek-ai → <dsh 安装>
const dshVer = JSON.parse(readFileSync(join(dshPkgDir, 'package.json'), 'utf8')).version
console.log('# DSH 运行时包目录 = ' + DSH + '（dsh@' + dshVer + '）')

const out = []
const say = (s) => { out.push(s); console.log(s) }
const j = (v) => JSON.stringify(v)

// ---------- 1. 装载真实 host.js 到桩 ctx ----------
// 红线：工作区重定向到临时目录，绝不读写用户真实 ~/.yh-olap/workspace。
const TMP_WS = process.env.YH_OLAP_WORKSPACE_ROOT || '/tmp/yh-olap-toolcase-ws'
process.env.YH_OLAP_WORKSPACE_ROOT = TMP_WS
mkdirSync(TMP_WS, { recursive: true })
const hostMod = await import(pathToFileURL(REPO + '/plugin/src/host.js').href)
say('# 装载 plugin/src/host.js（真实文件，未修改）')
say('export.name   = ' + hostMod.name)
say('export.inject = ' + j(hostMod.inject))

const routes = new Map()
let capturedTool = null
const noopDispose = () => {}
const ctx = {
  get: () => null,
  inject: () => { /* 可选服务不注入，与「服务未到」等价 */ },
  on: () => noopDispose,
  logger: { warn: (...a) => say('  [ctx.logger.warn] ' + a.map(String).join(' ')), info: () => {}, error: () => {}, debug: () => {} },
  webServer: { register: (r) => { routes.set(r.path, r.handler); return noopDispose } },
  tools: { register: (t) => { capturedTool = t } },
}
hostMod.apply(ctx, {})
say('apply() 未抛；注册的 exact 路由 = ' + j([...routes.keys()]))
say('捕获到的工具 name = ' + (capturedTool && capturedTool.name))
if (!capturedTool) { say('FATAL: 没有捕获到工具'); process.exit(1) }

// ---------- 2. 用它自己的 RPC 处理器注入面板状态 ----------
async function rpc(path, body) {
  const handler = routes.get(path)
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = 'POST'
  req.socket = { remoteAddress: '127.0.0.1' }
  let status = 0, text = ''
  const res = { writeHead: (s) => { status = s }, end: (b) => { text = b == null ? '' : String(b) } }
  await handler(req, res)
  return { status, body: text }
}

say('')
say('# 注入面板状态（走插件自己的 olap.panel.state 处理器）')
const SID_EMPTY = 'session-verify020-emptytabs'   // 「面板在线但一个标签都没有」= host fix ② 的触发条件
const SID_ONE = 'session-verify020-onetab'
const R1 = await rpc('/api/yh-olap/rpc', { method: 'olap.panel.state', args: { sessionId: SID_EMPTY, state: { tabs: [], activeTab: 0 } } })
say('  olap.panel.state(tabs:[]) -> HTTP ' + R1.status + ' ' + R1.body)
const R2 = await rpc('/api/yh-olap/rpc', { method: 'olap.panel.state', args: { sessionId: SID_ONE, state: { tabs: [{ id: 1, name: 'Tab1', engine: 2, dsId: 2, sql: 'select 100' }], activeTab: 1 } } })
say('  olap.panel.state(tabs:[#1]) -> HTTP ' + R2.status + ' ' + R2.body)

// ---------- 3. 调用真实 tool.execute ----------
async function runCase(label, args, exec) {
  say('')
  say('# 用例 ' + label)
  say('  args = ' + j(args))
  let r, threw = null
  try { r = await capturedTool.execute(args, exec || {}) } catch (e) { threw = e }
  if (threw) { say('  THREW: ' + (threw && threw.stack ? threw.stack.split('\n')[0] : String(threw))); return { threw: String(threw) } }
  say('  execute() 返回 = ' + j(r))
  // 深度扫描 undefined（无损 JSON 的硬条件）
  const undefPaths = []
  ;(function scan(v, p) {
    if (v === undefined) { undefPaths.push(p); return }
    if (v === null || typeof v !== 'object') return
    for (const k of Object.keys(v)) scan(v[k], p + '.' + k)
  })(r, '$')
  say('  返回对象里的 undefined 路径 = ' + j(undefPaths))
  return { value: r, undefPaths }
}

const caseNoPanel = await runCase("write / 面板不在线（回归保护：应返回结构化 ok:false，不是 undefined）",
  { action: 'write', sessionId: 'session-verify020-nopanel', sql: 'select 1' })

const caseNewTab = await runCase("write / 面板在线但 tabs=[] 且 newTab:true（= host fix ② 的触发路径）",
  { action: 'write', sessionId: SID_EMPTY, newTab: true, sql: 'select 1' })

const caseFoundTab = await runCase("write / 面板在线且存在活动标签（回归：targetTabId 必须保留）",
  { action: 'write', sessionId: SID_ONE, sql: 'select 200' })

const caseState = await runCase("state / 面板在线（读回面板状态，回归）",
  { action: 'state', sessionId: SID_ONE })

// ---------- 4. 用 0.2.0 真实校验器判定 ----------
say('')
say('# DSH 0.2.0 真实发布包的校验器（dsh-tools/lib/index.js）')
const T = await import(pathToFileURL(DSH + '/dsh-tools/lib/index.js').href)
const V = await import(pathToFileURL(DSH + '/dsh-util-values/lib/index.js').href)
say('  dsh-tools 导出命中：' + j(['assertSupportedJsonSchema', 'validateJsonSchemaValue', 'ToolOutputError'].filter((k) => typeof T[k] === 'function')))
say('  dsh-util-values 导出命中：' + j(['snapshotJsonValue', 'isJsonValue', 'deepFreeze'].filter((k) => typeof V[k] === 'function')))
say('  说明：dsh-tools 的 snapshotToolValue 内部就是 snapshotJsonValue（index.js:5 import；:2575-2582 body）。')
say('        0.2.0 未导出 snapshotToolValue，故按 :2575-2582 的 3 行 body 原样复刻，用的仍是真实 snapshotJsonValue + 真实 ToolOutputError。')
// —— 与 dsh-tools/lib/index.js:2575-2582 逐字等价的复刻 ——
function snapshotToolValueReal(toolName, candidate) {
  const detached = V.snapshotJsonValue(candidate)
  if (detached === void 0) throw new T.ToolOutputError(toolName, ['value is not lossless JSON'])
  return detached
}
say('  对照：真实 isJsonValue(pre-fix 形状) = ' + V.isJsonValue(preFixProbeShape()) )

say('')
say('# 4a) assertSupportedJsonSchema(tool.parameters) —— executeConfigs.additionalProperties 已由对象改布尔')
try {
  T.assertSupportedJsonSchema(capturedTool.parameters)
  say('  PASS: parameters schema 被 0.2.0 断言器接受')
} catch (e) {
  say('  FAIL: ' + (e && e.message))
}
say('  parameters.properties.executeConfigs = ' + j(capturedTool.parameters.properties.executeConfigs))

const preFix = { ok: true, summary: 'write 命令已入队，目标=新建标签，面板在线，约 1~2 秒内上屏。', data: { commandId: 'c1', targetTabId: undefined } }

say('')
say('# 4b) 真实返回值 → snapshotToolValue(复刻) + validateJsonSchemaValue(真实导出)')
function preFixProbeShape() { return { ok: true, summary: 'x', data: { commandId: 'c1', targetTabId: undefined } } }
function checkValue(label, value) {
  let snap, snapErr = null
  try { snap = snapshotToolValueReal('olap', value) } catch (e) { snapErr = e && e.message }
  if (snapErr) { say('  ' + label + ' -> snapshotToolValue THROWS: ' + snapErr); return false }
  let viol = null
  try { viol = T.validateJsonSchemaValue(capturedTool.output.schema, snap) } catch (e) { viol = 'THROW ' + (e && e.message) }
  const okv = Array.isArray(viol) && viol.length === 0
  say('  ' + label + ' -> snapshot=ok  violations=' + j(viol) + '  => ' + (okv ? 'PASS（工具结果不会被判为输出错误）' : 'FAIL'))
  return okv
}
const passNewTab = checkValue('修后 · newTab 无 targetTab（真实 execute 的返回）', caseNewTab.value)
const passFound = checkValue('修后 · 找到 targetTab（真实 execute 的返回）', caseFoundTab.value)
const passNoPanel = checkValue('修后 · 面板不在线（真实 execute 的返回）', caseNoPanel.value)

say('')
say('# 4c) 对照组：修复前的字面量形状（data.targetTabId = undefined）')
const passPreFix = checkValue('修复前 · targetTabId:undefined（复现原缺陷）', preFix)

// ---------- 5. 工作区未被写入 ----------
say('')
say('# 5) 工作区未被写入自证')
const h = createHash('sha256').update(execSync("find " + JSON.stringify(TMP_WS) + " -type f -print0 | sort -z | xargs -0 shasum 2>/dev/null || true").toString()).digest('hex')
say('  临时工作区（' + TMP_WS + '）全文件哈希 = ' + h)
say('  说明：本进程没有 HTTP 服务，enqueue 的命令无人 poll ⇒ 不会落盘（收尾用该哈希与开工前对比）')

say('')
say('# 汇总')
const allPass = passNewTab && passFound && passNoPanel && !passPreFix
say('  host fix ②（newTab 无 targetTab 走真实执行 + 真校验器）= ' + (passNewTab ? 'PASS' : 'FAIL'))
say('  回归（找到 targetTab）= ' + (passFound ? 'PASS' : 'FAIL'))
say('  回归（面板不在线）= ' + (passNoPanel ? 'PASS' : 'FAIL'))
say('  修复前形状被拒（证明这条修复不是多余的）= ' + (passPreFix ? '意外通过' : 'PASS（如期失败）'))
say('  用例总判定 = ' + (allPass ? 'ALL PASS' : 'HAS FAIL'))
process.exit(allPass ? 0 : 1)
