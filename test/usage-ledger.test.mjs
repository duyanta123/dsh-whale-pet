// M3-6 时间桶账本单测：北京时区小时/日桶、替换扣回、保留窗淘汰、快照合计。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUsageLedger, hourBucketStart, dayBucketStart } from '../lib/usage-ledger.mjs'

const BJ = 8 * 3600e3
const msg = (turn, step, u, time) => ({
  type: 'assistant/message', time, data: { turn, step, usage: u },
})
const usage = (input, cacheRead, cacheWrite, output) => ({
  inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output,
})

test('hourBucketStart / dayBucketStart：北京时区对齐', () => {
  const t = Date.UTC(2026, 8, 14, 2, 30) // 北京 10:30
  assert.equal(hourBucketStart(t), Date.UTC(2026, 8, 14, 2, 0))
  assert.equal(dayBucketStart(t), Math.floor((t + BJ) / 864e5) * 864e5 - BJ)
})

test('fold：无 usage 事件静默跳过；usage 事件按时间戳入桶', () => {
  const now = Date.UTC(2026, 8, 14, 3, 0)
  const ledger = createUsageLedger({ now: () => now })
  ledger.fold({ type: 'request/header', time: now, data: { header: { config: { model: 'deepseek-flash' } } } })
  ledger.fold(msg('t1', 1, usage(1e6, 0, 0, 0), now))
  const snap = ledger.snapshot()
  assert.equal(snap.totals.today.tokens.input, 1e6)
  assert.equal(snap.hours.length, 1)
  assert.equal(snap.days.length, 1)
  assert.ok(snap.totals.today.models.includes('deepseek-flash'))
})

test('fold：同 (turn,step) 替换从旧桶扣回（跨小时边界也正确）', () => {
  const h1 = Date.UTC(2026, 8, 14, 2, 30) // 小时桶 A
  const h2 = Date.UTC(2026, 8, 14, 3, 30) // 小时桶 B
  const ledger = createUsageLedger({ now: () => h2 + 1000 })
  ledger.fold(msg('t1', 1, usage(100, 0, 0, 100), h1))
  ledger.fold(msg('t1', 1, usage(300, 0, 0, 300), h2))
  const snap = ledger.snapshot()
  const hourA = snap.hours.find((b) => b.start === hourBucketStart(h1))
  const hourB = snap.hours.find((b) => b.start === hourBucketStart(h2))
  assert.equal(hourA.tokens.input, 0) // 旧样本已扣回
  assert.equal(hourB.tokens.input, 300)
  assert.equal(snap.totals.window.tokens.input, 300) // 窗口合计不重复计
})

test('snapshot：today 与 window 分开（昨日样本只进 window）', () => {
  const yesterday = Date.UTC(2026, 8, 13, 2, 0)
  const today = Date.UTC(2026, 8, 14, 2, 0)
  const ledger = createUsageLedger({ now: () => today + 1000, windowDays: 7 })
  ledger.fold(msg('t1', 1, usage(100, 0, 0, 0), yesterday))
  ledger.fold(msg('t1', 2, usage(200, 0, 0, 0), today))
  const snap = ledger.snapshot()
  assert.equal(snap.totals.today.tokens.input, 200)
  assert.equal(snap.totals.window.tokens.input, 300)
})

test('保留窗：windowDays 外的旧桶淘汰', () => {
  const old = Date.UTC(2026, 7, 1, 2, 0) // 远超 7 天前
  const now = Date.UTC(2026, 8, 14, 2, 0)
  const ledger = createUsageLedger({ now: () => now, windowDays: 7 })
  ledger.fold(msg('t1', 1, usage(100, 0, 0, 0), old))
  ledger.fold(msg('t1', 2, usage(200, 0, 0, 0), now))
  const snap = ledger.snapshot()
  assert.equal(snap.days.length, 1) // 旧日桶被淘汰
  assert.equal(snap.totals.window.tokens.input, 200)
})

test('dispose：清空账本（幂等）', () => {
  const ledger = createUsageLedger({})
  ledger.fold(msg('t1', 1, usage(1, 0, 0, 1), Date.now()))
  ledger.dispose()
  ledger.dispose()
  const snap = ledger.snapshot()
  assert.equal(snap.totals.window.tokens.total, 0)
})
