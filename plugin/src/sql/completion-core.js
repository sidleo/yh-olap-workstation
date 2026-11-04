// ===== WORKSTATION: SQL 补全核心（纯函数，无 React / DOM / 网络副作用）=====
// 从 client.js 的手写编辑器补全逻辑抽取，行为保持一致，供 CodeMirror 编辑器复用。
// 纯函数约定：
//   - 不读写 store、不发起 RPC、不碰 DOM；
//   - 「列/表是否已加载」由调用方保证：本模块只用传入的 schemas/tables/columns 做候选，
//     需要按需加载时由调用方先加载、再重新调用 buildCandidates（与旧 client.js 的 needCols 流程一致）。
// 候选 kind：'kw' 关键字 | 'fn' 函数 | 'sch' 库 | 'tbl' 表 | 'col' 字段 | 'alias' 别名（预留）。

import { engineWords } from './engine-words.js'

// 补全列表长度上限（与旧编辑器一致，防止大库全量列刷屏）
export const LIMIT = 40

// ===== 类型优先级（无上下文偏好时的默认排序：关键字 > 函数 > 库 > 表 > 字段）=====
// 与旧 client.js 的 kindRank 对齐：k=0 / f=1 / sch=2 / tbl=3 / col=4 / w=5。
// 兼容旧简写 kind（k/f），新代码统一使用 kw/fn。
const KIND_RANK = { kw: 0, fn: 1, sch: 2, tbl: 3, col: 4, alias: 5, w: 5 }
const KIND_ALIAS = { k: 'kw', f: 'fn' }

function lc(value) {
  return String(value == null ? '' : value).toLowerCase()
}

function toArray(value) {
  return Array.isArray(value) ? value : []
}

function normKind(kind) {
  const k = String(kind == null ? '' : kind)
  return KIND_ALIAS[k] || k
}

// ===== 当前正在输入的分段链 =====
// 如 'dim'、'dim.dim_'、'dim.dim_goods.'（含结尾是否有 .），从光标前文本尾部反推。
export function inputChain(before) {
  const m = String(before == null ? '' : before).match(/[A-Za-z0-9_\u4e00-\u9fa5.]+$/)
  if (!m) return { parts: [], endedWithDot: false }
  const raw = m[0]
  const parts = raw.split('.').map(function (p) { return p.trim() })
  return { parts: parts, endedWithDot: raw.charAt(raw.length - 1) === '.' }
}

// ===== 候选排序 =====
// 排序规则（与旧 client.js 一致）：匹配度 > 类型优先级 > 长度 > 名称。
//   匹配度：精确命中(0，会被过滤) > 以输入开头(1) > 中间包含(2) > 未命中(3，过滤)。
//   类型优先级：preferOrder 里的类型按顺序排最前（0..），其余类型按 KIND_RANK + preferOrder.length 接后。
// 过滤：已完整输入的候选（sc=0）不再补全；未匹配（sc=3）不展示。
export function rankMatches(items, word, preferOrder) {
  const lw = lc(word)
  const score = function (text) {
    const lt = lc(text)
    if (lt === lw) return 0
    if (lt.indexOf(lw) === 0) return 1
    if (lt.indexOf(lw) > 0) return 2
    return 3
  }
  const pref = toArray(preferOrder).filter(Boolean).map(normKind)
  const rankOf = function (kind) {
    const k = normKind(kind)
    const pi = pref.indexOf(k)
    if (pi !== -1) return pi // 偏好类型排最前，按偏好顺序
    // 其余类型排在偏好之后：基础 rank 加上偏好数量偏移，保持相对顺序
    const base = KIND_RANK[k] !== undefined ? KIND_RANK[k] : 6
    return base + pref.length
  }
  return toArray(items)
    .map(function (it) {
      return { it: it, sc: score(it && it.text), kr: rankOf(it && it.kind) }
    })
    .filter(function (x) { return x.sc > 0 && x.sc < 3 })
    .sort(function (a, b) {
      return a.sc - b.sc
        || a.kr - b.kr
        || String(a.it.text).length - String(b.it.text).length
        || String(a.it.text).localeCompare(String(b.it.text))
    })
    .map(function (x) { return x.it })
}

