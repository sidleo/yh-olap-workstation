// yh-olap 静态安装包 Host 半（plain ESM，Node 端）。
// 与动态版 src/host.js 同逻辑，机械移植三处差异：
//  ① 网络：spawn curl 直传 argv（无 shell 引号问题；二进制下载用 -D - 拆头拿 Content-Disposition 文件名）。
//  ② 客户端 RPC：POST /api/yh-olap/rpc 分发到 handles/queues 表（等价动态版 harness.handle 的全部方法）。
//  ③ 模型工具：ctx.tools.register(tool)；文件读写用 node:fs（不再有沙箱 fs 服务）。

import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir, rm, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

// ===== WORKSTATION: 独立工作站插件 =====
// 基底 = yh-olap 静态 bundle Host（v1.0.1 vendored）。
// 增量：本地工作区多文件持久化（sql/params/note）、sqlkb 只读浏览、历史会话列表。
// 增量区均带 `// ===== WORKSTATION:` 标记，上游同步时逐个合并。
export const name = 'yh-olap-workstation'
export const inject = ['webServer', 'tools']

const HOME = homedir()
const ACCOUNTS_PATH = HOME + '/.config/yh_bigdata/accounts.json'
const SESSION_PATH = HOME + '/.config/yh_bigdata/session.json'
const CONFIG_PATH = HOME + '/.config/yh_bigdata/config.json'
const BASE_OLAP = 'https://prokongbigdata.yonghui.cn/yh-olap-web'
const BASE_PALLAS = 'https://prokongbigdata.yonghui.cn/pallas/manager'
const MAGPIE_BASE = 'https://prokongbigdata.yonghui.cn/yh-magpie-bridge-manager'
const TTL_MS = 6 * 3600 * 1000

// ===== WORKSTATION: 工作区/知识库/会话 常量与服务句柄 =====
const WORKSPACE_ROOT = join(HOME, '.yh-olap', 'workspace')
const SQLKB_ROOT = join(HOME, '.agents', 'sqlkb')
const KB_ROOT = join(HOME, '.agents', 'kb')
let sessionQuerySvc = null
let sessionStoreSvc = null

let jsidCache = ''
let orgCache = ''
let accountCache = ''
let accountsCache = null
const panelQueues = new Map()
const panelStates = new Map()
let cmdSeq = 0
let paramIdSeq = 0

async function readJson(path, fallback) {
  try {
    const txt = await readFile(path, 'utf8')
    return JSON.parse(txt)
  } catch (e) { return fallback }
}
async function writeJson(path, obj) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(obj, null, 2), 'utf8')
}

async function loginAccount(acc) {
  const code = [
    "from yhlogin import Yhlogin",
    "from yhlogin.service import Olap",
    "import sys,json",
    "r=Yhlogin().login(sys.argv[1],sys.argv[2],sys.argv[3],Olap)",
    "print(json.dumps({'js':r.get('jsessionid') or ''}))",
  ].join(';')
  const out = await new Promise((resolve) => {
    const child = spawn('python3', ['-c', code, acc.username, acc.password, acc.otp_key || ''])
    let so = ''
    child.stdout.on('data', (c) => { so += c.toString('utf8') })
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(so.trim()))
  })
  try { return JSON.parse(out).js || '' } catch (e) { return '' }
}


async function loadAccounts() {
  let acc = await readJson(ACCOUNTS_PATH, null)
  if (!acc || !Array.isArray(acc.accounts)) {
    const legacy = await readJson(HOME + '/.config/yhlogin/accounts.json', null)
    if (legacy && Array.isArray(legacy.accounts)) {
      acc = { current: legacy.current || '', accounts: legacy.accounts }
    } else {
      acc = { current: '', accounts: [] }
    }
  }
  accountsCache = acc
  return acc
}
function getAccount(username) {
  if (!accountsCache) return undefined
  if (username) return accountsCache.accounts.find((a) => a.username === username)
  const cur = accountsCache.current
  return accountsCache.accounts.find((a) => a.username === cur) || accountsCache.accounts[0]
}
async function saveAccounts(acc) {
  await writeJson(ACCOUNTS_PATH, acc)
  accountsCache = acc
}

async function doLogin(username) {
  await loadAccounts()
  const acc = getAccount(username)
  if (!acc) return { ok: false, error: 'no account; configure one first' }
  const js = await loginAccount(acc)
  if (!js) return { ok: false, error: 'login failed for ' + acc.username }
  jsidCache = js
  const cfg = await readJson(CONFIG_PATH, null)
  orgCache = (acc && acc.org) || (cfg && cfg.default_org) || ''
  accountCache = acc.username
  await writeJson(SESSION_PATH, { jsessionid: js, username: acc.username, org: orgCache, login_time: Date.now() / 1000 })
  return { ok: true, cached: false, jsid: js, org: orgCache, username: acc.username }
}

async function ensureAuth(preferAccount) {
  if (jsidCache && !preferAccount) return { ok: true, cached: true, jsid: jsidCache, org: orgCache, username: accountCache }
  const sess = await readJson(SESSION_PATH, null)
  if (!preferAccount && sess && sess.jsessionid && sess.login_time && (Date.now() / 1000 - sess.login_time) * 1000 < TTL_MS) {
    jsidCache = sess.jsessionid
    const cfg = await readJson(CONFIG_PATH, null)
    orgCache = (sess && sess.org) || (cfg && cfg.default_org) || ''
    accountCache = (sess && sess.username) || ''
    return { ok: true, cached: true, jsid: jsidCache, org: orgCache, username: accountCache }
  }
  return doLogin(preferAccount)
}

// normalize params to runSql's real format: a JSON string of
// [{id:number, key, type:1, value:string}]. The server parseInt()s `id`.
function normParams(p) {
  let arr = []
  if (Array.isArray(p)) arr = p.slice()
  else if (p && typeof p === 'object') arr = Object.keys(p).map((k) => ({ key: k, value: p[k] }))
  arr = arr.map((it, i) => ({
    id: (typeof it.id === 'number' && isFinite(it.id) && it.id >= 0 && it.id <= 2147483647) ? Math.floor(it.id) : (++paramIdSeq),
    key: String(it.key === undefined ? 'p' + i : it.key),
    type: (typeof it.type === 'number' ? it.type : 1),
    value: (it.value === undefined || it.value === null) ? '' : String(it.value),
  }))
  return arr
}
function runSqlBody(payload) {
  return {
    sql: payload.sql,
    engine: payload.engine,
    dsId: payload.dsId,
    params: normParams(payload.params),
    executeConfigs: {},
  }
}

