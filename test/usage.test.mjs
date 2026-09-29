// M3-6 计费核心单测：价目分档（峰谷/平价）、事件折叠（去重/重试/模型路由）、
// 显示格式化与任务气泡行。口径对照 whale-girl 同名测试域；价目数值摘自其 lib/usage.js。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPeakBeijing, tierOfModel, rateAt, foldUsage, usageSampleOfEvent,
  fmtTokens, money, taskSummaryLines,
} from '../lib/usage.mjs'

// ---- 时间锚点（2026-09-14 为周一；02:00 UTC = 北京 10:00 高峰）----
const FLAT_ERA = Date.UTC(2026, 6, 1, 4, 0) // 2026-07-01 平价档
const PEAK_MON = Date.UTC(2026, 8, 14, 2, 0) // 周一北京 10:00 → 高峰
const PEAK_MON_AFTERNOON = Date.UTC(2026, 8, 14, 6, 30) // 北京 14:30 → 高峰
const OFF_MON_EVENING = Date.UTC(2026, 8, 14, 10, 30) // 北京 18:30 → 空闲
const SATURDAY = Date.UTC(2026, 8, 12, 2, 0) // 周末全天空闲

const usage = (input, cacheRead, cacheWrite, output) => ({
  inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output,
})
const msg = (turn, step, u, time, extra = {}) => ({
  type: 'assistant/message', time, data: { turn, step, usage: u, ...extra },
})

test('isPeakBeijing：工作日 9-12/14-18 高峰，周末与夜间空闲', () => {
  assert.equal(isPeakBeijing(PEAK_MON), true)
  assert.equal(isPeakBeijing(PEAK_MON_AFTERNOON), true)
  assert.equal(isPeakBeijing(OFF_MON_EVENING), false)
  assert.equal(isPeakBeijing(SATURDAY), false)
})

test('tierOfModel：含 flash 走 flash 价，其余走 pro 价', () => {
  assert.equal(tierOfModel('deepseek-flash'), 'flash')
  assert.equal(tierOfModel('DeepSeek-V4-Pro'), 'pro')
  assert.equal(tierOfModel(''), 'pro')
  assert.equal(tierOfModel(undefined), 'pro')
})

test('rateAt：平价档 regime=flat 不分峰谷', () => {
  const flat = rateAt('deepseek-flash', FLAT_ERA)
  assert.equal(flat.regime, 'flat')
  assert.equal(flat.hit, 0.02)
  assert.equal(flat.miss, 1)
  assert.equal(flat.out, 2)
  const proFlat = rateAt('deepseek-v4-pro', FLAT_ERA)
  assert.equal(proFlat.regime, 'flat')
  assert.equal(proFlat.hit, 0.025)
  assert.equal(proFlat.miss, 3)
  assert.equal(proFlat.out, 6)
})

test('rateAt：换价后高峰 ×2、空闲原价（2026-09-10 档 flash）', () => {
  const peak = rateAt('deepseek-flash', PEAK_MON)
  assert.equal(peak.regime, 'peak')
  assert.equal(peak.hit, 0.04) // 0.02 × 2
  assert.equal(peak.miss, 2) // 1 × 2
  assert.equal(peak.out, 8) // 4 × 2
  const off = rateAt('deepseek-flash', OFF_MON_EVENING)
  assert.equal(off.regime, 'off')
  assert.equal(off.hit, 0.02)
  assert.equal(off.out, 4)
  // pro 档（2026-08-16 起）：高峰 0.15/4.5/13.5。
  const proPeak = rateAt('deepseek-v4-pro', PEAK_MON)
  assert.equal(proPeak.regime, 'peak')
  assert.equal(proPeak.out, 27) // 13.5 × 2
})

test('usageSampleOfEvent：单事件折叠（buckets + 选档计费）', () => {
  const sample = usageSampleOfEvent(msg('t1', 1, usage(1e6, 1e6, 0, 1e6), PEAK_MON), 'deepseek-flash')
  assert.equal(sample.turn, 't1')
  assert.equal(sample.input, 1e6)
  assert.equal(sample.costHit, 0.04)
  assert.equal(sample.costMiss, 2)
  assert.equal(sample.costOut, 8)
  assert.ok(Math.abs(sample.cost - 10.04) < 1e-9)
  assert.equal(sample.regime, 'peak')
  assert.equal(usageSampleOfEvent({ type: 'assistant/message', data: {} }), undefined)
})