// ===== 根据光标前 SQL 语法位置推断期望补全类型 =====
// from/join/into/update/values 后 → 库/表；select/where/on/having/group by/order by/set 等 → 关键字/字段/函数。
// 无上下文关键字时返回 null（rankMatches 走默认排序）。
export function complPrefer(sqlBefore) {
  // 去掉末尾正在输入的词与尾部空白，分析到「输入词前」的语法位置
  const trimmed = String(sqlBefore == null ? '' : sqlBefore).replace(/[\s]*[A-Za-z0-9_\u4e00-\u9fa5.]*$/, '')
  const re = /\b(select|from|join|left join|right join|inner join|full join|cross join|outer join|on|where|having|group by|order by|set|into|values|update)\b/gi
  const ms = []
  let mm
  while ((mm = re.exec(trimmed)) !== null) ms.push(mm)
  if (!ms.length) return null
  const kw = String(ms[ms.length - 1][0]).trim().toLowerCase()
  if (kw === 'from' || kw.indexOf('join') !== -1 || kw === 'into' || kw === 'update' || kw === 'values') return ['sch', 'tbl']
  return ['kw', 'col', 'fn']
}

// ===== from/join 的表别名解析（纯函数版）=====
// 解析 `from db.t a`、`from dim.dim_shop`、`join dws.t as b` 等常见写法。
// 返回 { 别名小写: { schema, table } }（不含 schemaId/tableId）；无 schema 前缀时 schema 为 ''。
// 无别名时表名自身也映射（`from dim_shop` 后输入 `dim_shop.` 也能补字段）。
// 说明：名为 `join`/`where` 等关键字不会被误当别名（ALIAS_STOP）；命中关键字时把 lastIndex 回退到该词，
// 让下一轮还能把它当 `join` 子句重新匹配（否则 `from t join u b` 里的 join 会被当别名吞掉、丢掉 u）。
const ALIAS_STOP = new Set([
  'as', 'on', 'where', 'group', 'order', 'having', 'limit', 'union', 'join',
  'inner', 'left', 'right', 'full', 'outer', 'cross', 'semi', 'anti', 'using',
  'and', 'or', 'set', 'values', 'select', 'from', 'when', 'then', 'else', 'end',
  'window', 'qualify', 'lateral', 'tablesample', 'cluster', 'distribute', 'sort',
  'insert', 'overwrite', 'into', 'update', 'delete', 'partition', 'with',
])

export function aliasTableMap(sql) {
  const out = {}
  const text = String(sql == null ? '' : sql)
  // 逐段找 from/join 后面的 表名 [as] 别名
  const re = /\b(from|join|inner\s+join|left\s+join|right\s+join|full\s+join|cross\s+join)\s+([A-Za-z0-9_.\u4e00-\u9fa5]+)(?:\s+(?:as\s+)?([A-Za-z0-9_\u4e00-\u9fa5]+))?/gi
  let m
  while ((m = re.exec(text))) {
    const tbl = m[2]
    let alias = m[3] || ''
    if (alias && ALIAS_STOP.has(alias.toLowerCase())) {
      // 该词是 SQL 关键字而非别名：回退 lastIndex，让下一轮从这个词重新开始匹配
      alias = ''
      re.lastIndex = m.index + m[0].length - m[3].length
    }
    // 拆 库.表 或 表（多级时取最后两段：schema=倒数第二段，table=最后一段）
    const parts = tbl.split('.')
    const table = parts[parts.length - 1]
    const schema = parts.length > 1 ? parts[parts.length - 2] : ''
    if (!table) continue
    const entry = { schema: schema, table: table }
    // 有别名时只映射别名；无别名时 key 就是表名，表名自身也映射
    const key = lc(alias || table)
    if (!out[key]) out[key] = entry
  }
  return out
}

// ===== 关键字 / 函数候选（按当前输入词预筛，最终过滤仍由 rankMatches 完成）=====
export function keywordCandidates(engine, word) {
  const lw = lc(word)
  const out = []
  for (const keyword of engineWords(engine).keywords) {
    if (lw && lc(keyword).indexOf(lw) < 0) continue
    out.push({ text: keyword, kind: 'kw', desc: '' })
  }
  return out
}