// ---- curl 执行 ----
function curlRun(argv, bodyStdin, timeoutSec) {
  return new Promise((resolve) => {
    const child = spawn('curl', argv)
    let out = Buffer.alloc(0)
    let err = ''
    let settled = false
    const done = (res) => { if (!settled) { settled = true; resolve(res) } }
    const killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} done({ exitCode: -1, out, err: 'timeout' }) }, (timeoutSec + 10) * 1000)
    child.stdout.on('data', (c) => { out = Buffer.concat([out, c]) })
    child.stderr.on('data', (c) => { err += c.toString('utf8') })
    child.on('error', (e) => { clearTimeout(killTimer); done({ exitCode: -1, out, err: String(e && e.message) }) })
    child.on('close', (code) => { clearTimeout(killTimer); done({ exitCode: code === null ? -1 : code, out, err }) })
    child.stdin.on('error', () => {})
    if (bodyStdin !== undefined) child.stdin.write(bodyStdin)
    child.stdin.end()
  })
}

// ---- OLAP HTTP 请求 ----
async function req(spec) {
  if (spec.auth !== false) await ensureAuth()
  const base = spec.base || BASE_OLAP
  let url = base + spec.path
  if (spec.query) url += '?' + spec.query
  const argv = ['-sk', '--max-time', String(spec.timeout || 180)]
  if (spec.method && spec.method !== 'GET') argv.push('-X', spec.method)
  if (spec.auth !== false) {
    argv.push('-H', 'token: JSESSIONID=' + jsidCache)
    argv.push('-H', 'orgCode: ' + (orgCache || 'bgzt000004'))
  }
  argv.push('-H', 'Content-Type: application/json')
  if (spec.body !== undefined && spec.body !== null) argv.push('--data-binary', '@-')
  if (spec.binary) argv.push('-D', '-')
  argv.push(url)
  const stdinData = (spec.body !== undefined && spec.body !== null) ? JSON.stringify(spec.body) : undefined
  const r = await curlRun(argv, stdinData, spec.timeout || 180)
  if (r.exitCode !== 0) {
    return { ok: false, httpError: 'exit ' + r.exitCode + (r.err ? ' : ' + r.err.slice(0, 500) : '') }
  }
  let payload = r.out
  if (spec.binary) {
    let cut = 0
    const sepCrlf = r.out.indexOf('\r\n\r\n')
    if (sepCrlf >= 0) cut = sepCrlf + 4
    else {
      const sepLf = r.out.indexOf('\n\n')
      if (sepLf >= 0) cut = sepLf + 2
    }
    const headText = r.out.slice(0, cut).toString('utf8')
    payload = r.out.slice(cut)
    const cd = /content-disposition:\s*[^;\r\n]*;\s*filename\*?=(?:"([^"]*)"|([^;\r\n]+))/i.exec(headText)
      || /filename=(?:"([^"]*)"|([^;\r\n]+))/i.exec(headText)
    let fn = ''
    if (cd) {
      fn = (cd[1] !== undefined ? cd[1] : cd[2]).trim()
      try { fn = decodeURIComponent(fn.replace(/^UTF-8''/i, '')) } catch {}
    }
    return { ok: true, base64: payload.toString('base64'), filename: fn }
  }
  const text = payload.toString('utf8')
  try {
    const j = JSON.parse(text)
    if (j && typeof j === 'object') {
      if (j.data !== undefined) {
        if (j.code !== undefined && j.code !== '0000000') {
          return { ok: false, error: j.message || ('code ' + j.code), body: j }
        }
        return { ok: true, data: j.data, raw: text }
      }
      return { ok: false, error: j.message || 'empty response', body: j }
    }
    return { ok: true, data: j, raw: text }
  } catch (e) {
    return { ok: false, error: 'bad json: ' + text.slice(0, 300) }
  }
}

async function delay(ms) { await new Promise((r) => setTimeout(r, ms)) }

async function runSqlFull(payload, timeoutSec) {
  const sec = timeoutSec || 300
  const sub = await req({ path: '/sql/manager/runSql', method: 'POST', body: runSqlBody(payload), timeout: 60 })
  if (!sub.ok) return sub
  const executeId = sub.data && sub.data.executeId
  if (!executeId) return { ok: false, error: 'no executeId in runSql response' }
  const deadline = Date.now() + sec * 1000
  let state = { finish: 'run' }
  let logText = ''
  let lastErr = ''
  while (Date.now() < deadline) {
    const st = await req({ path: '/sql/manager/checkState', method: 'POST', body: { requestId: executeId }, timeout: 30 })
    if (!st.ok) { lastErr = st.error || 'checkState failed'; break }
    const d = st.data || {}
    state = d
    const lg = await req({ path: '/sql/manager/getLogResult', method: 'POST', body: { requestId: executeId }, timeout: 30 })
    if (lg.ok && lg.data) logText = (lg.data.data !== undefined ? lg.data.data : '') || ''
    if (d.finish === 'ok' || d.finish === 'error') break
    await delay(1500)
  }
  let result = null
  if (state.finish === 'ok') {
    // getSqlResult 在 finish=ok 后可能 isReady 仍是 'run'，结果未就绪返回空；轮询直到 ready 或超时
    const rDeadline = Date.now() + 12000
    while (Date.now() < rDeadline) {
      const r = await req({ path: '/sql/manager/getSqlResult', method: 'POST', body: { requestId: executeId, pageNo: 1, pageSize: 200 }, timeout: 60 })
      if (r.ok && r.data && (r.data.isReady === 'ok' || (r.data.list && r.data.list.length))) { result = r.data; break }
      if (!r.ok) { lastErr = r.error || 'getSqlResult failed'; break }
      await delay(1500)
    }
  }
  return { ok: true, executeId, finish: state.finish, errMsg: state.errMsg || lastErr, log: logText, result }
}

