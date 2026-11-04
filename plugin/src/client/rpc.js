// Host RPC 客户端：POST /api/yh-olap/rpc。
//
// 桌面 App（Electron）的页面 origin 是 dsh-app://app，不能用相对路径（会解析到
// dsh-app://app/api/... → 404），必须用 __DSH_TRANSPORT__.streamBaseUrl 的绝对地址；
// Host 侧对白名单 Origin 回 CORS 头（见 host.js corsHeadersFor）。
// Web 浏览器直开时 streamBaseUrl 可能没有，回退同源相对路径。

function transportBase() {
  try {
    const t = typeof window !== 'undefined' ? window.__DSH_TRANSPORT__ : null
    if (t && typeof t.streamBaseUrl === 'string' && t.streamBaseUrl) return t.streamBaseUrl.replace(/\/+$/, '')
  } catch (e) { /* ignore */ }
  return ''
}

export function rpcUrl() {
  const base = transportBase()
  if (base) return base + '/api/yh-olap/rpc'
  return '/api/yh-olap/rpc'
}

export function callHost(method, args) {
  let url
  try { url = rpcUrl() } catch (e) { url = '/api/yh-olap/rpc' }
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: method, args: args === undefined ? {} : args }),
    credentials: 'omit',
    cache: 'no-store',
  }).then(function (r) {
    return r.json()
  }).catch(function (e) {
    return { ok: false, error: 'rpc failed: ' + String((e && e.message) || e) }
  })
}
