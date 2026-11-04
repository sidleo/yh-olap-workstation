// ===== 单测：SQL 补全核心（plugin/src/sql/completion-core.js）=====
// 运行：node --test test/unit/
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LIMIT,
  inputChain,
  rankMatches,
  complPrefer,
  aliasTableMap,
  keywordCandidates,
  functionCandidates,
  buildCandidates,
} from '../../plugin/src/sql/completion-core.js'

// 一份小型的「已加载」数据，供 buildCandidates 各场景复用
const SCHEMAS = [{ name: 'db1' }, { name: 'db2' }]
const TABLES = [
  { schema: 'db1', name: 't1' },
  { schema: 'db1', name: 't2' },
  { schema: 'db2', name: 't3' },
]
const COLUMNS = [
  { schema: 'db1', table: 't1', name: 'shop_id', comment: '门店编码' },
  { schema: 'db1', table: 't1', name: 'shop_sts', cnName: '门店状态' },
  { schema: 'db1', table: 't2', name: 'other_col', comment: '别的字段' },
  { schema: 'db2', table: 't3', name: 'good_id', comment: '商品编码' },
]
const DATA = { schemas: SCHEMAS, tables: TABLES, columns: COLUMNS }

function texts(list) {
  return list.map(function (item) { return item.text })
}

test('inputChain 解析光标前的输入链', () => {
  assert.deepEqual(inputChain('select nd'), { parts: ['nd'], endedWithDot: false })
  assert.deepEqual(inputChain('db.dim_'), { parts: ['db', 'dim_'], endedWithDot: false })
  assert.deepEqual(inputChain('db.'), { parts: ['db', ''], endedWithDot: true })
  assert.deepEqual(inputChain('db.dim_shop.'), { parts: ['db', 'dim_shop', ''], endedWithDot: true })
  assert.deepEqual(inputChain(''), { parts: [], endedWithDot: false })
  assert.deepEqual(inputChain('select * from '), { parts: [], endedWithDot: false })
  assert.deepEqual(inputChain('select 门店'), { parts: ['门店'], endedWithDot: false })
})

test('rankMatches：前缀命中排在包含命中之前', () => {
  const items = [
    { text: 'xabc', kind: 'col' },
    { text: 'abc', kind: 'kw' },
  ]
  assert.deepEqual(texts(rankMatches(items, 'ab', null)), ['abc', 'xabc'])
})

test('rankMatches：同匹配度下关键字(0)排在字段(4)之前', () => {
  const items = [
    { text: 'shop', kind: 'col' },
    { text: 'select', kind: 'kw' },
  ]
  assert.deepEqual(texts(rankMatches(items, 's', null)), ['select', 'shop'])
})

test('rankMatches：过滤精确命中与未匹配，支持 preferOrder 与旧 kind 简写', () => {
  // 已完整输入（精确命中）不再补全
  assert.deepEqual(rankMatches([{ text: 'select', kind: 'kw' }], 'select'), [])
  // 未匹配不展示
  assert.deepEqual(rankMatches([{ text: 'shop', kind: 'col' }], 'zzz'), [])

  const items = [
    { text: 'db1', kind: 'sch' },
    { text: 'd_table', kind: 'tbl' },
    { text: 'distinct', kind: 'kw' },
  ]
  assert.deepEqual(
    rankMatches(items, 'd', ['sch', 'tbl']).map(function (x) { return x.kind }),
    ['sch', 'tbl', 'kw'],
  )
  // 旧 client.js 的 kind 简写（k/f）仍可用
  const legacy = [
    { text: 'shop', kind: 'col' },
    { text: 'select', kind: 'k' },
  ]
  assert.deepEqual(texts(rankMatches(legacy, 's', ['k', 'col'])), ['select', 'shop'])
})

test('complPrefer：select 上下文关键字优先，from/join 上下文表优先', () => {
  assert.deepEqual(complPrefer('select '), ['kw', 'col', 'fn'])
  assert.deepEqual(complPrefer('select a, '), ['kw', 'col', 'fn'])
  assert.deepEqual(complPrefer('where '), ['kw', 'col', 'fn'])
  assert.deepEqual(complPrefer('group by '), ['kw', 'col', 'fn'])
  assert.deepEqual(complPrefer('on '), ['kw', 'col', 'fn'])

  assert.deepEqual(complPrefer('from '), ['sch', 'tbl'])
  assert.deepEqual(complPrefer('select * from '), ['sch', 'tbl'])
  assert.deepEqual(complPrefer('left join '), ['sch', 'tbl'])
  assert.deepEqual(complPrefer('insert into '), ['sch', 'tbl'])

  // 无语法上下文 → null（rankMatches 走默认类型排序）
  assert.equal(complPrefer('sel'), null)
  assert.equal(complPrefer(''), null)
})