const handles = {
  'olap.accounts.list': async () => {
    const acc = await loadAccounts()
    return { ok: true, current: acc.current, accounts: acc.accounts.map((a) => ({ username: a.username, alias: a.alias || a.username, org: a.org || '' })) }
  },
  'olap.accounts.save': async (args) => {
    const acc = await loadAccounts()
    const i = acc.accounts.findIndex((a) => a.username === args.username)
    // 已存在账号：未提供的字段（尤其 password/otp_key）必须保留旧值，
    // 否则保存昵称/org 会把密码清空导致切换失败。
    const prev = i >= 0 ? acc.accounts[i] : {}
    const entry = {
      username: args.username,
      password: (args.password !== undefined && args.password !== null) ? args.password : (prev.password || ''),
      otp_key: (args.otp_key !== undefined && args.otp_key !== null) ? args.otp_key : (prev.otp_key || ''),
      org: (args.org !== undefined && args.org !== null) ? args.org : (prev.org || ''),
      alias: (args.alias !== undefined && args.alias !== null) ? args.alias : (prev.alias || args.username),
    }
    if (i >= 0) acc.accounts[i] = entry
    else acc.accounts.push(entry)
    acc.current = args.makeCurrent ? args.username : acc.current
    await saveAccounts(acc)
    return { ok: true }
  },
  'olap.accounts.remove': async (args) => {
    const acc = await loadAccounts()
    acc.accounts = acc.accounts.filter((a) => a.username !== args.username)
    if (acc.current === args.username) acc.current = acc.accounts.length ? acc.accounts[0].username : ''
    await saveAccounts(acc)
    return { ok: true }
  },
  'olap.login': async (args) => {
    const username = args && args.username
    if (username) {
      const acc = await loadAccounts()
      if (acc.current !== username) { acc.current = username; await saveAccounts(acc) }
      return doLogin(username)
    }
    return ensureAuth()
  },
  'olap.orgs': async () => req({ path: '/org/getUserOrgs', base: BASE_PALLAS, method: 'GET', timeout: 30 }),
  'olap.datasource': async () => req({ path: '/metadata/olap/support/dataSource', method: 'GET', timeout: 30 }),
  'olap.schemas': async (args) => req({ path: '/metadata/source/' + args.dsId + '/schema?force=true&engine=' + args.engine, method: 'GET', timeout: 30 }),
  'olap.tables': async (args) => req({ path: '/metadata/source/schema/' + args.schemaId + '/table?force=true&pageSize=100&currPage=1&engine=' + args.engine, method: 'GET', timeout: 60 }),
  'olap.columns': async (args) => req({ path: '/metadata/source/schema/' + args.schemaId + '/table/' + args.tableId + '/column?force&engine=' + args.engine, method: 'GET', timeout: 60 }),
  'olap.submit': async (args) => {
    const p = args.payload || {}
    return req({ path: '/sql/manager/runSql', method: 'POST', body: runSqlBody(p), timeout: 60 })
  },
  'olap.state': async (args) => req({ path: '/sql/manager/checkState', method: 'POST', body: { requestId: args.requestId }, timeout: 30 }),
  'olap.result': async (args) => req({ path: '/sql/manager/getSqlResult', method: 'POST', body: { requestId: args.requestId, pageNo: args.pageNo || 1, pageSize: Math.min(args.pageSize || 200, 200) }, timeout: 60 }),
  'olap.log': async (args) => req({ path: '/sql/manager/getLogResult', method: 'POST', body: { requestId: args.requestId }, timeout: 30 }),
  'olap.kill': async (args) => req({ path: '/cluster/manager/killJob', method: 'POST', body: { requestId: args.requestId, engine: args.engine, dsId: args.dsId }, timeout: 30 }),
  'olap.run': async (args) => runSqlFull(args.payload || {}, args.timeoutSec),
  'olap.history': async (args) => req({ path: '/sql/manager/queryHisSqlResult', method: 'POST', body: { pageNum: args.pageNum || 1, pageSize: Math.min(args.pageSize || 20, 100), sqlKeywords: args.sqlKeywords }, timeout: 30 }),
  'olap.history.download': async (args) => {
    const rr = await req({ path: '/download/olapHistoryResultData/' + (args.sqlSource === undefined ? 0 : args.sqlSource) + '/' + args.requestId, method: 'GET', binary: true, timeout: 180 })
    if (rr.ok && rr.filename && /^\d+\.xlsx$/i.test(rr.filename)) {
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      rr.filename = (args.fileName || ('olap-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()))) + '.xlsx'
    }
    return rr
  },
  'olap.history.fast': async (args) => {
    // 历史结果快速下载（≤1000 条）：olapResultSimple/{requestId}
    const rr = await req({ path: '/download/olapResultSimple/' + args.requestId, method: 'GET', binary: true, timeout: 120 })
    if (rr.ok && rr.filename && /^\d+\.xlsx$/i.test(rr.filename)) {
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      rr.filename = (args.fileName || ('olap-fast-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()))) + '.xlsx'
    }
    return rr
  },
  'olap.history.order': async (args) => {
    // 历史全量下载 = 提交下载工单（engine: 1=hive, 2=impala），后续到下载页下载
    const rr = await req({ path: '/approval/createSkipDownloadOrder', method: 'PUT', body: { requestId: args.requestId, engine: Number(args.engine) }, timeout: 30 })
    return rr
  },
  'olap.collect.tree': async () => req({ path: '/user/collect/getAllModelTree', method: 'GET', timeout: 30 }),
  'olap.collect.dirs': async () => req({ path: '/user/collect/getDir', method: 'GET', timeout: 30 }),
  'olap.collect.create': async (args) => req({ path: '/user/collect/createNode', method: 'POST', body: args.node, timeout: 30 }),
  'olap.collect.rename': async (args) => req({ path: '/user/collect/rename/' + args.id + '/' + encodeURIComponent(args.newName), method: 'GET', timeout: 30 }),
  'olap.collect.delete': async (args) => req({ path: '/user/collect/deleteNode/' + args.id, method: 'GET', timeout: 30 }),
  'olap.collect.update': async (args) => req({ path: '/user/collect/updateNode', method: 'POST', body: args.patch, timeout: 30 }),
  'olap.download.create': async (args) => {
    if (args.kind === 'skip') return req({ path: '/approval/createSkipDownloadOrder', method: 'PUT', body: { requestId: args.requestId, engine: args.engine }, timeout: 30 })
    if (args.kind === 'middle') return req({ path: '/approval/createMiddleDownloadOrder', method: 'PUT', body: { requestId: args.requestId }, timeout: 30 })
    return req({ path: '/approval/createOrder', method: 'PUT', body: { querySql: args.querySql, requestId: args.requestId, engine: args.engine }, timeout: 30 })
  },
  'olap.download.list': async (args) => req({ path: '/approval/searchSubmitOrder?pageNum=' + (args.pageNum || 1) + '&pageSize=' + (args.pageSize || 20) + '&sortOrder=DESC&sortField=id', method: 'POST', body: {}, timeout: 30 }),
  'olap.download.detail': async (args) => req({ path: '/approval/detail?approvalId=' + args.approvalId, method: 'GET', timeout: 30 }),
  'olap.download.file': async (args) => {
    const orderId = args.id || args.approvalId
    if (!orderId) return { ok: false, error: 'missing download order id' }
    const detail = await req({ path: '/approval/detail?approvalId=' + orderId, method: 'GET', timeout: 30 })
    if (!detail.ok) return detail
    const d = detail.data || {}
    const engine = String(d.engine !== undefined && d.engine !== null ? d.engine : args.engine)
    // 服务端 Content-Disposition 名是纯时间戳（如 1787823661881.xlsx），不够友好。
    // 从 querySql 的 `-- 标题: XXX` 注释提取做文件名；没有则用下载-日期。
    let niceName = ''
    const qsql = d.querySql || args.querySql || ''
    const titleM = /--\s*标题\s*[:：]\s*([^\n\r]+)/.exec(qsql)
    if (titleM) niceName = (titleM[1] || '').trim()
    if (!niceName) {
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      niceName = 'olap-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes())
    }
    const friendly = args.fileName || (niceName + '.xlsx')
    if (engine === '1') {
      const rr = await req({ path: '/download/olapResult/' + (d.requestId || ''), method: 'GET', binary: true, timeout: 300 })
      if (rr.ok && rr.filename && /^\d+\.xlsx$/i.test(rr.filename)) rr.filename = friendly
      return rr
    }
    const dlRid = d.downLoadRequestId || d.requestId || ''
    const rr2 = await req({ path: '/open/api/downloadToExcel?requestId=' + encodeURIComponent(dlRid) + '&fileName=' + encodeURIComponent(friendly), base: MAGPIE_BASE, method: 'GET', binary: true, timeout: 300 })
    if (rr2.ok && rr2.filename && /^\d+\.xlsx$/i.test(rr2.filename)) rr2.filename = friendly
    return rr2
  },
  'olap.download.refresh': async (args) => req({ path: '/download/refresh', method: 'POST', body: { downloadId: args.downloadId }, timeout: 30 }),
}

const queues = {
  'olap.panel.register': async (args) => {
    const sid = args.sessionId
    if (!panelQueues.has(sid)) panelQueues.set(sid, [])
    return { ok: true, sessionId: sid }
  },
  'olap.panel.state': async (args) => {
    panelStates.set(args.sessionId, args.state)
    return { ok: true }
  },
  'olap.panel.poll': async (args) => {
    const sid = args.sessionId
    const list = panelQueues.get(sid) || []
    panelQueues.set(sid, [])
    return { ok: true, commands: list }
  },
}
// ===== WORKSTATION: workspace 多文件持久化 + sqlkb 只读浏览 + 历史会话列表 =====
function wsSafeFile(name) {
  // 只允许普通文件名：去掉路径分隔符/目录穿越
  const s = String(name || '').replace(/[\\/]/g, '_').replace(/\.\.+/g, '').trim()
  return s || 'unnamed'
}
function wsExt(kind) {
  if (kind === 'sql') return '.sql'
  if (kind === 'params') return '.json'
  if (kind === 'note') return '.md'
  return '.txt'
}
// 工作区按会话隔离：sessionId 传了就落到 ~/.yh-olap/workspace/<sessionId>/{sql,params,notes}/，
// 不传则用全局旧目录（兼容）。sessionId 会清洗成安全目录名。
function wsDir(sid, kind) {
  const sub = kind === 'note' ? 'notes' : kind === 'params' ? 'params' : 'sql'
  if (sid) {
    const s = String(sid).replace(/[^a-zA-Z0-9._-]/g, '')
    if (s) return join(WORKSPACE_ROOT, s, sub)
  }
  return join(WORKSPACE_ROOT, sub)
}
function parseSqlkbFm(txt) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt)
  if (!m) return null
  const fm = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    let val = line.slice(i + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    fm[key] = val
  }
  return fm
}
function parseSqlkbFile(txt) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(txt)
  if (!m) return { frontmatter: {}, body: txt }
  const fm = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    let val = line.slice(i + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    fm[key] = val
  }
  return { frontmatter: fm, body: (m[2] || '').trim() }
}


// ===== WORKSTATION: kb 按条目名定位文件（跨分类递归）=====
async function findKbFile(name) {
  const walk = async function (d, prefix) {
    let ents = []
    try { ents = await readdir(d, { withFileTypes: true }) } catch (e) { return null }
    for (const en of ents) {
      const full = join(d, en.name)
      if (en.isDirectory()) { const r = await walk(full, prefix ? prefix + '/' + en.name : en.name); if (r) return r }
      else if (en.isFile() && en.name.endsWith('.md') && en.name !== 'README.md') {
        let fm = {}
        try { fm = parseSqlkbFm(await readFile(full, 'utf8')) || {} } catch (e) { /* ignore */ }
        const nm = fm.name || en.name.replace(/\.md$/, '')
        if (nm === name || en.name.replace(/\.md$/, '') === name) return { file: full, category: prefix || '' }
      }
    }
    return null
  }
  return walk(KB_ROOT, '')
}

const wsHandlers = {
  // ── 工作区：多文件（sql/params/note 三类，互不覆盖）；按 sessionId 隔离 ──
  'ws.workspace.list': async (args) => {
    const out = { ok: true, root: WORKSPACE_ROOT, sql: [], params: [], notes: [] }
    const kinds = { sql: 'sql', params: 'params', note: 'notes' }
    for (const key of Object.keys(kinds)) {
      const dir = wsDir(args && args.sessionId, key)
      try {
        const ents = await readdir(dir, { withFileTypes: true })
        const rows = []
        for (const en of ents) {
          if (!en.isFile()) continue
          if (!en.name.endsWith(wsExt(key))) continue
          const name = en.name.slice(0, en.name.length - wsExt(key).length)
          let mtime = 0
          try { mtime = (await stat(join(dir, en.name))).mtimeMs || 0 } catch (e) { /* ignore */ }
          const row = { name: name, mtime: mtime }
          // ===== WORKSTATION: 便签项带内容（工作区树悬停显示便签用）=====
          if (key === 'note') {
            try { row.content = await readFile(join(dir, en.name), 'utf8') } catch (e) { row.content = '' }
          }
          // ===== WORKSTATION: SQL 项带标签名（文件名是纯 id，__name 存 params 目录的同名 .json 里）=====
          if (key === 'sql') {
            try {
              const pDir = wsDir(args && args.sessionId, 'params')
              const p = JSON.parse(await readFile(join(pDir, name + '.json'), 'utf8'))
              if (p && p.__name) row.displayName = String(p.__name)
            } catch (e) { /* 无 params 或未解析 */ }
          }
          rows.push(row)
        }
        rows.sort((a, b) => b.mtime - a.mtime)
        out[kinds[key]] = rows
      } catch (e) { out[kinds[key]] = [] }
    }
    return out
  },
  'ws.workspace.save': async (args) => {
    const kind = args.kind
    if (kind !== 'sql' && kind !== 'params' && kind !== 'note') return { ok: false, error: 'bad kind' }
    const name = wsSafeFile(args.name)
    const dir = wsDir(args.sessionId, kind)
    await mkdir(dir, { recursive: true })
    let content = args.content == null ? '' : String(args.content)
    if (kind === 'params') {
      try { content = JSON.stringify(JSON.parse(content), null, 2) } catch (e) { /* keep as-is */ }
    }
    await writeFile(join(dir, name + wsExt(kind)), content, 'utf8')
    return { ok: true, name: name, kind: kind }
  },
  'ws.workspace.read': async (args) => {
    const kind = args.kind
    if (kind !== 'sql' && kind !== 'params' && kind !== 'note') return { ok: false, error: 'bad kind' }
    const name = wsSafeFile(args.name)
    const dir = wsDir(args.sessionId, kind)
    try {
      const content = await readFile(join(dir, name + wsExt(kind)), 'utf8')
      return { ok: true, name: name, kind: kind, content: content }
    } catch (e) { return { ok: false, error: 'not found' } }
  },
  'ws.workspace.remove': async (args) => {
    const kind = args.kind
    if (kind !== 'sql' && kind !== 'params' && kind !== 'note') return { ok: false, error: 'bad kind' }
    const name = wsSafeFile(args.name)
    const dir = wsDir(args.sessionId, kind)
    try { await rm(join(dir, name + wsExt(kind))); return { ok: true } } catch (e) { return { ok: false, error: String(e && e.message) } }
  },
  'ws.workspace.rename': async (args) => {
    const kind = args.kind
    if (kind !== 'sql' && kind !== 'params' && kind !== 'note') return { ok: false, error: 'bad kind' }
    const from = wsSafeFile(args.from)
    const to = wsSafeFile(args.to)
    const dir = wsDir(args.sessionId, kind)
    try { await rename(join(dir, from + wsExt(kind)), join(dir, to + wsExt(kind))); return { ok: true } } catch (e) { return { ok: false, error: String(e && e.message) } }
  },

  // ── sqlkb 只读浏览（表/示例/坑点）───────────────────────────────────────
  'ws.sqlkb.list': async (args) => {
    const only = args.kind // table | example | pitfall | all
    const out = { ok: true, tables: [], examples: [], pitfalls: [] }
    const dirs = { tables: 'tables', examples: 'examples', pitfalls: 'pitfalls' }
    for (const key of Object.keys(dirs)) {
      if (only && only !== 'all' && only !== key) continue
      const dir = join(SQLKB_ROOT, dirs[key])
      try {
        const ents = await readdir(dir, { withFileTypes: true })
        for (const en of ents) {
          if (!en.isFile() || !en.name.endsWith('.md')) continue
          const fm = parseSqlkbFm(await readFile(join(dir, en.name), 'utf8'))
          if (!fm) continue
          out[key].push({ name: en.name.replace(/\.md$/, ''), kind: key, ...fm })
        }
      } catch (e) { /* dir missing */ }
    }
    return out
  },
  'ws.sqlkb.get': async (args) => {
    const id = String(args.id || '').replace(/\.md$/, '').replace(/[\\/]/g, '_')
    const dirs = { tables: 'tables', examples: 'examples', pitfalls: 'pitfalls' }
    for (const key of Object.keys(dirs)) {
      const file = join(SQLKB_ROOT, dirs[key], id + '.md')
      try {
        const parsed = parseSqlkbFile(await readFile(file, 'utf8'))
        return { ok: true, name: id, kind: key, frontmatter: parsed.frontmatter, body: parsed.body }
      } catch (e) { /* try next */ }
    }
    return { ok: false, error: 'not found: ' + id }
  },

  // ── kb 通用知识库只读浏览（~/.agents/kb：目录树分类 + .md 条目）─────────────
  'ws.kb.tree': async () => {
    try {
      const cats = await readdir(KB_ROOT, { withFileTypes: true })
      const out = { ok: true, root: KB_ROOT, categories: [], categoriesMeta: {} }
      // categories.yml 元数据
      try { out.categoriesMeta = parseSqlkbFile(await readFile(join(KB_ROOT, 'categories.yml'), 'utf8')).frontmatter || {} } catch (e) { /* optional */ }
      const metaYml = out.categoriesMeta.categories && typeof out.categoriesMeta.categories === 'object' ? out.categoriesMeta.categories : {}
      const walk = async function (dir, prefix) {
        let ents = []
        try { ents = await readdir(dir, { withFileTypes: true }) } catch (e) { return [] }
        const rows = []
        for (const en of ents) {
          const full = join(dir, en.name)
          if (en.isDirectory()) {
            const path = prefix ? prefix + '/' + en.name : en.name
            const meta = metaYml[path] || {}
            if (meta && meta.enabled === false) continue
            const sub = await walk(full, path)
            rows.push({ type: 'dir', path: path, title: (meta && meta.title) || en.name, description: (meta && meta.description) || '', children: sub })
          } else if (en.isFile() && en.name.endsWith('.md') && en.name !== 'README.md') {
            let fm = {}
            try { fm = parseSqlkbFm(await readFile(full, 'utf8')) || {} } catch (e) { /* ignore */ }
            rows.push({ type: 'item', name: fm.name || en.name.replace(/\.md$/, ''), summary: fm.summary || '', tags: fm.tags || '', file: (prefix ? prefix + '/' : '') + en.name.replace(/\.md$/, ''), category: prefix || '' })
          }
        }
        return rows
      }
      for (const en of cats) {
        if (!en.isDirectory()) continue
        const children = await walk(join(KB_ROOT, en.name), en.name)
        out.categories.push({ type: 'dir', path: en.name, title: (metaYml[en.name] && metaYml[en.name].title) || en.name, description: (metaYml[en.name] && metaYml[en.name].description) || '', children: children })
      }
      return out
    } catch (e) { return { ok: false, error: String(e && e.message) } }
  },
  'ws.kb.list': async (args) => {
    const cat = String(args.category || '').replace(/\.\./g, '').replace(/^\/|\/$/g, '')
    const dir = cat ? join(KB_ROOT, cat) : KB_ROOT
    try {
      const rows = []
      const walk = async function (d, prefix) {
        let ents = []
        try { ents = await readdir(d, { withFileTypes: true }) } catch (e) { return }
        for (const en of ents) {
          const full = join(d, en.name)
          if (en.isDirectory()) await walk(full, prefix ? prefix + '/' + en.name : en.name)
          else if (en.isFile() && en.name.endsWith('.md') && en.name !== 'README.md') {
            let fm = {}
            try { fm = parseSqlkbFm(await readFile(full, 'utf8')) || {} } catch (e) { /* ignore */ }
            rows.push({ name: fm.name || en.name.replace(/\.md$/, ''), summary: fm.summary || '', tags: fm.tags || '', related: fm.related || '', category: prefix || cat, file: (prefix ? prefix + '/' : cat ? cat + '/' : '') + en.name.replace(/\.md$/, '') })
          }
        }
      }
      await walk(dir, '')
      return { ok: true, rows: rows }
    } catch (e) { return { ok: false, error: String(e && e.message) } }
  },
  'ws.kb.get': async (args) => {
    const id = String(args.name || '').replace(/\.md$/, '').replace(/[\\/]/g, '~')
    // 通过 tree 定位文件更稳：直接按 name 全局找
    try {
      const found = await findKbFile(id)
      if (!found) return { ok: false, error: 'not found: ' + id }
      const parsed = parseSqlkbFile(await readFile(found.file, 'utf8'))
      return { ok: true, name: parsed.frontmatter.name || id, frontmatter: parsed.frontmatter, body: parsed.body, category: found.category }
    } catch (e) { return { ok: false, error: String(e && e.message) } }
  },
  'ws.kb.search': async (args) => {
    const q = String(args.q || '').trim().toLowerCase()
    if (!q) return { ok: true, rows: [] }
    try {
      const rows = []
      const walk = async function (d, prefix) {
        let ents = []
        try { ents = await readdir(d, { withFileTypes: true }) } catch (e) { return }
        for (const en of ents) {
          const full = join(d, en.name)
          if (en.isDirectory()) await walk(full, prefix ? prefix + '/' + en.name : en.name)
          else if (en.isFile() && en.name.endsWith('.md') && en.name !== 'README.md') {
            let txt = ''
            try { txt = await readFile(full, 'utf8') } catch (e) { continue }
            const fm = parseSqlkbFm(txt) || {}
            const name = fm.name || en.name.replace(/\.md$/, '')
            const summary = fm.summary || ''
            const hit = (name + ' ' + summary + ' ' + (fm.tags || '') + ' ' + txt.slice(0, 2000)).toLowerCase().indexOf(q) !== -1
            if (hit) rows.push({ name: name, summary: summary, tags: fm.tags || '', category: prefix || '', file: (prefix ? prefix + '/' : '') + en.name.replace(/\.md$/, '') })
          }
        }
      }
      await walk(KB_ROOT, '')
      return { ok: true, rows: rows.slice(0, 60) }
    } catch (e) { return { ok: false, error: String(e && e.message) } }
  },

  // ── 历史会话列表（给右上「历史会话」呼出面板）────────────────────────────
  'ws.sessions.list': async () => {
    try {
      const rows = []
      const q = sessionQuerySvc
      if (q && typeof q.listSessions === 'function') {
        const recs = await q.listSessions()
        for (const r of (recs || []).slice(0, 60)) {
          const h = r.header || {}
          const row = {
            id: h.id || '',
            title: '',
            cwd: h.cwd || '',
            createdAt: h.createdAt || 0,
          }
          if (q.readTitle && h.id) {
            try {
              const t = await q.readTitle(h.id)
              if (t && typeof t === 'object' && t.title) row.title = t.title
            } catch (e) { /* title optional */ }
          }
          rows.push(row)
        }
      } else if (sessionStoreSvc && typeof sessionStoreSvc.list === 'function') {
        const sess = sessionStoreSvc.list()
        for (const s of (sess || [])) {
          rows.push({ id: s.id || '', title: '', cwd: '', createdAt: 0 })
        }
      }
      rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      return { ok: true, sessions: rows }
    } catch (e) { return { ok: false, error: String(e && e.message) } }
  },
}

const allHandlers = Object.assign({}, handles, queues, wsHandlers)

function clean(obj) {
  const out = {}
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k]
  }
  return out
}
function enqueue(sessionId, command) {
  const sid = sessionId || ''
  const item = Object.assign({ id: 'c' + (++cmdSeq), ts: Date.now() }, clean(command))
  if (!panelQueues.has(sid)) panelQueues.set(sid, [])
  panelQueues.get(sid).push(item)
  return item
}
function lastState(sessionId) {
  return panelStates.get(sessionId) || null
}

