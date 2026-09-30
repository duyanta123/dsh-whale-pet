// lib/range.mjs 纯函数测试（sendFile Range 解析；2026-09-30 修复 Number('')===0 陷阱后固化）。
// 回归背景：旧实现把开放端 'bytes=0-' 解析成 end=0 只回 1 字节、'bytes=N-' 回 416，
// 浏览器 <video> 标准首请求即坏；后缀区间 'bytes=-N' 也按首 N 字节错误处理。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseByteRange } from '../lib/range.mjs'

test('无 Range 头 / 非字符串 → null（回 200 全量）', () => {
  assert.equal(parseByteRange(undefined, 1000), null)
  assert.equal(parseByteRange(null, 1000), null)
  assert.equal(parseByteRange(42, 1000), null)
})

test('语法非法（多区间/错误单位/空区间）→ null（忽略，回 200 全量）', () => {
  assert.equal(parseByteRange('bytes=0-1,3-4', 1000), null)
  assert.equal(parseByteRange('items=0-5', 1000), null)
  assert.equal(parseByteRange('bytes=-', 1000), null)
  assert.equal(parseByteRange('bytes=0 - 5', 1000), null)
  assert.equal(parseByteRange('bytes=abc-def', 1000), null)
})

test('开放端 bytes=0- → 全文件（此前误判 end=0 只回 1 字节）', () => {
  assert.deepEqual(parseByteRange('bytes=0-', 1000), { start: 0, end: 999 })
})

test('开放端 bytes=N- → N 到文件尾（此前误判 416）', () => {
  assert.deepEqual(parseByteRange('bytes=5-', 1000), { start: 5, end: 999 })
  assert.deepEqual(parseByteRange('bytes=999-', 1000), { start: 999, end: 999 })
})

test('闭区间 bytes=N-M → 端点钳制到 size-1', () => {
  assert.deepEqual(parseByteRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseByteRange('bytes=100-9999', 1000), { start: 100, end: 999 })
  assert.deepEqual(parseByteRange(' bytes=2-7 ', 1000), { start: 2, end: 7 }) // 容忍首尾空白
})

test('后缀区间 bytes=-N → 末尾 N 字节（此前误按首 N 字节）', () => {
  assert.deepEqual(parseByteRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseByteRange('bytes=-5000', 1000), { start: 0, end: 999 }) // N 超界钳到全文件
})

test('不可满足区间返回对象，由调用方按 start>end || start>=size 判 416', () => {
  // 起点越界
  const beyond = parseByteRange('bytes=1000-', 1000)
  assert.ok(beyond.start >= 1000)
  // end < start
  const inverted = parseByteRange('bytes=7-3', 1000)
  assert.ok(inverted.start > inverted.end)
  // bytes=-0 无内容可给
  const zeroSuffix = parseByteRange('bytes=-0', 1000)
  assert.ok(zeroSuffix.start > zeroSuffix.end)
})

test('空文件 size=0：bytes=0- 得 start=0/end=-1 → start>end 落到 416 判定面', () => {
  assert.deepEqual(parseByteRange('bytes=0-', 0), { start: 0, end: -1 })
})
