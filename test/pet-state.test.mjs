// M4-5 养成账本单测：XP 各来源、封顶 5min、失败不扣、等级反函数、6 称号边界、回忆环形。
// 公式与口径照抄 lib/pet-state.mjs（移植自 whale-girl lib/src/pet-state.mjs，MIT）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INITIAL_STATE, MEMORY_MAX, TASK_XP, SESSION_XP, RESUME_XP, ACTIVE_CAP_MS,
  xpForLevel, levelFor, TITLES, titleName,
  recordTaskCompleted, recordFailure, recordSession, recordSessionResume, recordActive,
} from '../lib/pet-state.mjs'

const NOW = 1_700_000_000_000

test('INITIAL_STATE：等级 1、零 XP、空称号/回忆、stats 全零', () => {
  assert.equal(INITIAL_STATE.level, 1)
  assert.equal(INITIAL_STATE.xp, 0)
  assert.deepEqual(INITIAL_STATE.stats, { tasksDone: 0, failures: 0, sessions: 0, activeMs: 0, firstSeenAt: null })
  assert.deepEqual(INITIAL_STATE.titles, [])
  assert.deepEqual(INITIAL_STATE.memory, [])
})

test('xpForLevel 三角数列：L2=50、L3=150、L4=300', () => {
  assert.equal(xpForLevel(2), 50)
  assert.equal(xpForLevel(3), 150)
  assert.equal(xpForLevel(4), 300)
})

test('levelFor 反函数 O(1)：xp=49→L1、50→L2、149→L2、150→L3；负值夹取 L1', () => {
  assert.equal(levelFor(0), 1)
  assert.equal(levelFor(49), 1)
  assert.equal(levelFor(50), 2)
  assert.equal(levelFor(149), 2)
  assert.equal(levelFor(150), 3)
  assert.equal(levelFor(-5), 1)
  // 往返：xpForLevel(levelFor(xp)) ≤ xp < xpForLevel(levelFor(xp)+1)。
  for (const xp of [0, 1, 49, 50, 51, 150, 300, 1e9]) {
    const lv = levelFor(xp)
    assert.ok(xp >= xpForLevel(lv) && (lv >= 1e6 || xp < xpForLevel(lv + 1)), `往返失败 xp=${xp}`)
  }
})

test('XP 来源：任务完成 +10、新会话 +5、续接 +2', () => {
  const afterTask = recordTaskCompleted(INITIAL_STATE, '首个任务', NOW)
  assert.equal(afterTask.state.xp, TASK_XP)
  assert.equal(afterTask.state.stats.tasksDone, 1)
  const afterSession = recordSession(INITIAL_STATE, NOW)
  assert.equal(afterSession.state.xp, SESSION_XP)
  assert.equal(afterSession.state.stats.sessions, 1)
  assert.equal(afterSession.state.stats.firstSeenAt, NOW)
  const afterResume = recordSessionResume(INITIAL_STATE, NOW)
  assert.equal(afterResume.state.xp, RESUME_XP)
  assert.equal(afterResume.state.stats.sessions, 0) // 续接不计会话数
  assert.equal(afterResume.state.stats.firstSeenAt, null)
})

test('升级边沿：跨过 L2 门槛（50xp）时 leveledUp=true 并写回忆', () => {
  const s = { ...INITIAL_STATE, xp: 45, level: 1 }
  const out = recordTaskCompleted(s, '冲刺任务', NOW) // 45+10=55 ≥ 50 → L2
  assert.equal(out.leveledUp, true)
  assert.equal(out.state.level, 2)
  assert.ok(out.state.memory.some((m) => m.includes('Lv.2')))
  // 恰在门槛（xp=50 即 L2）：40+10=50 正好升级；35+10=45 未跨门槛不升级。
  const s2 = { ...INITIAL_STATE, xp: 35, level: 1 }
  const notYet = recordTaskCompleted(s2, '普通任务', NOW)
  assert.equal(notYet.leveledUp, false)
  assert.equal(notYet.state.level, 1)
  const exactly = recordTaskCompleted({ ...INITIAL_STATE, xp: 40, level: 1 }, '压线任务', NOW)
  assert.equal(exactly.leveledUp, true)
  assert.equal(exactly.state.level, 2)
})