test('aliasTableMap：解析 from/join 的表 [as] 别名（不含 id）', () => {
  const map = aliasTableMap('select * from db.t a join db2.t2 as b on a.id = b.id')
  assert.deepEqual(map.a, { schema: 'db', table: 't' })
  assert.deepEqual(map.b, { schema: 'db2', table: 't2' })
  // 关键字不能被当成别名
  assert.equal(map.join, undefined)
  assert.equal(map.on, undefined)

  // 无别名时表名自身也映射
  const noAlias = aliasTableMap('select * from dim.dim_shop where x = 1')
  assert.deepEqual(noAlias.dim_shop, { schema: 'dim', table: 'dim_shop' })
  assert.equal(noAlias.where, undefined)

  // from t join u b：无别名表的后面还能继续解析 join（关键字回退逻辑）
  const chained = aliasTableMap('select * from db.t join db2.t2 b on t.id = b.id')
  assert.deepEqual(chained.t, { schema: 'db', table: 't' })
  assert.deepEqual(chained.b, { schema: 'db2', table: 't2' })

  // 无 from/join / 空 SQL
  assert.deepEqual(aliasTableMap('select 1'), {})
  assert.deepEqual(aliasTableMap(''), {})
})

test('keywordCandidates / functionCandidates 候选形状与引擎差异', () => {
  const kws = keywordCandidates('2', 'nd')
  assert.ok(kws.length > 0)
  assert.ok(kws.every(function (c) { return c.kind === 'kw' && typeof c.text === 'string' && c.desc === '' }))
  assert.ok(kws.some(function (c) { return c.text === 'and' }))

  const fns = functionCandidates('2', 'nd')
  assert.ok(fns.length > 0)
  assert.ok(fns.every(function (c) { return c.kind === 'fn' }))
  assert.ok(fns.some(function (c) { return c.text === 'ndv' }))

  // hive 没有 ndv
  assert.deepEqual(functionCandidates('1', 'ndv'), [])
})

test('buildCandidates：impala 有 ndv、hive 没有', () => {
  const impala = buildCandidates({ engine: '2', sql: 'select nd', before: 'select nd' })
  assert.ok(impala.some(function (c) { return c.text === 'ndv' }), 'impala select nd 应含 ndv')
  assert.equal(impala[0].text, 'ndv', '前缀命中的 ndv 应排最前')

  const hive = buildCandidates({ engine: '1', sql: 'select nd', before: 'select nd' })
  assert.ok(!hive.some(function (c) { return c.text === 'ndv' }), 'hive 不应含 ndv')
})

test('buildCandidates：hive 有 collect_list、impala 没有', () => {
  const hive = buildCandidates({ engine: '1', sql: 'select collect_', before: 'select collect_' })
  assert.ok(hive.some(function (c) { return c.text === 'collect_list' }), 'hive 应含 collect_list')
  assert.ok(hive.some(function (c) { return c.text === 'collect_set' }), 'hive 应含 collect_set')

  const impala = buildCandidates({ engine: '2', sql: 'select collect_', before: 'select collect_' })
  assert.ok(!impala.some(function (c) { return c.text === 'collect_list' }), 'impala 不应含 collect_list')
})

test('buildCandidates：a. 且 a 是表（别名）→ 返回该表列', () => {
  const out = buildCandidates({
    engine: '2',
    sql: 'select * from db1.t1 a',
    before: 'select * from db1.t1 a.',
    schemas: SCHEMAS,
    tables: TABLES,
    columns: COLUMNS,
  })
  assert.ok(out.length > 0)
  assert.ok(out.every(function (c) { return c.kind === 'col' }))
  assert.ok(out.some(function (c) { return c.text === 'shop_id' || c.text === 'shop_sts' }))
  // detail 带字段注释/中文名
  assert.ok(out.some(function (c) { return c.text === 'shop_id' && c.detail === '门店编码' }))
  assert.ok(out.some(function (c) { return c.text === 'shop_sts' && c.detail === '门店状态' }))
})