export function functionCandidates(engine, word) {
  const lw = lc(word)
  const out = []
  for (const fn of engineWords(engine).functions) {
    if (lw && lc(fn).indexOf(lw) < 0) continue
    out.push({ text: fn, kind: 'fn' })
  }
  return out
}

// ===== 输入归一化 =====
function normalizeSchemas(list) {
  const out = []
  for (const item of toArray(list)) {
    const name = typeof item === 'string' ? item : (item && item.name)
    if (name) out.push(String(name))
  }
  return out
}

function normalizeTables(list) {
  const out = []
  for (const item of toArray(list)) {
    if (typeof item === 'string') {
      if (item) out.push({ schema: '', name: item })
      continue
    }
    if (!item || !item.name) continue
    out.push({ schema: item.schema == null ? '' : String(item.schema), name: String(item.name) })
  }
  return out
}

function normalizeColumns(list) {
  const out = []
  for (const item of toArray(list)) {
    if (!item || !item.name) continue
    out.push({
      schema: item.schema == null ? '' : String(item.schema),
      table: item.table == null ? '' : String(item.table),
      name: String(item.name),
      comment: item.comment || '',
      cnName: item.cnName || '',
      type: item.type || '',
    })
  }
  return out
}

// ===== 候选构造 / 查询小工具 =====
function columnItem(c) {
  return { text: c.name, kind: 'col', desc: c.cnName || c.comment || '字段' }
}

function columnsOf(columns, schemaName, tableName) {
  const s = lc(schemaName)
  const t = lc(tableName)
  if (!t) return []
  return columns.filter(function (c) {
    if (lc(c.table) !== t) return false
    return !s || lc(c.schema) === s
  })
}

function tablesOfSchema(tables, schemaName) {
  const s = lc(schemaName)
  if (!s) return []
  return tables.filter(function (t) { return t.schema && lc(t.schema) === s })
}

function schemaKnown(schemas, tables, columns, name) {
  const n = lc(name)
  if (!n) return false
  if (schemas.some(function (s) { return lc(s) === n })) return true
  if (tables.some(function (t) { return t.schema && lc(t.schema) === n })) return true
  if (columns.some(function (c) { return c.schema && lc(c.schema) === n })) return true
  return false
}