const tool = {
  name: 'olap',
  description: '操控指定会话的 yh-olap 面板：写 SQL 到编辑器（含指定标签页/光标选定行）、运行、停止、读面板状态。面板需在目标会话页面打开（会话头部 OLAP 按钮呼出）。',
  parameters: {
    action: { type: 'string', required: true, enum: ['write', 'run', 'stop', 'state', 'refresh'] },
    sessionId: { type: 'string', description: '目标会话 id；缺省用当前会话' },
    tabId: { type: 'number', description: '标签页序号（从 1 开始）；缺省用活动标签' },
    sql: { type: 'string', description: 'SQL 文本（write/run 时用）' },
    engine: { type: 'string', description: '引擎类型：1=hive 2=impala 3=clickhouse 4=doris' },
    dsId: { type: 'number', description: '数据源 id（引擎对应的数据源）' },
    params: { type: 'array', description: '参数数组 [{id,key,type,value}]' },
    lines: { type: 'array', description: '只运行光标选定的行 [startLine, endLine]（1-based，闭区间）' },
    newTab: { type: 'boolean', description: 'write 时 true 表示新建一个标签并写入（自动激活），不覆盖现有标签' },
    timeoutSec: { type: 'number', description: 'run 等待超时秒数，默认 300' },
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'object', additionalProperties: true } }, additionalProperties: true },
    render: (args, value) => [{ type: 'text', text: value.summary || JSON.stringify(value) }],
  },
  async execute(args, exec) {
    const currentSid = exec && exec.agent ? exec.agent.id : undefined
    const sid = args.sessionId || currentSid
    if (!sid) return { ok: false, error: 'no sessionId and no current agent session' }
    const auth = await ensureAuth()
    if (!auth.ok) return { ok: false, error: auth.error || 'auth failed' }

    if (args.action === 'refresh') {
      const r = await ensureAuth()
      return { ok: true, summary: 'auth: ' + (jsidCache ? 'ok' : 'fail'), data: { username: accountCache, org: orgCache } }
    }
    if (args.action === 'state') {
      const st = lastState(sid)
      const data = st || { tabs: [], activeTab: 0 }
      let summary
      if (!st) {
        summary = 'panel not open in that session; open the OLAP panel via the session header button first'
      } else if (args.tabId) {
        const t = st.tabs.find(function (x) { return x.id === args.tabId })
        summary = t
          ? ('tab#' + t.id + ' ' + (t.name || '') + (t.id === st.activeTab ? '(active)' : '') + ' engine=' + t.engine + (t.running ? ' RUNNING' : '') + ' finish=' + (t.finish || '') + '\nsql=' + JSON.stringify(t.sql || ''))
          : ('no tab#' + args.tabId + '; existing tabs: ' + st.tabs.map(function (x) { return x.id }).join(','))
      } else {
        summary = 'tabs=' + st.tabs.length + ' active=' + st.activeTab + ' account=' + (st.currentAccount || '') + '\n' + st.tabs.map(function (t) {
          return '  #' + t.id + ' ' + (t.name || '') + (t.id === st.activeTab ? '(active)' : '') + ' engine=' + t.engine + (t.running ? ' RUNNING' : '') + (t.finish ? ' finish=' + t.finish : '') + '\n    sql=' + JSON.stringify((t.sql || '').slice(0, 300))
        }).join('\n')
      }
      return { ok: true, summary, data }
    }
    if (args.action === 'write') {
      const item = enqueue(sid, { type: 'write', tabId: args.tabId, sql: args.sql, lines: args.lines, newTab: !!args.newTab })
      return { ok: true, summary: 'queued write to ' + sid + (args.newTab ? ' (new tab)' : (args.tabId ? ' tab ' + args.tabId : ' active tab')), data: { commandId: item.id } }
    }
    if (args.action === 'run') {
      let sqlText = args.sql
      let engine = args.engine
      let dsId = args.dsId
      let params = args.params || []
      const st = lastState(sid)
      const tb = st && st.tabs
        ? (args.tabId ? st.tabs.find((t) => t.id === args.tabId) : st.tabs.find((t) => t.id === st.activeTab) || st.tabs[0])
        : undefined
      if (tb) {
        if (engine === undefined) engine = tb.engine
        if (dsId === undefined) dsId = tb.dsId
        if (!params.length && tb.params && typeof tb.params === 'object') params = tb.params
      }
      if (sqlText === undefined || sqlText === null || sqlText === '') {
        if (tb) {
          let s = tb.sql || ''
          if (args.lines && args.lines.length === 2) {
            const linesArr = s.split('\n')
            s = linesArr.slice(args.lines[0] - 1, args.lines[1]).join('\n')
          }
          sqlText = s
        }
        if (!sqlText) return { ok: false, error: 'no sql provided and no panel state for ' + sid }
      }
      if (engine === undefined) engine = '2'
      if (dsId === undefined) dsId = 2
      const payload = { sql: sqlText, engine, dsId, params }
      const res = await runSqlFull(payload, args.timeoutSec || 300)
      if (res.ok && res.finish === 'ok') {
        enqueue(sid, { type: 'reflect', tabId: args.tabId, sql: sqlText, engine, dsId, result: res.result, log: res.log, executeId: res.executeId })
      }
      const cols = (res.result && res.result.columnNameList) || []
      const rows = (res.result && res.result.list) || []
      const total = (res.result && res.result.total !== undefined) ? res.result.total : rows.length
      const errTxt = res.error || res.errMsg || ''
      const summary = 'executeId=' + (res.executeId || '') + ' finish=' + (res.finish || '') + (errTxt ? ' err=' + errTxt : '') + (res.finish === 'ok' ? (' columns=' + cols.length + ' rows(preview)=' + rows.length + ' total=' + total) : '')
      return { ok: !!(res.ok && res.finish === 'ok'), summary, data: { executeId: res.executeId || '', finish: res.finish || '', errMsg: errTxt, columns: cols, rows: rows.slice(0, 200), total: total, log: res.log || '' } }
    }
    if (args.action === 'stop') {
      const item = enqueue(sid, { type: 'stop', tabId: args.tabId })
      return { ok: true, summary: 'queued stop to ' + sid + (args.tabId ? ' tab ' + args.tabId : ' active tab'), data: { commandId: item.id } }
    }
    return { ok: false, error: 'unknown action ' + args.action }
  },
}

