// M1-9 working 插曲节奏器单测（注入伪随机源；规格 docs/state-machine.md §5-1）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nextWorkingRhythm, WORKING_MIN_WAIT_MS, WORKING_MAX_WAIT_MS,
  WORKING_MIN_DUR_MS, WORKING_MAX_DUR_MS,
} from '../lib/client/rhythm.mjs'

const NOW = 2_000_000

test('会话不活跃：插曲撤防（active=false, until=0）', () => {
  assert.deepEqual(nextWorkingRhythm({ now: NOW, thinking: false, working: { active: false, until: 0 } }), { active: false, until: 0 })
  // 插曲进行中但会话结束：同样立即撤防。
  assert.deepEqual(nextWorkingRhythm({ now: NOW, thinking: false, working: { active: true, until: 0 } }), { active: false, until: 0 })
})

test('插曲进行中：随机时长（2.5-6s）后回到 think', () => {
  const min = nextWorkingRhythm({ now: NOW, thinking: true, working: { active: true, until: 0 }, random: () => 0 })
  assert.equal(min.active, false)
  assert.equal(min.until, NOW + WORKING_MIN_DUR_MS)
  const max = nextWorkingRhythm({ now: NOW, thinking: true, working: { active: true, until: 0 }, random: () => 1 })
  assert.equal(max.until, NOW + WORKING_MAX_DUR_MS)
  const mid = nextWorkingRhythm({ now: NOW, thinking: true, working: { active: true, until: 0 }, random: () => 0.5 })
  assert.equal(mid.until, NOW + (WORKING_MIN_DUR_MS + WORKING_MAX_DUR_MS) / 2)
})

test('think 常态：随机间隔（12-30s）后插入插曲', () => {
  const min = nextWorkingRhythm({ now: NOW, thinking: true, working: { active: false, until: 0 }, random: () => 0 })
  assert.equal(min.active, true)
  assert.equal(min.until, NOW + WORKING_MIN_WAIT_MS)
  const max = nextWorkingRhythm({ now: NOW, thinking: true, working: { active: false, until: 0 }, random: () => 1 })
  assert.equal(max.until, NOW + WORKING_MAX_WAIT_MS)
  // 区间正确性：12000 < 随机 < 30000。
  const r = nextWorkingRhythm({ now: NOW, thinking: true, working: { active: false, until: 0 } })
  assert.ok(r.until > NOW + WORKING_MIN_WAIT_MS && r.until < NOW + WORKING_MAX_WAIT_MS)
})

test('默认随机源可注入（确定性序列）', () => {
  let calls = 0
  const seq = [0.25, 0.75]
  const out = nextWorkingRhythm({
    now: NOW, thinking: true, working: { active: true, until: 0 },
    random: () => seq[calls++ % seq.length],
  })
  assert.equal(out.until, NOW + WORKING_MIN_DUR_MS + 0.25 * (WORKING_MAX_DUR_MS - WORKING_MIN_DUR_MS))
  assert.equal(calls, 1)
})
