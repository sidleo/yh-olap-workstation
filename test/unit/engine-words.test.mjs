// ===== 单测：引擎词表（plugin/src/sql/engine-words.js）=====
// 运行：node --test test/unit/
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IMPALA,
  HIVE,
  DEFAULT,
  ENGINE_WORDS,
  engineWords,
  expandKeywords,
} from '../../plugin/src/sql/engine-words.js'

const WORDLISTS = [['impala', IMPALA], ['hive', HIVE], ['default', DEFAULT]]
const STRICT_ENGINES = [['impala', IMPALA], ['hive', HIVE]]

test('词表非空且结构完整（keywords / functions / types）', () => {
  for (const [name, words] of WORDLISTS) {
    assert.ok(Array.isArray(words.keywords) && words.keywords.length > 0, name + ': keywords 为空')
    assert.ok(Array.isArray(words.functions) && words.functions.length > 0, name + ': functions 为空')
    assert.ok(Array.isArray(words.types) && words.types.length > 0, name + ': types 为空')
  }
  // 精确引擎词表规模兜底（旧实现 impala 131 / hive 208 个函数），防止未来误删成残缺表
  assert.ok(IMPALA.keywords.length >= 100, 'impala 关键字数量异常: ' + IMPALA.keywords.length)
  assert.ok(IMPALA.functions.length >= 120, 'impala 函数数量异常: ' + IMPALA.functions.length)
  assert.ok(HIVE.keywords.length >= 110, 'hive 关键字数量异常: ' + HIVE.keywords.length)
  assert.ok(HIVE.functions.length >= 190, 'hive 函数数量异常: ' + HIVE.functions.length)
})

test('词表 token 均为小写、无重复、无空串', () => {
  for (const [name, words] of WORDLISTS) {
    for (const field of ['keywords', 'functions', 'types']) {
      const seen = new Set()
      for (const word of words[field]) {
        assert.equal(typeof word, 'string', name + '.' + field + ' 含非字符串 token')
        assert.notEqual(word, '', name + '.' + field + ' 含空 token')
        assert.equal(word, word.trim(), name + '.' + field + ' token 未 trim: ' + JSON.stringify(word))
        assert.equal(word, word.toLowerCase(), name + '.' + field + ' token 未小写: ' + word)
        assert.ok(!seen.has(word), name + '.' + field + ' 重复 token: ' + word)
        seen.add(word)
      }
    }
    // 函数/类型必须是单个 token；关键字允许多词条目（'group by'），但内部只能有单空格
    for (const fn of words.functions.concat(words.types)) {
      assert.ok(!/\s/.test(fn), name + ' 函数/类型含空白: ' + JSON.stringify(fn))
    }
    for (const kw of words.keywords) {
      assert.ok(!/\s{2,}/.test(kw), name + ' 关键字内部多空格: ' + JSON.stringify(kw))
    }
  }
})

test('修复旧词表的 NaN 前缀 / 粘连 token bug（回归）', () => {
  // 旧 client.js 的一元 + 拼接：IMPALA_FUNCS[0] === 'NaNceil'、HIVE_FUNCS[0] === 'NaNbtrim'，首行函数全丢
  for (const [name, words] of STRICT_ENGINES) {
    for (const fn of words.functions) {
      assert.ok(!fn.includes('NaN'), name + ' 函数含 NaN（旧一元 + bug 残留）: ' + fn)
      // 长度异常：不能出现 >25 字符且不含下划线的纯英文串（真实长名如 regexp_extract / current_timestamp 都带 _）
      assert.ok(!/^[a-z]{25,}$/.test(fn), name + ' 出现异常长 token: ' + fn)
    }
    // 关键字同样不能有 NaN / 空白异常 token
    for (const kw of words.keywords) {
      assert.ok(!kw.includes('NaN'), name + ' 关键字含 NaN: ' + kw)
    }
    // 首行函数不能再丢：abs/ceil/acos 必须存在
    for (const fn of ['abs', 'ceil', 'acos']) {
      assert.ok(words.functions.includes(fn), name + ' 首行函数丢失: ' + fn)
    }
    // 粘连判据：新 token 不得恰好由「两个已知函数名直接拼接」得到
    // （旧 bug 的 current_databasecurrent_timestamp / date_subdatediff / eexp / valuevariance 等都会被这条抓住）
    const known = new Set(words.functions)
    for (const fn of words.functions) {
      for (const prefix of words.functions) {
        if (prefix === fn || !fn.startsWith(prefix)) continue
        const suffix = fn.slice(prefix.length)
        assert.ok(
          !known.has(suffix),
          name + ' 出现粘连 token: ' + fn + ' = ' + prefix + ' + ' + suffix,
        )
      }
    }
    // 旧版实测粘连样本的显式黑名单（双保险）
    const BAD_GLUE = [
      'NaNceil', 'NaNbtrim', 'current_databasecurrent_timestamp', 'date_subdatediff',
      'months_addmonths_between', 'regexp_replacerepeat', 'is_infis_nan', 'eexp',
      'ifinitcap', 'log10log2', 'minutemod', 'varianceversion', 'corrcos', 'sinsize',
    ]
    for (const bad of BAD_GLUE) {
      assert.ok(!words.functions.includes(bad), name + ' 重新出现粘连 token: ' + bad)
    }
  }
})

