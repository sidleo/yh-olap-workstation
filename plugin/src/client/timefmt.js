// 时间展示格式化（纯函数，无 React 依赖，供 Node 单测）。
//
// 下载/历史/详情里的时间后端会返回两种格式：
//   1) 2026-11-04 17:26:00 / 2026-11-04T17:26:00（ISO 风格）
//   2) 11/4/26 5:02:00 PM（美式 M/D/YY h:mm:ss AM|PM）
// 界面统一显示为 `MM-dd HH:mm`（两位补零、24 小时制）。
export function pad2(n) {
  const v = Math.trunc(Number(n)) || 0
  return (v < 10 ? '0' : '') + v
}

export function shortT(t) {
  if (t === undefined || t === null || t === '') return '-'
  const str = String(t).trim()
  if (!str) return '-'
  // 2026-11-04 17:26 / 2026-11-04T17:26:00
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})/)
  if (m) return pad2(m[2]) + '-' + pad2(m[3]) + ' ' + pad2(m[4]) + ':' + pad2(m[5])
  // 11/4/26 5:02:00 PM（AM/PM 可选，统一转 24 小时制）
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\s*(AM|PM)?/i)
  if (m) {
    let h = Number(m[4])
    const ap = (m[6] || '').toUpperCase()
    if (ap === 'AM' && h === 12) h = 0
    if (ap === 'PM' && h !== 12) h = h + 12
    return pad2(m[1]) + '-' + pad2(m[2]) + ' ' + pad2(h) + ':' + pad2(m[5])
  }
  // 只有日期：补 00:00
  m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return pad2(m[2]) + '-' + pad2(m[3]) + ' 00:00'
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (m) return pad2(m[1]) + '-' + pad2(m[2]) + ' 00:00'
  return str.length > 16 ? str.slice(0, 16) : str
}
