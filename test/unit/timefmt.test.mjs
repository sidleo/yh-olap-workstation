// timefmt：下载/历史/详情时间统一为 MM-dd HH:mm（两位补零、24 小时制）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shortT, pad2 } from '../../plugin/src/client/timefmt.js'

test('pad2 补零', () => {
  assert.equal(pad2(0), '00')
  assert.equal(pad2(5), '05')
  assert.equal(pad2(11), '11')
  assert.equal(pad2(17), '17')
})

test('ISO 风格：YYYY-MM-DD HH:mm(:ss) → MM-dd HH:mm', () => {
  assert.equal(shortT('2026-11-04 17:26:00'), '11-04 17:26')
  assert.equal(shortT('2026-11-04T09:05:00+08:00'), '11-04 09:05')
  assert.equal(shortT('2026-01-02 03:04:05'), '01-02 03:04')
})

test('美式风格：M/D/YY h:mm(:ss) AM/PM → MM-dd HH:mm（24 小时制）', () => {
  assert.equal(shortT('11/4/26 5:02:00 PM'), '11-04 17:02')
  assert.equal(shortT('11/4/26 5:02 AM'), '11-04 05:02')
  assert.equal(shortT('11/4/26 12:00:00 AM'), '11-04 00:00')
  assert.equal(shortT('11/4/26 12:30:00 PM'), '11-04 12:30')
  assert.equal(shortT('1/2/26 9:07:00 PM'), '01-02 21:07')
})

test('只有日期 → 补 00:00', () => {
  assert.equal(shortT('2026-11-04'), '11-04 00:00')
  assert.equal(shortT('11/4/26'), '11-04 00:00')
})

test('空值 → -', () => {
  assert.equal(shortT(undefined), '-')
  assert.equal(shortT(null), '-')
  assert.equal(shortT(''), '-')
  assert.equal(shortT('   '), '-')
})
