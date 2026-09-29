// M3-6 费用投影单测：会话级投影 / 单轮归属 / 无用量兜底。
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

test('无用量事件：投影降级 ok=false', () => {
  const events = [
    { type: 'assistant/message', time: FLAT_ERA, data: { turn: 't1', step: 1 } }, // 无 usage
    { type: 'session/created', time: FLAT_ERA },
  ]
  assert.equal(projectSessionCost(events, 0).ok, false)
  assert.equal(projectTurnCost(events, 't1').ok, false)
})