test('零负反馈：任务失败只计 failures，不扣 XP；请求错误不计数（由 Node half 不调用保证）', () => {
  const s = { ...INITIAL_STATE, xp: 100, level: 2 }
  const out = recordFailure(s, NOW)
  assert.equal(out.state.stats.failures, 1)
  assert.equal(out.state.xp, 100) // 不扣资历
  assert.equal(out.state.level, 2)
  assert.equal(out.state.stats.tasksDone, 0)
})

test('ACTIVE_CAP_MS=5min：单次增量封顶，防挂机过夜刷满', () => {
  assert.equal(ACTIVE_CAP_MS, 5 * 60_000)
  const over = recordActive(INITIAL_STATE, ACTIVE_CAP_MS + 3_600_000, NOW)
  assert.equal(over.state.stats.activeMs, ACTIVE_CAP_MS)
  const normal = recordActive(INITIAL_STATE, 30_000, NOW)
  assert.equal(normal.state.stats.activeMs, 30_000)
  const negative = recordActive(INITIAL_STATE, -1000, NOW)
  assert.equal(negative.state.stats.activeMs, 0)
})

test('6 称号封闭集合与边界：first-task/helper/veteran/regular/resilient/social', () => {
  assert.deepEqual(TITLES.map((t) => t.id), [
    'first-task', 'helper', 'veteran', 'regular', 'resilient', 'social',
  ])
  assert.equal(titleName('first-task'), '初次协作')
  assert.equal(titleName('未知id'), '未知id') // 容忍旧数据

  // first-task：首个任务即解锁。
  const first = recordTaskCompleted(INITIAL_STATE, '初次', NOW)
  assert.deepEqual(first.unlocked, ['初次协作'])
  assert.ok(first.state.titles.includes('first-task'))

  // helper：恰好第 20 个任务。
  let s = INITIAL_STATE
  for (let i = 1; i <= 19; i += 1) s = recordTaskCompleted(s, `任务${i}`, NOW + i).state
  const twentieth = recordTaskCompleted(s, '第20个', NOW + 20)
  assert.ok(twentieth.unlocked.includes('勤劳伙伴'))
  assert.ok(twentieth.state.titles.includes('helper'))

  // regular：恰好 6 小时活跃。
  const sixHours = { ...INITIAL_STATE, stats: { ...INITIAL_STATE.stats, activeMs: 6 * 3_600_000 - 1000 } }
  assert.deepEqual(recordActive(sixHours, 1000, NOW).unlocked, ['常驻伙伴'])

  // resilient：第 5 次失败。
  let f = INITIAL_STATE
  for (let i = 1; i <= 4; i += 1) f = recordFailure(f, NOW + i).state
  assert.deepEqual(recordFailure(f, NOW + 5).unlocked, ['越挫越勇'])

  // social：第 10 个会话。
  let ss = INITIAL_STATE
  for (let i = 1; i <= 9; i += 1) ss = recordSession(ss, NOW + i).state
  assert.deepEqual(recordSession(ss, NOW + 10).unlocked, ['广结善缘'])
})

test('称号幂等：已解锁不重复解锁、不重复写回忆', () => {
  const s = { ...INITIAL_STATE, titles: ['first-task'], stats: { ...INITIAL_STATE.stats, tasksDone: 1 } }
  const out = recordTaskCompleted(s, '再来一次', NOW)
  assert.deepEqual(out.unlocked, []) // first-task 已在手
  assert.equal(out.state.titles.filter((t) => t === 'first-task').length, 1)
})

test('回忆环形：最多 MEMORY_MAX=8 条，新的挤掉旧的', () => {
  assert.equal(MEMORY_MAX, 8)
  let s = INITIAL_STATE
  for (let i = 1; i <= 12; i += 1) s = recordTaskCompleted(s, `任务${i}`, NOW + i).state
  assert.equal(s.memory.length, MEMORY_MAX)
  assert.ok(s.memory[s.memory.length - 1].includes('任务12'))
  assert.ok(!s.memory.some((m) => m.includes('任务1）'))) // 最早 4 条被挤出（升级回忆另计）
})