test('buildCandidates：a. 且 a 是表名（无别名）→ 返回该表列', () => {
  const out = buildCandidates({
    engine: '2',
    sql: 'select * from db1.t1',
    before: 'select * from db1.t1.',
    schemas: SCHEMAS,
    tables: TABLES,
    columns: COLUMNS,
  })
  assert.ok(out.some(function (c) { return c.text === 'shop_id' }))
  assert.ok(!out.some(function (c) { return c.text === 'other_col' }))
})

test('buildCandidates：db. 且 db 是库 → 返回该库下 table 候选', () => {
  const out = buildCandidates({
    engine: '2',
    sql: 'select ',
    before: 'db1.',
    schemas: SCHEMAS,
    tables: TABLES,
    columns: COLUMNS,
  })
  assert.deepEqual(out.map(function (c) { return c.kind }), ['tbl', 'tbl'])
  assert.deepEqual(texts(out).sort(), ['t1', 't2'])
  assert.ok(out.every(function (c) { return c.detail === '表' }))
})

test('buildCandidates：db.t. → 返回 schema.table 的列候选', () => {
  const out = buildCandidates({
    engine: '2',
    sql: 'select ',
    before: 'db1.t1.',
    schemas: SCHEMAS,
    tables: TABLES,
    columns: COLUMNS,
  })
  assert.ok(out.length > 0)
  assert.ok(out.every(function (c) { return c.kind === 'col' }))
  assert.deepEqual(texts(out).sort(), ['shop_id', 'shop_sts'])
})

test('buildCandidates：无 from 的 sel 优先关键字', () => {
  const out = buildCandidates({ engine: '2', sql: 'sel', before: 'sel' })
  assert.ok(out.length > 0)
  assert.equal(out[0].kind, 'kw')
  assert.ok(out[0].text.startsWith('sel'))
})

test('buildCandidates：有 from/join 别名时字段候选限定在别名表', () => {
  const ctx = {
    engine: '2',
    sql: 'select * from db1.t1 a',
    before: 'select sh',
    schemas: SCHEMAS,
    tables: TABLES,
    columns: COLUMNS,
  }
  const out = buildCandidates(ctx)
  assert.ok(out.some(function (c) { return c.text === 'shop_id' }), '应含 t1 的列')
  assert.ok(!out.some(function (c) { return c.text === 'other_col' }), '不应含未 join 表的列')
  assert.ok(!out.some(function (c) { return c.text === 'good_id' }), '不应含未 join 表的列')
})

test('buildCandidates：无 from/join 时可用全部已加载列', () => {
  const out = buildCandidates({
    engine: '2',
    sql: 'select ',
    before: 'select ot',
    schemas: SCHEMAS,
    tables: TABLES,
    columns: COLUMNS,
  })
  assert.ok(out.some(function (c) { return c.text === 'other_col' }))
})

test('buildCandidates：from 上下文优先返回库/表候选', () => {
  const out = buildCandidates({
    engine: '2',
    sql: 'select * from db',
    before: 'select * from db',
    schemas: SCHEMAS,
    tables: TABLES,
    columns: COLUMNS,
  })
  assert.ok(out.length > 0)
  assert.equal(out[0].kind, 'sch')
  assert.equal(out[0].text, 'db1')
})

test('buildCandidates：LIMIT=40 截断，且未知引擎回退通用词表', () => {
  const many = []
  for (let i = 0; i < 120; i++) many.push({ schema: 's', table: 't', name: 'col_' + i })
  const out = buildCandidates({ engine: '2', sql: 'select c', before: 'select c', columns: many })
  assert.equal(out.length, LIMIT)
  assert.equal(LIMIT, 40)

  // 引擎 '9' 未注册 → DEFAULT 词表（含 current_date）
  const fallback = buildCandidates({ engine: '9', sql: 'select curr', before: 'select curr' })
  assert.ok(fallback.some(function (c) { return c.text === 'current_date' }))
})

test('buildCandidates：空/异常输入不抛错', () => {
  assert.deepEqual(buildCandidates(), [])
  assert.deepEqual(buildCandidates({}), [])
  assert.deepEqual(buildCandidates({ engine: '2', sql: '', before: '' }), [])
  assert.deepEqual(buildCandidates({ engine: '2', sql: 'select ', before: 'select ' }), [])
  // 段数 > 3 不补全
  assert.deepEqual(buildCandidates({ engine: '2', sql: 'a.b.c.d', before: 'a.b.c.d' }), [])
})