// ===== OLAP 模式（/olap 命令 + 常驻指引 + 标签投影，仿 dsh plan-mode）=====
const OLAP_MODE_GUIDE = [
  '[OLAP 模式] 用户正在操作 yh-olap 插件，以下行为在本次对话中持续有效：',
  '1. 目标会话的 OLAP 面板需已打开（会话头部 OLAP 按钮）。先调用 olap state 看面板状态（所有标签的 SQL/引擎/数据源/运行状态）。',
  '2. 修改 SQL：先 olap state 读取编辑器当前 SQL（含用户手动编辑的最新内容），基于它修改，再 olap.write {tabId, sql} 写回。只按要求修改，不主动运行。',
  '3. 新建需求：先 olap state 判断活动标签是否已有代码；有代码则 olap.write {newTab:true, sql} 新建标签，不覆盖现有。',
  '4. 多标签引用：olap state 返回每个标签的 #id/SQL/引擎/状态；olap state/write/run/stop 都支持 tabId（从 1 开始）指定要读取、编辑、运行的标签，缺省用活动标签。用户消息里的 @olapN 或 @TabN（N 为标签 id，如 @olap3/@Tab3=标签 #3）表示引用面板标签 #N。',
  '5. 运行：只有用户要求运行/看结果时才 olap run（不传 sql 跑指定/活动标签；engine/dsId 自动继承面板，缺省 impala engine=2 dsId=2、hive engine=1）。',
  '6. 本模式只做 SQL 编辑与执行：除非用户明确要求分析/解读，禁止对查询数据做主动分析、总结或建议；run 结果按需汇报 columns/rows/total/executeId 即可。',
  '7. 历史/下载/工单等操作也通过 olap 工具完成。',
].join('\n')

