// test/desktop-check.mjs —— 桌面 App（Electron）落地验证（只读）
//
// 前置：DeepSeek Harness.app 以 --remote-debugging-port=9222 运行（App 默认带），且插件已装进
//       当前 desktop profile 并重启过。本脚本通过 CDP 连接已打开页面，验证：
//   A) 页面没有「Failed to load plugins」/ 插件 entry 在 __DSH_BOOT__ 中；
//   B) 桌面 origin（dsh-app://app）下 fetch(streamBaseUrl + '/api/yh-olap/rpc') 真的能拿到
//      {ok:true} —— 这是 CORS + 绝对基址修复的核心证据（相对路径在桌面会 404）；
//   C) （有会话时）右侧栏引导页出现「OLAP 查询」工具卡；已打开时 `.cm-editor` 挂载。
//
// 用法：node test/desktop-check.mjs          # 默认 CDP 9222
//       CDP_PORT=9223 node test/desktop-check.mjs
// 退出码：0 全过 / 1 有失败 / 2 连不上 CDP（App 没开调试端口）。
const CDP = 'http://127.0.0.1:' + (process.env.CDP_PORT || '9222')
let targets
try { targets = await (await fetch(CDP + '/json')).json() } catch (e) { console.error('连不上 CDP：' + CDP); process.exit(2) }
const page = targets.find((t) => t.type === 'page' && /DeepSeek Harness|dsh-app/.test(t.title + ' ' + t.url)) || targets.find((t) => t.type === 'page')
if (!page) { console.error('没有可用的页面 target'); process.exit(2) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const send = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result) }
}
await new Promise((r) => { ws.onopen = r })
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result

const PASS = []
const FAIL = []
const SKIP = []
const check = (name, cond, detail) => { (cond ? PASS : FAIL).push(name + (cond ? '' : ' :: ' + (detail || ''))) }

const info = await evaluate(`(async () => {
  const boot = window.__DSH_BOOT__ || {}
  const rows = (boot.entries || []).map(e => e.id)
  const out = {
    origin: location.origin,
    protocol: location.protocol,
    hasBoot: !!window.__DSH_BOOT__,
    pluginRow: rows.includes('dsh-yh-olap-workstation'),
    failedText: (document.body.innerText || '').includes('Failed to load plugins'),
    transport: (window.__DSH_TRANSPORT__ && window.__DSH_TRANSPORT__.streamBaseUrl) || '',
    rightbarText: (document.querySelector('[data-slot="rightbar"]') || {}).innerText || '',
    hasPanel: !!document.querySelector('[data-yh-olap-root]'),
    hasCm: !!document.querySelector('.cm-editor'),
    hasToolbar: !!document.querySelector('.yh-olap-fbtn'),
    dsOptions: [...document.querySelectorAll('.yh-olap-fsel option')].length,
    schemaNodes: document.querySelectorAll('.yh-olap-ltree .yh-olap-node').length,
  }
  const base = out.transport || ''
  if (base) {
    try {
      const r = await fetch(base + '/api/yh-olap/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'olap.mode.get', args: { sessionId: '' } }), credentials: 'omit' })
      out.rpcStatus = r.status
      out.rpcBody = await r.text()
    } catch (e) { out.rpcError = String(e && e.message) }
  }
  return out
})()`)
const v = info && info.value ? info.value : {}
check('页面无 Failed to load plugins', v.failedText !== true, String(v.failedText))
check('boot graph 含插件 client 行', v.pluginRow === true, 'entries 里没有 dsh-yh-olap-workstation')
check('transport.streamBaseUrl 可用', !!v.transport, String(v.transport))
check('桌面 origin RPC 返回 200', v.rpcStatus === 200, 'status=' + v.rpcStatus + ' err=' + (v.rpcError || ''))
check('桌面 origin RPC 业务 ok', /"ok":true/.test(String(v.rpcBody || '')), String(v.rpcBody || '').slice(0, 120))
if (v.hasPanel) {
  check('OLAP 面板已挂载', true)
  check('CodeMirror 已挂载', v.hasCm === true, '找不到 .cm-editor')
  check('面板工具栏渲染', v.hasToolbar === true)
  check('客户端 RPC 已拉到数据源（桌面 CORS 实证）', Number(v.dsOptions) > 0, 'dsOptions=' + v.dsOptions)
  check('客户端 RPC 已拉到库表（桌面 CORS 实证）', Number(v.schemaNodes) > 0, 'schemaNodes=' + v.schemaNodes)
} else if (String(v.rightbarText || '').trim()) {
  check('右侧栏引导页含 OLAP 工具卡', String(v.rightbarText || '').includes('OLAP 查询'), String(v.rightbarText || '').slice(0, 160))
} else {
  SKIP.push('右侧栏当前收起 / 无会话表面：跳过引导页卡片检查（展开右侧栏后可复跑）')
}
console.log('desktop-check: origin=' + v.origin + '  PASS=' + PASS.length + ' FAIL=' + FAIL.length + ' SKIP=' + SKIP.length)
for (const p of PASS) console.log('  PASS  ' + p)
for (const f of FAIL) console.log('  FAIL  ' + f)
for (const k of SKIP) console.log('  SKIP  ' + k)
ws.close()
process.exit(FAIL.length ? 1 : 0)
