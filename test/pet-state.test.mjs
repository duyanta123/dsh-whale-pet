// M4-5 养成账本单测：XP 各来源、封顶 5min、失败不扣、等级反函数、6 称号边界。
// 公式与口径照抄 whale-girl lib/src/pet-state.mjs（MIT）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INITIAL_STATE, recordTaskCompleted, recordFailure, recordSession, recordSessionResume,
  recordActive, ACTIVE_CAP_MS, xpForLevel, levelFor, TITLES, titleName,
  TASK_XP, SESSION_XP, RESUME_XP, MEMORY_MAX,
} from '../lib/pet-state.mjs'

const NOW = 1_700_000_000_000
const state = (over = {}) => ({ ...INITIAL_STATE, stats: { ...INITIAL_STATE.stats }, ...over })

test('INITIAL_STATE：等级 1、零 xp、空称号/回忆', () => {
  assert.equal(INITIAL_STATE.level, 1)
  assert.equal(INITIAL_STATE.xp, 0)
  assert.deepEqual(INITIAL_STATE.stats, { tasksDone: 0, failures: 0, sessions: 0, activeMs: 0, firstSeenAt: null })
  assert.deepEqual(INITIAL_STATE.titles, [])
})

test('xpForLevel 三角数列：L2=50、L3=150、L4=300', () => {
  assert.equal(xpForLevel(2), 50)
  assert.equal(xpForLevel(3), 150)
  assert.equal(xpForLevel(4), 300)
})

test('levelFor 反函数 O(1)：xp=49→L1、50→L2、149→L2、150→L3；封顶防挂起', () => {
  assert.equal(levelFor(0), 1)
  assert.equal(levelFor(49), 1)
  assert.equal(levelFor(50), 2)
  assert.equal(levelFor(149), 2)
  assert.equal(levelFor(150), 3)
  assert.equal(levelFor(-5), 1)
  assert.ok(Number.isFinite(levelFor(1e15))) // XP_SAFE_MAX 兜底不溢出
})

test('recordTaskCompleted：+TASK_XP、tasksDone+1、回忆入环形（MEMORY_MAX 截断）', () => {
  let s = state()
  for (let i = 1; i <= MEMORY_MAX + 3; i += 1) {
    s = recordTaskCompleted(s, `任务${i}`, NOW + i).state
  }
  assert.equal(s.stats.tasksDone, MEMORY_MAX + 3)
  assert.equal(s.xp, TASK_XP * (MEMORY_MAX + 3))
  assert.equal(s.memory.length, MEMORY_MAX)
  assert.ok(s.memory[s.memory.length - 1].includes(`任务${MEMORY_MAX + 3}`))
  // 长标签截断。
  const long = recordTaskCompleted(state(), 'x'.repeat(30), NOW)
  assert.ok(long.state.memory[0].includes('…'))
})

test('recordFailure：只计 failures 不扣 XP（零负反馈）', () => {
  const before = recordTaskCompleted(state(), 'a', NOW).state
  const after = recordFailure(before, NOW + 1).state
  assert.equal(after.stats.failures, 1)
  assert.equal(after.stats.tasksDone, 1)
  assert.equal(after.xp, before.xp) // 不扣资历
  assert.ok(after.memory[after.memory.length - 1].includes('任务失败'))
})

test('recordSession：新会话 +SESSION_XP 并记首见；续接 +RESUME_XP 不计会话数', () => {
  const fresh = recordSession(state(), NOW).state
  assert.equal(fresh.stats.sessions, 1)
  assert.equal(fresh.stats.firstSeenAt, NOW)
  assert.equal(fresh.xp, SESSION_XP)
  const again = recordSession(fresh, NOW + 1).state
  assert.equal(again.stats.firstSeenAt, NOW) // 首见不变
  const resumed = recordSessionResume(again, NOW + 2).state
  assert.equal(resumed.stats.sessions, 2) // 续接不加会话数
  assert.equal(resumed.xp, again.xp + RESUME_XP)
})

test('recordActive：单次增量封顶 5 分钟（防挂机过夜刷满）', () => {
  const s1 = recordActive(state(), ACTIVE_CAP_MS + 3600_000, NOW).state
  assert.equal(s1.stats.activeMs, ACTIVE_CAP_MS)
  const s2 = recordActive(state(), 1000, NOW).state
  assert.equal(s2.stats.activeMs, 1000)
  const s3 = recordActive(state(), -500, NOW).state // 负增量夹取 0
  assert.equal(s3.stats.activeMs, 0)
})

test('称号：6 个封闭集合 + 谓词阈值边界 + 解锁即写回忆', () => {
  assert.equal(TITLES.length, 6)
  assert.deepEqual(TITLES.map((t) => t.id), [
    'first-task', 'helper', 'veteran', 'regular', 'resilient', 'social',
  ])
  assert.equal(titleName('first-task'), '初次协作')
  assert.equal(titleName('nope'), 'nope') // 未知 id 原样返回
  // 边界：第 1/20/100 任务、6 小时、失败≥5、10 会话。
  let s = state()
  const step = (fn, ...args) => { s = fn(s, ...args).state }
  for (let i = 0; i < 19; i += 1) step(recordTaskCompleted, 't', NOW + i)
  assert.deepEqual(s.titles, ['first-task'])
  step(recordTaskCompleted, 't', NOW) // 第 20 个
  assert.ok(s.titles.includes('helper'))
  for (let i = 0; i < 80; i += 1) step(recordTaskCompleted, 't', NOW)
  assert.ok(s.titles.includes('veteran')) // 100 任务
  s = recordActive(s, 6 * 3_600_000, NOW).state // 单次封顶 5min → 不触发
  assert.ok(!s.titles.includes('regular'))
  let acc = s
  for (let i = 0; i < 72; i += 1) acc = recordActive(acc, 5 * 60_000, NOW + i).state // 6 小时
  assert.ok(acc.titles.includes('regular'))
  let f = acc
  for (let i = 0; i < 5; i += 1) f = recordFailure(f, NOW).state
  assert.ok(f.titles.includes('resilient'))
  let soc = f
  for (let i = 0; i < 8; i += 1) soc = recordSession(soc, NOW).state // 凑满 10
  assert.ok(soc.titles.includes('social'))
  // 解锁写回忆。
  assert.ok(soc.memory.some((m) => m.includes('越挫越勇') || m.includes('广结善缘') || m.includes('常驻伙伴')))
})

test('recordTaskCompleted 返回 unlocked 名称数组（气泡用）', () => {
  const out = recordTaskCompleted(state(), '首个任务', NOW)
  assert.deepEqual(out.unlocked, ['初次协作'])
  assert.equal(out.leveledUp, false)
})