const PASS_SCHEMA = { parse: (v) => v }

function foldOlapMode(events) {
  let active = false
  for (const ev of events) {
    if (ev && ev.type === 'olap/mode') active = !!ev.data.active
  }
  return active
}
function hasOpenTurn(events) {
  let open = false
  for (const ev of events) {
    if (ev.type === 'turn/start') open = true
    else if (ev.type === 'turn/end') open = false
  }
  return open
}
/** 内联构造 user 消息（避免静态 bundle 环境 import @deepseek-ai 失败）。 */
function inlineUserMessage(text) {
  return {
    id: 'yh_olap_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10),
    role: 'user',
    content: [{ type: 'text', text: text }],
    source: { kind: 'user' },
  }
}
function setOlapMode(agent, active, pendingIntents) {
  const session = agent.session
  const pending = pendingIntents.get(session)
  const target = pending ? pending.active : foldOlapMode(session.events)
  if (active === target) return 'noop'
  if (hasOpenTurn(session.events)) {
    pendingIntents.set(session, { active })
    return foldOlapMode(session.events) === active ? 'cancelled' : 'queued'
  }
  if (active === foldOlapMode(session.events)) {
    pendingIntents.delete(session)
    return 'cancelled'
  }
  session.append('olap/mode', { active })
  pendingIntents.delete(session)
  return 'committed'
}
function registerOlapMode(ctx, disposers) {
  const pendingIntents = new WeakMap()
  try {
    const offPre = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      const pending = pendingIntents.get(agent.session)
      if (decision.kind === 'reject' || signal.aborted || pending === undefined) return decision
      try {
        if (pending.active !== foldOlapMode(agent.session.events)) {
          agent.session.append('olap/mode', { active: pending.active })
        }
        pendingIntents.delete(agent.session)
      } catch (error) {
        ctx.logger && ctx.logger.warn('yh-olap: append olap/mode failed: %o', error)
      }
      return decision
    })
    if (offPre) disposers.push(offPre)
    ctx.inject(['systemPrompt'], (sub) => {
      const off = sub.systemPrompt.section({
        name: 'olap:policy',
        order: 50,
        text: (context) => {
          if (context.agent === undefined) return ''
          return foldOlapMode(context.agent.session.events) ? OLAP_MODE_GUIDE : ''
        },
      })
      if (off) disposers.push(off)
    })
    ctx.inject(['sessionProjections'], (sub) => {
      const off = sub.sessionProjections.register({
        key: 'olap',
        stateSchema: PASS_SCHEMA,
        init: () => ({ active: false }),
        apply: (state, event) => {
          if (event && event.type === 'olap/mode') return { active: !!event.data.active }
          return state
        },
        wire: {
          viewSchema: PASS_SCHEMA,
          view: (state) => ({ active: state.active }),
        },
        stateVersion: 1,
      })
      if (off) disposers.push(off)
    })
    ctx.inject(['commands'], (sub) => {
      const off = sub.commands.register({
        name: 'olap',
        description: '进入/退出 OLAP 模式：激活后聊天输入框出现 OLAP 标签，期间指令都按操作 yh-olap 面板处理',
        input: { hint: '[off|第一条消息]' },
        handler: async ({ agent, rawInput }) => {
          const message = rawInput.trim()
          const leaving = message === 'off'
          setOlapMode(agent, !leaving, pendingIntents)
          if (!leaving && message !== '') {
            // 仿 /plan：/olap <内容> 进入模式的同时把内容注入对话，
            // 空会话也能"一起发送"并触发正常渲染（turn 打开、hero 退出）。
            // 优先用官方 createUserMessage；import 不可用（静态 bundle 环境）时回退内联构造。
            let injected = false
            try {
              const mod = await import('@deepseek-ai/dsh-llm')
              if (mod && typeof mod.createUserMessage === 'function') {
                agent.steer(mod.createUserMessage({
                  content: [{ type: 'text', text: message }],
                  source: { kind: 'user' },
                }))
                injected = true
              }
            } catch (e) { /* fall through to inline */ }
            if (!injected) {
              try {
                agent.steer(inlineUserMessage(message))
              } catch (e2) {
                ctx.logger && ctx.logger.warn('yh-olap: inject /olap message failed: ' + (e2 && e2.message))
              }
            }
          }
          return {
            kind: 'success',
            text: leaving
              ? '已退出 OLAP 模式。'
              : (message ? '已进入 OLAP 模式，并按你的消息继续。' : '已进入 OLAP 模式：聊天输入框出现 OLAP 标签，期间你的指令都按操作 yh-olap 面板处理。'),
          }
        },
      })
      if (off) disposers.push(off)
    })
  } catch (e) {
    ctx.logger && ctx.logger.warn('yh-olap: olap mode init error: ' + (e && e.message))
  }
}