test('foldUsage：同 (turn,step) 后到替换先到（替换样本从汇总扣回）', () => {
  const events = [
    msg('t1', 1, usage(100, 0, 0, 100), FLAT_ERA + 1000),
    msg('t1', 1, usage(300, 0, 0, 300), FLAT_ERA + 2000),
  ]
  const fold = foldUsage(events, 0)
  assert.equal(fold.totals.input, 300) // 只计后到样本
  assert.equal(fold.totals.output, 300)
})

test('foldUsage：llm/retry-started 关闭替换槽，重试样本累加（两次真实计费）', () => {
  const events = [
    msg('t1', 1, usage(100, 0, 0, 100), FLAT_ERA + 1000),
    { type: 'llm/retry-started', time: FLAT_ERA + 1500, data: { turn: 't1', step: 1 } },
    msg('t1', 1, usage(200, 0, 0, 200), FLAT_ERA + 2000),
  ]
  const fold = foldUsage(events, 0)
  assert.equal(fold.totals.input, 300) // 100 + 200 都计入
  assert.equal(fold.totals.output, 300)
})

test('foldUsage：request/header·context 更新模型路由（flash 走 flash 价）', () => {
  const events = [
    { type: 'request/header', time: FLAT_ERA, data: { header: { config: { model: 'deepseek-flash' } } } },
    msg('t1', 1, usage(1e6, 0, 0, 0), FLAT_ERA + 1000),
  ]
  const fold = foldUsage(events, 0)
  assert.ok(fold.models.has('deepseek-flash'))
  assert.ok(Math.abs(fold.costs.miss - 1) < 1e-9) // flash 平价 miss=1
})

test('foldUsage：sinceMs 之前的事件不计入（但替换槽仍生效）', () => {
  const events = [
    msg('t1', 1, usage(100, 0, 0, 100), FLAT_ERA),
    msg('t1', 1, usage(400, 0, 0, 400), FLAT_ERA + 5000), // sinceMs 之后
  ]
  const fold = foldUsage(events, FLAT_ERA + 1000)
  assert.equal(fold.totals.input, 400) // 只计 since 后的后到样本
})

test('foldUsage：跨换价/跨峰谷逐事件选档（同一任务两段各自计价）', () => {
  const events = [
    { type: 'request/header', time: FLAT_ERA, data: { header: { config: { model: 'deepseek-flash' } } } },
    msg('t1', 1, usage(1e6, 0, 0, 0), FLAT_ERA + 1000), // 平价 miss=1 → ¥1
    msg('t1', 2, usage(1e6, 0, 0, 0), PEAK_MON), // 高峰 miss=2 → ¥2
  ]
  const fold = foldUsage(events, 0)
  assert.ok(Math.abs(fold.costs.miss - 3) < 1e-9)
  assert.ok(Math.abs(fold.regimes.flat - 1) < 1e-9)
  assert.ok(Math.abs(fold.regimes.peak - 2) < 1e-9)
})

test('fmtTokens / money：人性化显示', () => {
  assert.equal(fmtTokens(1234567), '1.23M')
  assert.equal(fmtTokens(12345), '12.3k')
  assert.equal(fmtTokens(999), '999')
  assert.equal(money(0.005), '<¥0.01')
  assert.equal(money(1.234), '≈¥1.23')
  assert.equal(money(0), '≈¥0.00')
})

test('taskSummaryLines：三要素齐全（用时/消耗/花费 + 三桶）', () => {
  const usageSummary = {
    ok: true, total: 1234567, costCny: 0.5, costHitCny: 0.1, costMissCny: 0.3, costOutCny: 0.1,
  }
  const lines = taskSummaryLines('2分35秒', usageSummary)
  assert.deepEqual(lines, [
    '用时 2分35秒',
    '消耗 1.23M tokens',
    '花费 ≈¥0.50',
    '· 缓存命中 ≈¥0.10',
    '· 缓存未命中 ≈¥0.30',
    '· 输出 ≈¥0.10',
  ])
  // 无用量：只给用时行。
  assert.deepEqual(taskSummaryLines('1秒', { ok: false, total: 0 }), ['用时 1秒'])
})