test('impala 关键函数齐全（实测清单）', () => {
  for (const fn of ['abs', 'ceil', 'current_database', 'current_timestamp', 'ndv', 'row_number', 'date_add']) {
    assert.ok(IMPALA.functions.includes(fn), 'impala 缺少关键函数: ' + fn)
  }
})

test('hive 关键函数齐全（Hive 3.1 清单）', () => {
  for (const fn of ['abs', 'btrim', 'collect_list', 'collect_set', 'date_format', 'get_json_object', 'row_number', 'regexp_replace']) {
    assert.ok(HIVE.functions.includes(fn), 'hive 缺少关键函数: ' + fn)
  }
})

test('两引擎函数集差异真实存在', () => {
  assert.ok(IMPALA.functions.includes('ndv'), 'impala 应有 ndv')
  assert.ok(!HIVE.functions.includes('ndv'), 'hive 不应有 ndv')
  assert.ok(IMPALA.functions.includes('current_database'), 'impala 应有 current_database')
  assert.ok(HIVE.functions.includes('collect_list'), 'hive 应有 collect_list')
  assert.ok(!IMPALA.functions.includes('collect_list'), 'impala 不应有 collect_list')
  assert.ok(HIVE.functions.includes('get_json_object'), 'hive 应有 get_json_object')
  assert.notDeepEqual(IMPALA.functions, HIVE.functions)
})

test('多词关键字保留完整条目 + expandKeywords 展开逐词', () => {
  assert.ok(IMPALA.keywords.includes('kudu'), 'impala 关键字应含 kudu')
  assert.ok(IMPALA.keywords.includes('compute stats'), 'impala 关键字应含多词 compute stats')
  assert.ok(HIVE.keywords.includes('lateral view'), 'hive 关键字应含多词 lateral view')
  assert.ok(HIVE.keywords.includes('msck repair'), 'hive 关键字应含多词 msck repair')

  const impalaKeys = expandKeywords(IMPALA.keywords)
  assert.ok(impalaKeys instanceof Set)
  assert.ok(impalaKeys.has('kudu'))
  assert.ok(impalaKeys.has('compute'))
  assert.ok(impalaKeys.has('stats'))

  const hiveKeys = expandKeywords(HIVE.keywords)
  assert.ok(hiveKeys.has('lateral'))
  assert.ok(hiveKeys.has('view'))
  assert.ok(hiveKeys.has('msck'))
  assert.ok(hiveKeys.has('repair'))
  // 逐词集合必须全部小写
  for (const word of hiveKeys) assert.equal(word, word.toLowerCase())
})

test('expandKeywords 规范化输入：小写、去重、多空格、异常输入', () => {
  const set = expandKeywords(['Group By', 'group  by', 'KUDU'])
  assert.deepEqual([...set].sort(), ['by', 'group', 'group by', 'kudu'])
  assert.deepEqual([...expandKeywords([])], [])
  assert.deepEqual([...expandKeywords(null)], [])
  assert.deepEqual([...expandKeywords(undefined)], [])
  // 也接受逗号分隔字符串
  assert.ok(expandKeywords('GROUP BY,kudu').has('group'))
})

test('types 为公共 SQL 类型', () => {
  const required = ['int', 'bigint', 'string', 'double', 'float', 'boolean', 'timestamp', 'date', 'decimal', 'array', 'map', 'struct']
  for (const type of required) {
    assert.ok(DEFAULT.types.includes(type), 'default types 缺少: ' + type)
    assert.ok(IMPALA.types.includes(type), 'impala types 缺少: ' + type)
    assert.ok(HIVE.types.includes(type), 'hive types 缺少: ' + type)
  }
  assert.deepEqual(IMPALA.types, HIVE.types)
})

test('engineWords 引擎映射与未知引擎回退 default', () => {
  assert.equal(engineWords('1'), HIVE)
  assert.equal(engineWords('2'), IMPALA)
  assert.equal(engineWords('3'), DEFAULT)
  assert.equal(engineWords('4'), DEFAULT)
  assert.equal(engineWords('hive'), DEFAULT)
  assert.equal(engineWords('unknown'), DEFAULT)
  assert.equal(engineWords(undefined), DEFAULT)
  assert.equal(engineWords(null), DEFAULT)
  assert.equal(ENGINE_WORDS.default, DEFAULT)
  assert.equal(ENGINE_WORDS['1'], HIVE)
  assert.equal(ENGINE_WORDS['2'], IMPALA)
  assert.notDeepEqual(engineWords('1').functions, engineWords('2').functions)
})
