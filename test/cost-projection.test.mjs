// M3-6 费用投影单测：会话级投影 / 单轮归属 / 同步替换去重 / 平价档峰谷口径 / 无用量兜底。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectSessionCost, projectTurnCost } from '../lib/cost-projection.mjs'

const FLAT_ERA = Date.UTC(2026, 6, 1, 4, 0)
const usage = (input, cacheRead, cacheWrite, output) => ({
  inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output,
})
const msg = (turn, step, u, time) => ({
  type: 'assistant/message', time, data: { turn, step, usage: u },
})
// assistant/attempt 嵌入 stream 尾部的 usage chunk（DSH ≥0.1.3 的双上报形态之一）。
const attemptStreamUsage = (turn, step, u, time) => ({
  type: 'assistant/attempt', time,
  data: { turn, step, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: u } }] },
})

test('projectSessionCost：会话级合计（tokens + 三桶费用）', () => {
  const events = [
    { type: 'request/header', time: FLAT_ERA, data: { header: { config: { model: 'deepseek-flash' } } } },
    msg('t1', 1, usage(1e6, 0, 0, 0), FLAT_ERA + 1000),
    msg('t1', 2, usage(0, 1e6, 0, 0), FLAT_ERA + 2000),
  ]
  const out = projectSessionCost(events, 0)
  assert.equal(out.ok, true)
  assert.equal(out.total, 2e6)
  assert.ok(Math.abs(out.costCny - 1.02) < 1e-9) // miss 1e6×1/1e6=1 + hit 1e6×0.02/1e6=0.02
  assert.ok(Math.abs(out.costHitCny - 0.02) < 1e-9)
  assert.ok(Math.abs(out.costMissCny - 1) < 1e-9)
})

test('projectTurnCost：单轮归属（其他轮不计入）', () => {
  const events = [
    { type: 'request/header', time: FLAT_ERA, data: { header: { config: { model: 'deepseek-flash' } } } },
    msg('t1', 1, usage(1e6, 0, 0, 0), FLAT_ERA + 1000),
    msg('t2', 1, usage(2e6, 0, 0, 0), FLAT_ERA + 2000),
  ]
  const t1 = projectTurnCost(events, 't1')
  assert.equal(t1.ok, true)
  assert.equal(t1.total, 1e6)
  assert.ok(Math.abs(t1.costCny - 1) < 1e-9)
  const t2 = projectTurnCost(events, 't2')
  assert.ok(Math.abs(t2.costCny - 2) < 1e-9)
  const none = projectTurnCost(events, 't3')
  assert.equal(none.ok, false)
  assert.equal(none.total, 0)
})

test('projectTurnCost：同 (turn,step) 双上报只计后到（Σ每轮 = 会级口径）', () => {
  const events = [
    { type: 'request/header', time: FLAT_ERA, data: { header: { config: { model: 'deepseek-flash' } } } },
    // 同一步两份 usage：attempt 的 stream 尾 chunk + message 的 data.usage，后到替换先到。
    attemptStreamUsage('t1', 1, usage(100, 0, 0, 100), FLAT_ERA + 1000),
    msg('t1', 1, usage(300, 0, 0, 300), FLAT_ERA + 2000),
    msg('t2', 1, usage(1e6, 0, 0, 0), FLAT_ERA + 3000),
  ]
  const session = projectSessionCost(events, 0)
  assert.equal(session.total, 1e6 + 600) // t1 只计后到样本 300+300
  const t1 = projectTurnCost(events, 't1')
  const t2 = projectTurnCost(events, 't2')
  assert.equal(t1.ok, true)
  assert.equal(t1.total, 600)
  assert.ok(Math.abs(t1.costCny - 0.0009) < 1e-9) // miss 300×1/1e6 + out 300×2/1e6
  assert.equal(t1.total + t2.total, session.total)
  assert.ok(Math.abs(t1.costCny + t2.costCny - session.costCny) < 1e-9)
})

test('projectTurnCost：llm/retry-started 关闭替换槽，重试样本累加（同 foldUsage）', () => {
  const events = [
    { type: 'request/header', time: FLAT_ERA, data: { header: { config: { model: 'deepseek-flash' } } } },
    msg('t1', 1, usage(100, 0, 0, 100), FLAT_ERA + 1000),
    { type: 'llm/retry-started', time: FLAT_ERA + 1500, data: { turn: 't1', step: 1 } },
    msg('t1', 1, usage(200, 0, 0, 200), FLAT_ERA + 2000),
  ]
  const session = projectSessionCost(events, 0)
  const t1 = projectTurnCost(events, 't1')
  assert.equal(t1.total, 600) // 两次真实计费都计入
  assert.ok(Math.abs(t1.costCny - session.costCny) < 1e-9)
})

test('projectSessionCost：平价档并入空闲桶（峰谷之和 = 总额）', () => {
  const events = [
    { type: 'request/header', time: FLAT_ERA, data: { header: { config: { model: 'deepseek-v4-pro' } } } },
    // pro 档 2026-08-16 换价前 peakMultiplier=1 → regime=flat（usage.mjs:32/:64-65）。
    msg('t1', 1, usage(1e6, 0, 0, 0), FLAT_ERA + 1000),
  ]
  const out = projectSessionCost(events, 0)
  assert.ok(Math.abs(out.costCny - 3) < 1e-9) // pro 平价 miss=3
  assert.equal(out.costPeakCny, 0)
  assert.ok(Math.abs(out.costOffCny - 3) < 1e-9) // flat 份额不丢，并入空闲桶
  assert.ok(Math.abs(out.costCny - (out.costPeakCny + out.costOffCny)) < 1e-9)
})

test('无用量事件：投影降级 ok=false', () => {
  const events = [
    { type: 'assistant/message', time: FLAT_ERA, data: { turn: 't1', step: 1 } }, // 无 usage
    { type: 'session/created', time: FLAT_ERA },
  ]
  assert.equal(projectSessionCost(events, 0).ok, false)
  assert.equal(projectTurnCost(events, 't1').ok, false)
})