/** 仅回环地址放行（浏览器同源请求）。 */
function isLoopbackRequest(request) {
  const address = request.socket && request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  return true
}
function replyJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}
async function readJsonBody(req2) {
  const chunks = []
  let size = 0
  for await (const chunk of req2) {
    size += chunk.length
    if (size > 16 * 1024 * 1024) return undefined
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

export function apply(ctx, _config) {
  const disposers = []
  // ===== WORKSTATION: 捕获会话服务供 ws.sessions.list 使用（读叶子字段，不序列化 live 对象） =====
  sessionQuerySvc = ctx.get('sessionQuery')
  sessionStoreSvc = ctx.get('sessions')
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/api/yh-olap/rpc',
    handler: async (req2, res) => {
      if (!isLoopbackRequest(req2)) { replyJson(res, 403, { ok: false, error: 'loopback-only' }); return }
      if (req2.method !== 'POST') { replyJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      const body = await readJsonBody(req2)
      if (!body || typeof body.method !== 'string') { replyJson(res, 400, { ok: false, error: 'bad rpc body' }); return }
      const fn = allHandlers[body.method]
      if (!fn) { replyJson(res, 404, { ok: false, error: 'no handler: ' + body.method }); return }
      try {
        const result = await fn(body.args || {})
        replyJson(res, 200, result === undefined ? {} : result)
      } catch (e) {
        replyJson(res, 200, { ok: false, error: String(e && e.message) })
      }
    },
  }))
  // ===== WORKSTATION: 网页 favicon/manifest 覆盖（换成永辉 OLAP 页面同款图标）=====
  // DSH web 的 /favicon.svg 走 frontend-static fallback，exact 路由优先于 fallback →
  // 注册同名路由即可覆盖。图标为 plugin/assets/olap-favicon.png（取自 bigdata.yonghui.cn 的 OLAP favicon）。
  // 读一次缓存，避免每请求读盘。
  let faviconBuf = null
  let faviconErr = null
  ;(function loadFavicon() {
    try {
      const here = dirname(fileURLToPath(import.meta.url))
      faviconBuf = readFile(join(here, '..', 'assets', 'olap-favicon.png')).catch(function (e) {
        faviconErr = e && e.message; return null
      })
    } catch (e) { faviconErr = e && e.message }
  })()
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/favicon.svg',
    handler: async (req2, res) => {
      try {
        const buf = faviconBuf ? await faviconBuf : null
        if (!buf) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('favicon not found' + (faviconErr ? ': ' + faviconErr : '')); return }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' })
        res.end(buf)
      } catch (e) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('favicon error') }
    },
  }))
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/manifest.webmanifest',
    handler: async (req2, res) => {
      const body = JSON.stringify({
        id: '/', name: 'DeepSeek Harness', short_name: 'DSH', start_url: '/', scope: '/', display: 'fullscreen',
        icons: [{ src: '/favicon.svg', sizes: '128x128', type: 'image/png', purpose: 'any' }],
      })
      res.writeHead(200, { 'content-type': 'application/manifest+json' })
      res.end(body)
    },
  }))
  ctx.tools.register(tool)
  try {
    registerOlapMode(ctx, disposers)
  } catch (e) {
    ctx.logger && ctx.logger.warn('yh-olap: olap mode init skipped: ' + (e && e.message))
  }
  return function dispose() {
    for (const d of disposers) { try { d() } catch {} }
  }
}