// 字段候选去重：同名同注释只留一个；同名不同注释（不同表的同名字段）保留，靠注释区分（与旧逻辑一致）
function dedupeSummaries(items) {
  const seen = new Set()
  const out = []
  for (const it of items) {
    const key = lc(it.text) + '\u0000' + String(it.desc || '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

function columnsForTargets(columns, targets) {
  const out = []
  for (const target of targets) {
    for (const item of columnsOf(columns, target.schema, target.table)) out.push(columnItem(item))
  }
  return dedupeSummaries(out)
}

// 别名是否指向「已加载」的表：表清单命中 或 列缓存里已有该表的列。
// 纯函数版无法像旧 client.js 那样用 findTable 验证存在性，故用已加载数据校验；
// 未命中的（如用户正输入的库名/表名前缀）视为「不是别名」，避免把 `from db` 里的 db 当表名。
function targetKnown(target, tables, columns) {
  const t = lc(target.table)
  const s = lc(target.schema)
  if (tables.some(function (x) { return lc(x.name) === t && (!s || lc(x.schema) === s) })) return true
  return columns.some(function (c) { return lc(c.table) === t && (!s || lc(c.schema) === s) })
}

function aliasTargets(amap, tables, columns) {
  const targets = []
  for (const key of Object.keys(amap)) {
    const hit = amap[key]
    if (targetKnown(hit, tables, columns)) targets.push({ schema: hit.schema, table: hit.table })
  }
  return targets
}

// 2 段上下文 `a.` 里 a 不是库时：按 表名 → 别名 → 已加载列里的表名 顺序解析真实表
function resolveTableTargets(head, tables, columns, sql) {
  const h = lc(head)
  const direct = tables.filter(function (t) { return lc(t.name) === h })
  if (direct.length) {
    return direct.map(function (t) { return { schema: t.schema || '', table: t.name } })
  }
  const aliasHit = aliasTableMap(sql)[h]
  if (aliasHit) {
    if (aliasHit.schema) return [{ schema: aliasHit.schema, table: aliasHit.table }]
    const loaded = tables.filter(function (t) { return lc(t.name) === lc(aliasHit.table) })
    if (loaded.length) {
      return loaded.map(function (t) { return { schema: t.schema || '', table: t.name } })
    }
    return [{ schema: '', table: aliasHit.table }]
  }
  // tables 清单未加载但列已在缓存里：按列上的 table 名兜底
  if (columns.some(function (c) { return c.table && lc(c.table) === h })) return [{ schema: '', table: head }]
  return []
}

// 输出裁剪：统一为 { text, kind, detail? }（detail 为展示用说明：库/表/字段注释）
function finish(items) {
  return toArray(items).slice(0, LIMIT).map(function (it) {
    const out = { text: String(it.text), kind: it.kind }
    if (it.desc) out.detail = String(it.desc)
    return out
  })
}

// ===== 补全入口 =====
// input: { engine, sql, before, schemas?, tables?, columns? }
//   engine  '1'|'2'|...（引擎编号；未知回退通用 SQL 词表）
//   sql     当前完整 SQL（用于 from/join 别名解析）
//   before  光标前文本（用于输入链 / 语法上下文；缺省用 sql）
//   schemas [{ name }]（已加载库）
//   tables  [{ schema, name }]（已加载库表）
//   columns [{ schema, table, name, comment, cnName, type }]（已加载列）
// 返回按 rankMatches 排序、长度 ≤ LIMIT 的 [{ text, kind, detail? }]。
export function buildCandidates(input) {
  const opts = input && typeof input === 'object' ? input : {}
  const sql = String(opts.sql == null ? '' : opts.sql)
  const before = String(opts.before == null ? sql : opts.before)
  const engine = opts.engine
  const schemas = normalizeSchemas(opts.schemas)
  const tables = normalizeTables(opts.tables)
  const columns = normalizeColumns(opts.columns)
  const chain = inputChain(before)
  const parts = chain.parts

  // ===== a.b.c：按 schema.table 返回列候选（b 为表）=====
  if (parts.length === 3) {
    const last = parts[2] || ''
    const cols = columnsOf(columns, parts[0], parts[1]).map(columnItem)
    return finish(rankMatches(cols, last))
  }

  // ===== a.b：a 是库 → 该库下的表；a 是表名/别名 → 该表的列 =====
  if (parts.length === 2) {
    const head = parts[0]
    const last = parts[1] || ''
    if (schemaKnown(schemas, tables, columns, head)) {
      const tableItems = tablesOfSchema(tables, head).map(function (t) {
        return { text: t.name, kind: 'tbl', desc: '表' }
      })
      return finish(rankMatches(tableItems, last))
    }
    const targets = resolveTableTargets(head, tables, columns, sql)
    if (!targets.length) return []
    const cols = columnsForTargets(columns, targets)
    return finish(rankMatches(cols, last))
  }

  // 段数 > 3（罕见）不补全
  if (parts.length > 3) return []

  // ===== 裸词：无前缀字段/关键字/函数补全 =====
  const word = parts[0] || ''
  if (!word) return []
  const preferOrder = complPrefer(before)
  const amap = aliasTableMap(sql)
  // 有 from/join 且别名指向已加载表 → 字段候选限定在这些表（避免全库误补）；
  // 库/表候选始终保留（`from db` 这类正在输入表名的场景要能补库表，与旧 rootCandidates 一致）。
  const targets = aliasTargets(amap, tables, columns)
  const columnsPart = targets.length
    ? columnsForTargets(columns, targets)
    : dedupeSummaries(columns.map(columnItem))
  const items = keywordCandidates(engine, word)
    .concat(
      functionCandidates(engine, word),
      schemas.map(function (s) { return { text: s, kind: 'sch', desc: '库' } }),
      tables.map(function (t) { return { text: t.name, kind: 'tbl', desc: '表' } }),
      columnsPart,
    )
  return finish(rankMatches(items, word, preferOrder))
}
