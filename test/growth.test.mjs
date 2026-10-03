// growth 模块单测（phase2-②）：39 成就逐条真/假两向 + 幂等 + 边界、好感等级/封顶、
// 每日任务 3 槽（signin-1 恒在/当日幂等/跨日避开昨日槽）、每周签到（里程碑 1/3/7、跨周重置）、
// streak 连续/断签（含 DST 切换日不误断签，固定时区）、blob.game 维护（game-play 换日重置 /
// game-combo max / game-highscore 破纪录边沿 / 每日奖励局上限：前 3 局发好感、第 4 局起不发）、
// 存储适配器全流程与降级（内存态 / load 抛错 / 坏字段纠正 / save 抛错 / localStorage 缺席与坏 JSON）。
// 确定性：时间全部用本地时区构造（new Date(y,m,d)），rng 用固定源（() => 0 / () => 0.5），now/storage 全注入。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACHIEVEMENTS, QUEST_POOL, AFFINITY_MAX, LEVEL_STEP, GROWTH_STORAGE_KEY,
  affinityLevel, evaluateAchievements, refreshQuests, computeQuests, claimQuest,
  weekKey, computeWeekSignin, signinDaily, createGrowth,
} from '../lib/client/growth.mjs'

// ---- 确定时钟：T0 = 2026-09-28（周一）12:00 本地时；DAY=1 天；HOUR=1 小时 ----
const T0 = new Date(2026, 8, 28, 12, 0, 0).getTime()
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

/** 本地日键（与模块内部 dayKey 同式，测试断言用）。 */
const dayKeyOf = (t) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 构造合法空 blob（与 lib/client/growth.mjs freshBlob 同形状）。 */
function baseBlob() {
  return {
    version: 1,
    affinity: 0,
    achievements: [],
    counters: {
      pat: 0, belly: 0, tail: 0, feed: 0,
      gamePlays: 0, gameWins: 0, gameComboMax: 0, gameHighscoreBreaks: 0,
      meme: 0, balanceAlert: 0, nightInteracts: 0, nightWorks: 0, comebacks: 0,
      questsClaimed: 0, questAllDays: 0,
    },
    signin: { lastDate: '', streak: 0 },
    quests: { date: '', slots: [], allClaimed: false },
    weekSignin: { week: '', days: [], rewarded1: false, rewarded3: false, rewarded7: false },
    game: { highscore: 0, playsToday: 0, playsDay: '' },
    updatedAt: 0,
  }
}

/** 构造 pet 快照（/api/whale-pet/state → snapshot().pet 的最小形状）。 */
function basePet() {
  return { level: 1, stats: { tasksDone: 0, failures: 0, sessions: 0, activeMs: 0, firstSeenAt: T0 } }
}

/** 深拷贝内存存储（load/save 双向拷贝，专抓别名共享类 bug）。 */
function memStorage() {
  const box = { data: null }
  return {
    box,
    load() {
      return box.data === null ? null : JSON.parse(JSON.stringify(box.data))
    },
    save(b) {
      box.data = JSON.parse(JSON.stringify(b))
    },
  }
}

// ---------------------------------------------------------------------------
// 常量与清单形状
// ---------------------------------------------------------------------------

test('ACHIEVEMENTS：恰好 39 条、冻结、id 唯一且顺序固定、test 为函数、reward 为非负整数', () => {
  const EXPECTED = [
    'first-pat', 'ten-pats', 'hundred-pats', 'first-feed', 'first-triple', 'thanks',
    'lv5', 'lv10', 'signin3', 'signin7', 'night-owl', 'comeback',
    'day1', 'day7', 'day30', 'first-tool', 'tools-10', 'tools-50', 'tools-100',
    'first-code', 'code-20', 'first-success', 'success-10', 'first-failure', 'fail-10',
    'messages-100', 'messages-500', 'keyword-master', 'night-work', 'balance-low',
    'game-first', 'game-win', 'game-combo10', 'game-highscore',
    'quest-first', 'quest-all', 'week-signin7', 'bond-action', 'bond-badge',
  ]
  assert.equal(ACHIEVEMENTS.length, 39)
  assert.ok(Object.isFrozen(ACHIEVEMENTS))
  assert.deepEqual(ACHIEVEMENTS.map((a) => a.id), EXPECTED)
  assert.equal(new Set(EXPECTED).size, 39)
  for (const a of ACHIEVEMENTS) {
    assert.equal(typeof a.test, 'function', a.id)
    assert.equal(typeof a.icon, 'string')
    assert.ok(a.name.length > 0 && a.desc.length > 0, a.id)
    assert.ok(Number.isInteger(a.reward.affinity) && a.reward.affinity >= 0, a.id)
  }
})

test('QUEST_POOL：6 条、冻结、signin-1 恒在（always）、metric/target/奖励齐全', () => {
  assert.equal(QUEST_POOL.length, 6)
  assert.ok(Object.isFrozen(QUEST_POOL))
  assert.deepEqual(QUEST_POOL.map((q) => q.id), ['signin-1', 'task-1', 'pat-3', 'feed-1', 'active-15', 'game-1'])
  assert.equal(QUEST_POOL[0].always, true)
  assert.equal(QUEST_POOL[0].metric, 'signin')
  assert.equal(QUEST_POOL[0].target, 1)
  assert.equal(QUEST_POOL.filter((q) => q.always).length, 1)
  for (const q of QUEST_POOL) {
    assert.ok(Number.isInteger(q.target) && q.target >= 1, q.id)
    assert.ok(Number.isInteger(q.reward.affinity) && q.reward.affinity >= 0, q.id)
  }
})

test('常量：AFFINITY_MAX=10000、LEVEL_STEP=500、GROWTH_STORAGE_KEY 固定键名', () => {
  assert.equal(AFFINITY_MAX, 10000)
  assert.equal(LEVEL_STEP, 500)
  assert.equal(GROWTH_STORAGE_KEY, 'whale-pet-growth-v1')
})

test('affinityLevel：500 步进、下限 1、非法输入按 0（等级 1）', () => {
  assert.equal(affinityLevel(0), 1)
  assert.equal(affinityLevel(1), 1)
  assert.equal(affinityLevel(499), 1)
  assert.equal(affinityLevel(500), 2)
  assert.equal(affinityLevel(999), 2)
  assert.equal(affinityLevel(1000), 3)
  assert.equal(affinityLevel(2000), 5)
  assert.equal(affinityLevel(9999), 20)
  assert.equal(affinityLevel(10000), 21)
  assert.equal(affinityLevel(-5), 1)
  assert.equal(affinityLevel(Number.NaN), 1)
  assert.equal(affinityLevel(undefined), 1)
})

// ---------------------------------------------------------------------------
// 39 条成就逐条谓词（真/假两向 + 首解锁 + 幂等）
// ---------------------------------------------------------------------------

const CASES = [
  { id: 'first-pat', on: (b) => { b.counters.pat = 1 } },
  { id: 'ten-pats', on: (b) => { b.counters.pat = 10 } },
  { id: 'hundred-pats', on: (b) => { b.counters.pat = 100 } },
  { id: 'first-feed', on: (b) => { b.counters.feed = 1 } },
  { id: 'first-triple', on: (b) => { b.counters.pat = 1; b.counters.belly = 1; b.counters.tail = 1 } },
  { id: 'thanks', on: (b) => { b.counters.feed = 10 } },
  { id: 'lv5', on: (b, p) => { p.level = 5 } },
  { id: 'lv10', on: (b, p) => { p.level = 10 } },
  { id: 'signin3', on: (b) => { b.signin.streak = 3 } },
  { id: 'signin7', on: (b) => { b.signin.streak = 7 } },
  { id: 'night-owl', on: (b) => { b.counters.nightInteracts = 1 } },
  { id: 'comeback', on: (b) => { b.counters.comebacks = 1 } },
  { id: 'day1', now: T0 + DAY },
  { id: 'day7', now: T0 + 7 * DAY },
  { id: 'day30', now: T0 + 30 * DAY },
  { id: 'first-tool', on: (b, p) => { p.stats.sessions = 1 } },
  { id: 'tools-10', on: (b, p) => { p.stats.sessions = 10 } },
  { id: 'tools-50', on: (b, p) => { p.stats.sessions = 50 } },
  { id: 'tools-100', on: (b, p) => { p.stats.sessions = 100 } },
  { id: 'first-code', on: (b, p) => { p.stats.activeMs = 10 * HOUR } },
  { id: 'code-20', on: (b, p) => { p.stats.activeMs = 50 * HOUR } },
  { id: 'first-success', on: (b, p) => { p.stats.tasksDone = 1 } },
  { id: 'success-10', on: (b, p) => { p.stats.tasksDone = 10 } },
  { id: 'first-failure', on: (b, p) => { p.stats.failures = 1 } },
  { id: 'fail-10', on: (b, p) => { p.stats.failures = 10 } },
  { id: 'messages-100', on: (b, p) => { p.stats.tasksDone = 50 } },
  { id: 'messages-500', on: (b, p) => { p.stats.tasksDone = 200 } },
  { id: 'keyword-master', on: (b) => { b.counters.meme = 10 } },
  { id: 'night-work', on: (b) => { b.counters.nightWorks = 1 } },
  { id: 'balance-low', on: (b) => { b.counters.balanceAlert = 1 } },
  { id: 'game-first', on: (b) => { b.counters.gamePlays = 1 } },
  { id: 'game-win', on: (b) => { b.counters.gameWins = 1 } },
  { id: 'game-combo10', on: (b) => { b.counters.gameComboMax = 10 } },
  { id: 'game-highscore', on: (b) => { b.counters.gameHighscoreBreaks = 1 } },
  { id: 'quest-first', on: (b) => { b.counters.questsClaimed = 1 } },
  { id: 'quest-all', on: (b) => { b.counters.questAllDays = 1 } },
  { id: 'week-signin7', on: (b) => { b.weekSignin.rewarded7 = true } },
  { id: 'bond-action', on: (b) => { b.affinity = 1000 } },
  { id: 'bond-badge', on: (b) => { b.affinity = 2000 } },
]

for (let i = 0; i < CASES.length; i += 1) {
  const cs = CASES[i]
  test(`成就 #${i + 1} ${cs.id}：条件成立解锁、干净态不解锁、解锁后幂等`, () => {
    // 成立向：构造条件 → 首次 evaluate 含该 id；回灌 have 集合后不再解锁（幂等）。
    const b = baseBlob()
    const p = basePet()
    if (cs.on) cs.on(b, p)
    const out = evaluateAchievements(b, p, cs.now ?? T0)
    assert.ok(out.includes(cs.id), `应解锁 ${cs.id}，实际 ${JSON.stringify(out)}`)
    b.achievements.push(...out)
    assert.deepEqual(evaluateAchievements(b, p, cs.now ?? T0), [])
    // 反向向：干净 blob + 干净 pet（day 系谓词反向用 T0 当下，差值为 0 天）。
    const off = evaluateAchievements(baseBlob(), basePet(), T0)
    assert.ok(!off.includes(cs.id), `干净态不应解锁 ${cs.id}，实际 ${JSON.stringify(off)}`)
  })
}

test('成就边界：pat 9/10、combo 9/10、activeMs 差 1ms、affinity 999/1000、day1 差 1ms', () => {
  const nine = baseBlob()
  nine.counters.pat = 9
  assert.deepEqual(evaluateAchievements(nine, basePet(), T0), ['first-pat']) // ten-pats 未达，first-pat 已达
  const boundaryCases = [
    [{ ...baseBlob(), counters: { ...baseBlob().counters, pat: 10 } }, basePet(), T0, ['first-pat', 'ten-pats']],
    [{ ...baseBlob(), counters: { ...baseBlob().counters, gameComboMax: 9 } }, basePet(), T0, []],
    [{ ...baseBlob(), counters: { ...baseBlob().counters, gameComboMax: 10 } }, basePet(), T0, ['game-combo10']],
    [{ ...baseBlob(), affinity: 999 }, basePet(), T0, []],
    [{ ...baseBlob(), affinity: 1000 }, basePet(), T0, ['bond-action']],
  ]
  for (const [b, p, now, expected] of boundaryCases) {
    assert.deepEqual(evaluateAchievements(b, p, now), expected)
  }
  const nearHour = basePet()
  nearHour.stats.activeMs = 10 * HOUR - 1
  assert.deepEqual(evaluateAchievements(baseBlob(), nearHour, T0), [])
  const atHour = basePet()
  atHour.stats.activeMs = 10 * HOUR
  assert.deepEqual(evaluateAchievements(baseBlob(), atHour, T0), ['first-code'])
  const nearDay = basePet()
  assert.deepEqual(evaluateAchievements(baseBlob(), nearDay, T0 + DAY - 1), [])
})

test('pet 缺失/firstSeenAt 缺失：pet 系成就恒 false 且不抛错；本地计数系照常判定', () => {
  const b = baseBlob()
  b.counters.pat = 1
  assert.deepEqual(evaluateAchievements(b, null, T0), ['first-pat'])
  assert.deepEqual(evaluateAchievements(baseBlob(), null, T0), [])
  const noFirstSeen = basePet()
  noFirstSeen.stats.firstSeenAt = null
  assert.deepEqual(evaluateAchievements(baseBlob(), noFirstSeen, T0 + 30 * DAY), [])
  const skewed = basePet()
  skewed.stats.firstSeenAt = T0 + DAY // 未来首见（时钟偏斜）→ 负差值 → false
  assert.deepEqual(evaluateAchievements(baseBlob(), skewed, T0), [])
})

test('全条件 mega blob：一次解出恰好 39 条（表顺序确定）；全部回灌后 evaluate 归空', () => {
  const b = baseBlob()
  Object.assign(b.counters, {
    pat: 100, belly: 1, tail: 1, feed: 10, meme: 10, nightInteracts: 1, comebacks: 1,
    nightWorks: 1, balanceAlert: 1, gamePlays: 1, gameWins: 1, gameComboMax: 10,
    gameHighscoreBreaks: 1, questsClaimed: 1, questAllDays: 1,
  })
  b.signin.streak = 7
  b.weekSignin.rewarded7 = true
  b.affinity = 2000
  const megaPet = { level: 10, stats: { tasksDone: 200, failures: 10, sessions: 100, activeMs: 50 * HOUR, firstSeenAt: T0 } }
  const out = evaluateAchievements(b, megaPet, T0 + 30 * DAY)
  assert.deepEqual(out, ACHIEVEMENTS.map((a) => a.id))
  b.achievements.push(...out)
  assert.deepEqual(evaluateAchievements(b, megaPet, T0 + 30 * DAY), [])
})

test('39 条奖励合计 1486（0 奖励的 bond-* 除外口径回归守卫）', () => {
  const sum = ACHIEVEMENTS.reduce((acc, a) => acc + a.reward.affinity, 0)
  assert.equal(sum, 1486)
})

// ---------------------------------------------------------------------------
// 好感入账与封顶
// ---------------------------------------------------------------------------

test('好感封顶 10000：连续 game-win 累加（12×900）不越界；gameWins 照常累计', () => {
  const g = createGrowth({ storage: memStorage(), now: () => T0, random: () => 0.5 })
  for (let i = 0; i < 900; i += 1) g.ingest({ metric: 'game-win' })
  const s = g.snapshot()
  assert.equal(s.affinity, AFFINITY_MAX)
  assert.equal(s.counters.gameWins, 900)
})

// ---------------------------------------------------------------------------
// 每日任务纯函数（3 槽状态机）
// ---------------------------------------------------------------------------

test('refreshQuests：3 槽、signin-1 恒占槽 1、无重复、进度/领取初始干净、日期为当日键', () => {
  const q = refreshQuests(null, T0, () => 0.5)
  assert.equal(q.date, dayKeyOf(T0))
  assert.equal(q.slots.length, 3)
  const ids = q.slots.map((s) => s.id)
  assert.equal(new Set(ids).size, 3)
  assert.equal(ids[0], 'signin-1')
  assert.ok(QUEST_POOL.some((d) => d.id === ids[1]) && QUEST_POOL.some((d) => d.id === ids[2]))
  assert.ok(q.slots.every((s) => s.progress === 0 && s.claimed === false))
  assert.equal(q.allClaimed, false)
})

test('refreshQuests 当日幂等：同日换 rng 重入返回同一对象（引用相等）；跨日重抽', () => {
  const q1 = refreshQuests(null, T0, () => 0.5)
  const q2 = refreshQuests(q1, T0 + HOUR, () => 0.9)
  assert.equal(q2, q1)
  const q3 = refreshQuests(q1, T0 + DAY, () => 0)
  assert.notEqual(q3, q1)
  assert.equal(q3.date, dayKeyOf(T0 + DAY))
  assert.equal(q3.slots.length, 3)
  assert.equal(q3.slots[0].id, 'signin-1')
})

test('refreshQuests 跨日避开昨日槽：昨日 task-1/pat-3 不再上槽（rng=0 顺序抽取）', () => {
  const prev = {
    date: '2026-10-1',
    slots: [
      { id: 'signin-1', progress: 1, claimed: true },
      { id: 'task-1', progress: 1, claimed: true },
      { id: 'pat-3', progress: 3, claimed: true },
    ],
    allClaimed: true,
  }
  const q = refreshQuests(prev, T0, () => 0)
  const ids = q.slots.map((s) => s.id)
  assert.deepEqual(ids, ['signin-1', 'feed-1', 'active-15'])
  assert.ok(q.slots.every((s) => s.progress === 0 && s.claimed === false))
  assert.equal(q.allClaimed, false)
})

test('refreshQuests 池不足放开：昨日占满非 always 槽时回退全池抽取，仍 3 槽无重复', () => {
  const prev = {
    date: '2026-10-1',
    slots: [
      { id: 'signin-1', progress: 1, claimed: true },
      { id: 'task-1', progress: 1, claimed: true },
      { id: 'pat-3', progress: 1, claimed: true },
      { id: 'feed-1', progress: 1, claimed: true },
      { id: 'active-15', progress: 1, claimed: true },
    ],
    allClaimed: false,
  }
  const q = refreshQuests(prev, T0, () => 0)
  assert.equal(q.slots.length, 3)
  const ids = q.slots.map((s) => s.id)
  assert.equal(new Set(ids).size, 3)
  assert.ok(ids.includes('signin-1'))
})

test('computeQuests：进度累计到 target、completed 边沿、永不超 target', () => {
  const seeded = refreshQuests(
    { date: '', slots: [], allClaimed: false },
    T0,
    () => 0, // rng=0 → [signin-1, task-1, pat-3]
  )
  const r1 = computeQuests(seeded, { metric: 'pat', amount: 1 }, T0)
  assert.equal(r1.quests.slots.find((s) => s.id === 'pat-3').progress, 1)
  assert.deepEqual(r1.completed, [])
  const r2 = computeQuests(r1.quests, { metric: 'pat', amount: 2 }, T0)
  assert.equal(r2.quests.slots.find((s) => s.id === 'pat-3').progress, 3)
  assert.deepEqual(r2.completed, ['pat-3'])
  const r3 = computeQuests(r2.quests, { metric: 'pat', amount: 99 }, T0)
  assert.equal(r3.quests.slots.find((s) => s.id === 'pat-3').progress, 3)
  assert.deepEqual(r3.completed, []) // 已是可领取态：不重复上报（completed 为边沿语义）
})

test('computeQuests：已领取槽不再累计；非匹配 metric 无效果；amount≤0/非法不推进', () => {
  const seeded = refreshQuests(null, T0, () => 0)
  const done = {
    date: seeded.date,
    slots: seeded.slots.map((s) => (s.id === 'pat-3' ? { id: s.id, progress: 1, claimed: true } : s)),
    allClaimed: false,
  }
  const r1 = computeQuests(done, { metric: 'pat', amount: 5 }, T0)
  assert.equal(r1.quests.slots.find((s) => s.id === 'pat-3').progress, 1)
  assert.deepEqual(r1.completed, [])
  const r2 = computeQuests(done, { metric: 'meme', amount: 5 }, T0)
  assert.deepEqual(r2.quests.slots, done.slots)
  const r3 = computeQuests(done, { metric: 'activeMin', amount: 0 }, T0)
  assert.deepEqual(r3.quests.slots, done.slots)
  const r4 = computeQuests(done, { metric: 'activeMin', amount: -3 }, T0)
  assert.deepEqual(r4.quests.slots, done.slots)
})

test('computeQuests：跨日自动重抽（旧 date 进、新 date 出）；非法信号安全返回', () => {
  const old = refreshQuests(null, T0, () => 0.5)
  const r = computeQuests(old, { metric: 'pat', amount: 1 }, T0 + 5 * DAY)
  assert.equal(r.quests.date, dayKeyOf(T0 + 5 * DAY))
  assert.deepEqual(r.completed, [])
  const bad = computeQuests(old, null, T0)
  assert.equal(bad.quests.date, old.date)
  assert.deepEqual(bad.completed, [])
})

test('claimQuest：未满不可领；达标领一次（幂等）；reward 为池定义奖励', () => {
  const seeded = refreshQuests(null, T0, () => 0)
  const unfinished = claimQuest(seeded, 'pat-3')
  assert.equal(unfinished.claimed, false)
  assert.equal(unfinished.newlyAll, false)
  assert.equal(unfinished.reward, null)
  const ready = computeQuests(seeded, { metric: 'pat', amount: 3 }, T0).quests
  const c1 = claimQuest(ready, 'pat-3')
  assert.equal(c1.claimed, true)
  assert.equal(c1.newlyAll, false)
  assert.deepEqual(c1.reward, { affinity: 8 })
  assert.equal(c1.quests.slots.find((s) => s.id === 'pat-3').claimed, true)
  const c2 = claimQuest(c1.quests, 'pat-3')
  assert.equal(c2.claimed, false)
  assert.equal(c2.reward, null)
  const ghost = claimQuest(ready, 'nope')
  assert.equal(ghost.claimed, false)
})

test('claimQuest：3/3 依次领取 → newlyAll 仅最后为真、allClaimed 置位；重复领取不回滚', () => {
  let quests = refreshQuests(null, T0, () => 0) // [signin-1, task-1, pat-3]
  quests = computeQuests(quests, { metric: 'signin', amount: 1 }, T0).quests
  quests = computeQuests(quests, { metric: 'task', amount: 1 }, T0).quests
  quests = computeQuests(quests, { metric: 'pat', amount: 3 }, T0).quests
  const c1 = claimQuest(quests, 'signin-1')
  assert.equal(c1.claimed, true)
  assert.equal(c1.newlyAll, false)
  const c2 = claimQuest(c1.quests, 'task-1')
  assert.equal(c2.newlyAll, false)
  const c3 = claimQuest(c2.quests, 'pat-3')
  assert.equal(c3.claimed, true)
  assert.equal(c3.newlyAll, true)
  assert.equal(c3.quests.allClaimed, true)
  const again = claimQuest(c3.quests, 'signin-1')
  assert.equal(again.claimed, false)
  assert.equal(again.newlyAll, false)
})

// ---------------------------------------------------------------------------
// 每周签到纯函数（7 天、周一基准）
// ---------------------------------------------------------------------------

test('weekKey：周一基准，周中/周日归本周一，次周一换键', () => {
  assert.equal(weekKey(T0), '2026-9-28') // 周一
  assert.equal(weekKey(new Date(2026, 8, 30, 8, 0, 0).getTime()), '2026-9-28') // 周三
  assert.equal(weekKey(new Date(2026, 9, 4, 12, 0, 0).getTime()), '2026-9-28') // 周日午间
  assert.equal(weekKey(new Date(2026, 9, 4, 23, 59, 0).getTime()), '2026-9-28') // 周日 23:59
  assert.equal(weekKey(new Date(2026, 9, 5, 0, 0, 0).getTime()), '2026-10-5') // 次周一 00:00
  assert.equal(weekKey(T0 + 7 * DAY), '2026-10-5') // 次周一
})

test('computeWeekSignin：里程碑 1/3/7 各触发一次（一次调用至多一个），同日重复签到不重复', () => {
  const r1 = computeWeekSignin(null, T0)
  assert.deepEqual(r1, { weekSignin: { week: '2026-9-28', days: ['2026-9-28'], rewarded1: true, rewarded3: false, rewarded7: false }, milestoneHit: '1' })
  const r1b = computeWeekSignin(r1.weekSignin, T0 + HOUR) // 同日重签
  assert.equal(r1b.milestoneHit, null)
  assert.equal(r1b.weekSignin.days.length, 1)
  const r2 = computeWeekSignin(r1.weekSignin, T0 + DAY)
  assert.equal(r2.milestoneHit, null)
  const r3 = computeWeekSignin(r2.weekSignin, T0 + 2 * DAY)
  assert.equal(r3.milestoneHit, '3')
  let cur = r3.weekSignin
  const hits = []
  for (let i = 3; i < 7; i += 1) {
    const r = computeWeekSignin(cur, T0 + i * DAY)
    hits.push(r.milestoneHit)
    cur = r.weekSignin
  }
  assert.deepEqual(hits, [null, null, null, '7'])
  const extra = computeWeekSignin(cur, T0 + 6 * DAY + HOUR) // 已满 7 再签
  assert.equal(extra.milestoneHit, null)
  assert.equal(extra.weekSignin.rewarded7, true)
})

test('computeWeekSignin 跨周重置：新一周 days/里程碑全清，days≥1 立即重新触发里程碑 1', () => {
  const full = { week: '2026-9-28', days: ['2026-9-28', '2026-9-29', '2026-9-30'], rewarded1: true, rewarded3: true, rewarded7: false }
  const next = computeWeekSignin(full, T0 + 7 * DAY)
  assert.equal(next.weekSignin.week, '2026-10-5')
  assert.deepEqual(next.weekSignin.days, ['2026-10-5'])
  assert.equal(next.weekSignin.rewarded1, true)
  assert.equal(next.weekSignin.rewarded3, false)
  assert.equal(next.weekSignin.rewarded7, false)
  assert.equal(next.milestoneHit, '1')
})

test('computeWeekSignin：畸形 prev.days 重复日去重——不虚增 days.length 提前触发里程碑', () => {
  // days 是日期键集合（计划 §4.2「days 并入今天（去重）」）。normalizeBlob 在加载边界已去重，
  // 本用例直调纯函数 + 畸形 prev（绕过加载边界）：重复日字符串只算 1 个签到日。
  const r = computeWeekSignin(
    { week: '2026-9-28', days: ['2026-9-28', '2026-9-28', '2026-9-28'], rewarded1: true, rewarded3: false, rewarded7: false },
    T0,
  )
  assert.deepEqual(r.weekSignin.days, ['2026-9-28']) // 去重 + 今天已在内不重推
  assert.equal(r.milestoneHit, null) // 实际仅 1 个签到日 → 里程碑 3 不触发（不去重则 length=3 误触发）
  assert.equal(r.weekSignin.rewarded3, false)
  const r2 = computeWeekSignin(
    { week: '2026-9-28', days: ['2026-9-28', '2026-9-28', '2026-9-29', '2026-9-29'], rewarded1: true, rewarded3: false, rewarded7: false },
    T0,
  )
  assert.deepEqual(r2.weekSignin.days, ['2026-9-28', '2026-9-29']) // 去重保序
  assert.equal(r2.milestoneHit, null) // 去重后 2 天 → 里程碑 3 仍不触发
  assert.equal(r2.weekSignin.rewarded7, false)
})

// ---------------------------------------------------------------------------
// 每日签到纯函数（streak）
// ---------------------------------------------------------------------------

test('signinDaily：首签 streak=1；同日幂等；连日 +1；断签归 1；跨周连续', () => {
  const d1 = signinDaily(baseBlob(), T0)
  assert.equal(d1.first, true)
  assert.deepEqual(d1.blob.signin, { lastDate: '2026-9-28', streak: 1 })
  const same = signinDaily(d1.blob, T0 + HOUR)
  assert.equal(same.first, false)
  assert.deepEqual(same.blob.signin, { lastDate: '2026-9-28', streak: 1 })
  const d2 = signinDaily(d1.blob, T0 + DAY)
  assert.equal(d2.first, true)
  assert.equal(d2.blob.signin.streak, 2)
  const skip = signinDaily(d2.blob, T0 + 3 * DAY)
  assert.equal(skip.blob.signin.streak, 1) // 断签归 1
  const sunday = signinDaily(skip.blob, T0 + 6 * DAY) // 周日
  const monday = signinDaily(sunday.blob, T0 + 7 * DAY) // 次周一（跨周，streak 连续）
  assert.equal(monday.blob.signin.streak, 2)
  const skew = signinDaily({ signin: { lastDate: '2026-9-29', streak: 9 } }, T0) // lastDate 在未来（时钟偏斜）→ 归 1
  assert.equal(skew.blob.signin.streak, 1)
  const empty = signinDaily(null, T0)
  assert.equal(empty.first, true)
  assert.equal(empty.blob.signin.streak, 1)
})

test('signinDaily DST：春令时切换次日 0 点档（America/New_York 2026-03-09 00:30）昨日按日历日判定，streak 连续', (t) => {
  // 3-08 是 23 小时日（02:00 拨快 1h）：24h 减法会把 3-09 00:30 映到 3-07 误判断签（streak 误归 1）；
  // 日历日回退得 3-8 → 连签。Node 22 运行时改 process.env.TZ 立即生效（win32 已验证），用后恢复。
  const prevTz = process.env.TZ
  process.env.TZ = 'America/New_York'
  t.after(() => {
    if (prevTz === undefined) delete process.env.TZ
    else process.env.TZ = prevTz
  })
  const now = new Date(2026, 2, 9, 0, 30).getTime() // 本地 2026-03-09 00:30（EDT）
  assert.equal(dayKeyOf(now), '2026-3-9')
  const res = signinDaily({ signin: { lastDate: '2026-3-8', streak: 5 } }, now)
  assert.equal(res.first, true)
  assert.equal(res.blob.signin.streak, 6) // prev+1，而非 24h 减法误判后的 1
  // 对照：真断签（昨日 3-8 未签）仍归 1
  const broken = signinDaily({ signin: { lastDate: '2026-3-7', streak: 5 } }, now)
  assert.equal(broken.first, true)
  assert.equal(broken.blob.signin.streak, 1)
})

// ---------------------------------------------------------------------------
// createGrowth 组装层：全流程 + 指标落点 + 降级
// ---------------------------------------------------------------------------

test('组装层全流程：pat 解锁 → 签到（里程碑 1 + signin-1 槽推进）→ 领取（quest-first）→ 同日幂等 → 跨实例持久化', () => {
  const st = memStorage()
  const g = createGrowth({ storage: st, now: () => T0, random: () => 0.5 }) // 槽 = [signin-1, feed-1, active-15]
  const snap0 = g.snapshot()
  assert.equal(snap0.affinity, 0)
  assert.deepEqual(snap0.quests.slots.map((s) => s.id), ['signin-1', 'feed-1', 'active-15'])

  const r1 = g.ingest({ metric: 'pat' })
  assert.deepEqual(r1.unlocks, ['first-pat'])
  assert.equal(g.snapshot().affinity, 2)
  assert.equal(g.snapshot().counters.pat, 1)

  const s1 = g.signin(T0)
  assert.equal(s1.first, true)
  assert.equal(s1.milestoneHit, '1')
  assert.equal(s1.milestoneReward, 10)
  assert.deepEqual(s1.questCompleted, ['signin-1'])
  assert.equal(s1.unlocks.length, 0)
  assert.equal(g.snapshot().affinity, 12) // 2(first-pat) + 10(里程碑1)
  assert.equal(g.snapshot().signin.streak, 1)

  const s2 = g.signin(T0) // 同日重复签到：first=false、无奖励、无里程碑
  assert.equal(s2.first, false)
  assert.equal(s2.milestoneHit, null)
  assert.equal(s2.milestoneReward, 0)
  assert.deepEqual(s2.questCompleted, [])
  assert.equal(g.snapshot().affinity, 12)

  const c1 = g.claimQuest('signin-1')
  assert.equal(c1.claimed, true)
  assert.deepEqual(c1.reward, { affinity: 6 })
  assert.deepEqual(c1.unlocks, ['quest-first'])
  assert.equal(g.snapshot().affinity, 26) // 12 + 6(签到任务) + 8(quest-first)
  assert.equal(g.snapshot().counters.questsClaimed, 1)
  assert.equal(g.snapshot().counters.questAllDays, 0)

  const c2 = g.claimQuest('signin-1') // 重复领取无效果
  assert.equal(c2.claimed, false)
  assert.equal(g.snapshot().counters.questsClaimed, 1)
  const c3 = g.claimQuest('feed-1') // 未满不可领
  assert.equal(c3.claimed, false)

  const g2 = createGrowth({ storage: st, now: () => T0, random: () => 0.5 })
  assert.equal(g2.snapshot().affinity, 26)
  assert.deepEqual([...g2.snapshot().achievements].sort(), ['first-pat', 'quest-first'])
})

test('组装层 3/3 全清：newlyAll 边沿累计 questAllDays、quest-all 解锁（预置当日满进度槽）', () => {
  const st = memStorage()
  st.box.data = {
    ...baseBlob(),
    quests: {
      date: dayKeyOf(T0),
      slots: [
        { id: 'signin-1', progress: 1, claimed: false },
        { id: 'feed-1', progress: 1, claimed: false },
        { id: 'pat-3', progress: 3, claimed: false },
      ],
      allClaimed: false,
    },
  }
  const g = createGrowth({ storage: st, now: () => T0, random: () => 0.5 })
  const c1 = g.claimQuest('signin-1')
  assert.equal(c1.newlyAll, false)
  assert.deepEqual(c1.unlocks, ['quest-first'])
  assert.equal(g.snapshot().affinity, 14) // 6 + 8(quest-first)
  const c2 = g.claimQuest('feed-1')
  assert.equal(c2.newlyAll, false)
  assert.equal(g.snapshot().affinity, 20) // 14 + 6(feed-1)
  const c3 = g.claimQuest('pat-3')
  assert.equal(c3.newlyAll, true)
  assert.deepEqual(c3.unlocks, ['quest-all'])
  const s = g.snapshot()
  assert.equal(s.affinity, 48) // 20 + 8(pat-3) + 20(quest-all)
  assert.equal(s.counters.questsClaimed, 3)
  assert.equal(s.counters.questAllDays, 1)
  assert.equal(s.quests.allClaimed, true)
  assert.ok(s.achievements.includes('quest-first') && s.achievements.includes('quest-all'))
})

test('blob.game 维护：game-play 计数与换日重置、game-combo max 不回退、game-highscore 破纪录边沿（同分不计数）、超每日奖励局上限后结算好感不再发放', () => {
  const g = createGrowth({ storage: memStorage(), now: () => T0, random: () => 0.5 })
  for (let i = 0; i < 4; i += 1) g.ingest({ metric: 'game-play' })
  let s = g.snapshot()
  assert.equal(s.counters.gamePlays, 4)
  assert.equal(s.game.playsToday, 4)
  assert.equal(s.game.playsDay, dayKeyOf(T0))
  assert.equal(s.affinity, 5) // game-first 解锁 +5

  g.ingest({ metric: 'game-combo', amount: 8 })
  g.ingest({ metric: 'game-combo', amount: 5 }) // max 不回退
  g.ingest({ metric: 'game-combo', amount: 12 })
  s = g.snapshot()
  assert.equal(s.counters.gameComboMax, 12)
  assert.equal(s.affinity, 17) // +12(game-combo10)

  g.ingest({ metric: 'game-highscore', amount: 100 }) // 首次破纪录（playsToday=4 已超每日 3 局上限）
  s = g.snapshot()
  assert.equal(s.game.highscore, 100)
  assert.equal(s.counters.gameHighscoreBreaks, 1)
  assert.equal(s.affinity, 22) // 破纪录 +5 不发（§7 超出只显示结算）；仅 game-highscore 解锁 +5
  g.ingest({ metric: 'game-highscore', amount: 100 }) // 同分不计数
  g.ingest({ metric: 'game-highscore', amount: 50 }) // 低分不计数
  s = g.snapshot()
  assert.equal(s.counters.gameHighscoreBreaks, 1)
  assert.equal(s.game.highscore, 100)
  g.ingest({ metric: 'game-highscore', amount: 200 }) // 再破（统计照记，好感仍不发）
  s = g.snapshot()
  assert.equal(s.counters.gameHighscoreBreaks, 2)
  assert.equal(s.game.highscore, 200)
  assert.equal(s.affinity, 22)

  g.ingest({ metric: 'game-win' })
  s = g.snapshot()
  assert.equal(s.counters.gameWins, 1)
  assert.equal(s.affinity, 34) // 第 4 局起不发结算好感；仅 game-win 解锁 +12
  g.ingest({ metric: 'game-draw' })
  assert.equal(g.snapshot().affinity, 34) // 超上限：draw +3 不发
  g.ingest({ metric: 'game-lose' })
  s = g.snapshot()
  assert.equal(s.affinity, 34) // lose +0（本就不发）
  assert.ok(s.achievements.includes('game-first') && s.achievements.includes('game-win')
    && s.achievements.includes('game-combo10') && s.achievements.includes('game-highscore'))
})

test('每日奖励局上限：按结算顺序逐局喂入，前 3 局发结算好感、同日第 4 局起不发（统计照记）、跨日恢复发放', () => {
  const st = memStorage()
  // 预置 game 系成就已解锁：隔离结算好感本身，成就奖励不混入断言
  st.box.data = { ...baseBlob(), achievements: ['game-first', 'game-win', 'game-combo10', 'game-highscore'] }
  let t = T0
  const g = createGrowth({ storage: st, now: () => t, random: () => 0 })
  // 按宿主结算顺序逐局四连喂（main.mjs settleGame wiring ③：play → grade → combo → highscore）
  const settle = (grade, score, combo) => {
    g.ingest({ metric: 'game-play', amount: 1 })
    g.ingest({ metric: `game-${grade}`, amount: 1 })
    g.ingest({ metric: 'game-combo', amount: combo })
    g.ingest({ metric: 'game-highscore', amount: score })
  }
  settle('win', 100, 10) // 第 1 局：win +12、破纪录 +5
  assert.equal(g.snapshot().affinity, 17)
  settle('win', 200, 5) // 第 2 局：win +12、破纪录 +5
  assert.equal(g.snapshot().affinity, 34)
  settle('draw', 150, 8) // 第 3 局：playsToday=3 仍在限额内 → draw +3（150<200 不破纪录）
  assert.equal(g.snapshot().affinity, 37)
  settle('win', 300, 12) // 第 4 局：playsToday=4 超限 → win/破纪录好感都不发，统计照记
  let s = g.snapshot()
  assert.equal(s.affinity, 37)
  assert.equal(s.counters.gamePlays, 4)
  assert.equal(s.counters.gameWins, 3)
  assert.equal(s.counters.gameComboMax, 12)
  assert.equal(s.counters.gameHighscoreBreaks, 3) // 300>200 破纪录照记
  assert.equal(s.game.highscore, 300)
  settle('draw', 160, 2) // 第 5 局：draw +3 同样不发（160<300 不破纪录）
  s = g.snapshot()
  assert.equal(s.affinity, 37)
  assert.equal(s.game.playsToday, 5)
  t = T0 + DAY // 跨日：game-play 换日重置 playsToday → 恢复发放
  settle('win', 400, 1)
  s = g.snapshot()
  assert.equal(s.affinity, 54) // +12(win) +5(破纪录 400>300)
  assert.equal(s.game.playsToday, 1)
  assert.equal(s.game.playsDay, dayKeyOf(T0 + DAY))
  assert.equal(s.counters.gameWins, 4)
  assert.equal(s.counters.gameHighscoreBreaks, 4)
  assert.equal(s.counters.gamePlays, 6)
})

test('blob.game 跨日重置：playsDay 换键、playsToday 归零重计', () => {
  const st = memStorage()
  let t = T0
  const g = createGrowth({ storage: st, now: () => t, random: () => 0 }) // 槽 = [signin-1, task-1, pat-3]
  g.ingest({ metric: 'game-play' })
  g.ingest({ metric: 'game-play' })
  assert.equal(g.snapshot().game.playsToday, 2)
  t = T0 + 3 * DAY
  g.ingest({ metric: 'game-play' })
  const s = g.snapshot()
  assert.equal(s.quests.date, dayKeyOf(t)) // 任务槽同步换日（避开昨日 task-1/pat-3 槽）
  assert.deepEqual(s.quests.slots.map((x) => x.id), ['signin-1', 'feed-1', 'active-15'])
  assert.equal(s.game.playsToday, 1)
  assert.equal(s.game.playsDay, dayKeyOf(t))
  assert.equal(s.counters.gamePlays, 3)
})

test('任务槽 metric 映射：game-play/activeMin 推进对应槽（预置当日槽）', () => {
  const st = memStorage()
  st.box.data = {
    ...baseBlob(),
    quests: {
      date: dayKeyOf(T0),
      slots: [
        { id: 'signin-1', progress: 0, claimed: false },
        { id: 'game-1', progress: 0, claimed: false },
        { id: 'active-15', progress: 0, claimed: false },
      ],
      allClaimed: false,
    },
  }
  const g = createGrowth({ storage: st, now: () => T0, random: () => 0.5 })
  assert.deepEqual(g.ingest({ metric: 'game-play' }).questCompleted, ['game-1'])
  assert.deepEqual(g.ingest({ metric: 'activeMin', amount: 10 }).questCompleted, [])
  assert.deepEqual(g.ingest({ metric: 'activeMin', amount: 10 }).questCompleted, ['active-15'])
  const s = g.snapshot()
  assert.equal(s.quests.slots.find((x) => x.id === 'active-15').progress, 15)
  assert.equal(s.quests.slots.find((x) => x.id === 'active-15').claimed, false)
})

test('signal.pet：携带 pet 快照缓存后资历系成就随之解锁；不传则不误解锁', () => {
  const g = createGrowth({ storage: memStorage(), now: () => T0, random: () => 0.5 })
  const r1 = g.ingest({ metric: 'task', amount: 1, pet: { level: 1, stats: { tasksDone: 1, failures: 0, sessions: 0, activeMs: 0, firstSeenAt: T0 } } })
  assert.deepEqual(r1.unlocks, ['first-success'])
  const r2 = g.ingest({ metric: 'level', amount: 5, pet: { level: 5, stats: { tasksDone: 1, failures: 0, sessions: 0, activeMs: 0, firstSeenAt: T0 } } })
  assert.ok(r2.unlocks.includes('lv5'))
  const s = g.snapshot()
  assert.ok(s.achievements.includes('first-success') && s.achievements.includes('lv5'))
  assert.equal(s.affinity, 58) // 8(first-success) + 50(lv5)

  const g2 = createGrowth({ storage: memStorage(), now: () => T0, random: () => 0.5 })
  const r3 = g2.ingest({ metric: 'task', amount: 1 }) // 不带 pet
  assert.deepEqual(r3.unlocks, [])
})

test('解锁级联：奖励抬好感跨过 1000 → 同次 ingest 内连带解锁 bond-action', () => {
  const st = memStorage()
  st.box.data = { ...baseBlob(), affinity: 999 }
  const g = createGrowth({ storage: st, now: () => T0, random: () => 0.5 })
  const r = g.ingest({ metric: 'pat' }) // first-pat +2 → 1001 → Lv3
  assert.ok(r.unlocks.includes('first-pat'))
  assert.ok(r.unlocks.includes('bond-action'))
  assert.equal(g.snapshot().affinity, 1001)
})

test('周签到里程碑（实例级）：周一连签 7 天 → 1/3/7 各一次 + week-signin7/signin7；次周一整板重置、streak 跨周连续', () => {
  let t = T0
  const g = createGrowth({ storage: memStorage(), now: () => t, random: () => 0.5 })
  const hits = []
  for (let i = 0; i < 7; i += 1) {
    hits.push(g.signin(t).milestoneHit)
    t += DAY
  }
  assert.deepEqual(hits, ['1', null, '3', null, null, null, '7'])
  const s = g.snapshot()
  assert.equal(s.signin.streak, 7)
  assert.equal(s.weekSignin.rewarded7, true)
  assert.ok(s.achievements.includes('week-signin7'))
  assert.ok(s.achievements.includes('signin7'))
  const r8 = g.signin(t) // 次周一
  assert.equal(r8.milestoneHit, '1') // 周常循环重触发
  const s8 = g.snapshot()
  assert.equal(s8.weekSignin.week, '2026-10-5')
  assert.equal(s8.weekSignin.days.length, 1)
  assert.equal(s8.weekSignin.rewarded7, false)
  assert.equal(s8.signin.streak, 8)
})

test('ingest 容错：未知 metric 静默忽略；null/空信号不抛错；外部重喂 signin 无害（target 钳制）', () => {
  const g = createGrowth({ storage: memStorage(), now: () => T0, random: () => 0.5 })
  assert.deepEqual(g.ingest({ metric: 'xyz', amount: 5 }), { unlocks: [], questCompleted: [] })
  assert.deepEqual(g.ingest(null).unlocks, [])
  assert.deepEqual(g.ingest({}).unlocks, [])
  const s1 = g.signin(T0)
  assert.deepEqual(s1.questCompleted, ['signin-1'])
  g.ingest({ metric: 'signin' }) // 外部重复喂：进度已被 target=1 钳制
  g.ingest({ metric: 'signin' })
  const s = g.snapshot()
  assert.equal(s.quests.slots.find((x) => x.id === 'signin-1').progress, 1)
  assert.equal(s.quests.slots.find((x) => x.id === 'signin-1').claimed, false)
})

test('ingest 分量净化：缺省/NaN 按 1、负数归 0、小数向下取整；combo 负值不回退', () => {
  const g = createGrowth({ storage: memStorage(), now: () => T0, random: () => 0.5 })
  g.ingest({ metric: 'pat' }) // 缺省 → 1
  g.ingest({ metric: 'pat', amount: Number.NaN }) // NaN → 1
  g.ingest({ metric: 'pat', amount: -3 }) // 负数 → 0
  g.ingest({ metric: 'pat', amount: 2.9 }) // → 2
  assert.equal(g.snapshot().counters.pat, 4)
  g.ingest({ metric: 'game-combo', amount: -8 })
  assert.equal(g.snapshot().counters.gameComboMax, 0)
})

test('snapshot 深拷贝：外部改动不回灌内部状态', () => {
  const g = createGrowth({ storage: memStorage(), now: () => T0, random: () => 0.5 })
  g.ingest({ metric: 'pat' })
  const s1 = g.snapshot()
  s1.affinity = 9999
  s1.counters.pat = 999
  s1.achievements.push('hundred-pats')
  const s2 = g.snapshot()
  assert.equal(s2.affinity, 2)
  assert.equal(s2.counters.pat, 1)
  assert.deepEqual(s2.achievements, ['first-pat'])
})

test('dispose 幂等：flush 当前态、可重复调用、实例仍可用（接线重入安全）', () => {
  const st = memStorage()
  const g = createGrowth({ storage: st, now: () => T0, random: () => 0 })
  g.ingest({ metric: 'pat' })
  g.dispose()
  g.dispose()
  assert.equal(st.box.data.affinity, 2)
  assert.equal(g.snapshot().affinity, 2)
})

// ---------------------------------------------------------------------------
// 存储适配器降级路径
// ---------------------------------------------------------------------------

test('存储降级：load 抛错 / 非对象垃圾 → fresh 状态照常工作', () => {
  const g1 = createGrowth({ storage: { load() { throw new Error('boom') }, save() {} }, now: () => T0, random: () => 0.5 })
  assert.equal(g1.snapshot().affinity, 0)
  assert.deepEqual(g1.ingest({ metric: 'pat' }).unlocks, ['first-pat'])
  const g2 = createGrowth({ storage: { load: () => 'garbage', save() {} }, now: () => T0, random: () => 0.5 })
  assert.equal(g2.snapshot().affinity, 0)
  const g3 = createGrowth({ storage: { load: () => 42, save() {} }, now: () => T0, random: () => 0.5 })
  assert.equal(g3.snapshot().counters.pat, 0)
})

test('存储降级：load 抛错（瞬态故障）→ 实例禁写：fresh 内存态照常工作，persist/dispose 均不落盘', () => {
  // load 抛错 = 存储态未知（既有成长数据可能还在，与「读到的就是垃圾」不同）：fail-safe 禁写——
  // 若照常落盘，首次 persist/dispose flush 就会用 fresh 空 blob 覆写存储存量（丢用户数据）。
  // 默认 localStorage 适配器 load 内部 try/catch 恒不抛（生产路径不受影响），仅自建适配器可达。
  let saveCalls = 0
  const g = createGrowth({
    storage: { load() { throw new Error('boom') }, save() { saveCalls += 1 } },
    now: () => T0,
    random: () => 0.5,
  })
  assert.equal(g.snapshot().affinity, 0) // fresh 内存态照常工作（与上一用例契约一致）
  assert.deepEqual(g.ingest({ metric: 'pat' }).unlocks, ['first-pat']) // 交互面不受影响
  g.dispose() // 兜底 flush 同样被禁写跳过
  assert.equal(saveCalls, 0, 'load 抛错后 persist/dispose 不得落盘（防 fresh 空档覆写存量）')
})

test('存储降级：坏字段逐字段纠正（脏 affinity/counters/signin/quests/weekSignin/game），已解锁成就不重复发奖', () => {
  const g = createGrowth({
    storage: {
      load: () => ({
        version: 1,
        affinity: 'x',
        achievements: ['first-pat', 'first-pat', 42, 'future-id'],
        counters: { pat: 'nope', gamePlays: -5, feed: 3.9 },
        signin: { streak: -3, lastDate: 42 },
        quests: { slots: [{ id: 'bogus' }, { id: 'pat-3', progress: -1, claimed: 'yes' }] },
        weekSignin: { days: 'nope', rewarded7: 'yes' },
        game: { highscore: Number.NaN, playsToday: 2.7 },
      }),
      save() {},
    },
    now: () => T0,
    random: () => 0,
  })
  const s = g.snapshot()
  assert.equal(s.affinity, 0)
  assert.deepEqual(s.achievements, ['first-pat', 'future-id']) // 去重、非字符串剔除、未知字符串 id 保留（防降级丢数据）
  assert.equal(s.counters.pat, 0)
  assert.equal(s.counters.gamePlays, 0)
  assert.equal(s.counters.feed, 3) // 3.9 → floor
  assert.deepEqual(s.signin, { lastDate: '', streak: 0 })
  assert.equal(s.quests.slots.length, 3) // 坏槽丢弃 → snapshot 自愈重抽当日 3 槽
  assert.deepEqual(s.weekSignin, { week: '', days: [], rewarded1: false, rewarded3: false, rewarded7: false })
  assert.equal(s.game.highscore, 0)
  assert.equal(s.game.playsToday, 2) // 2.7 → floor
  const r = g.ingest({ metric: 'pat' }) // first-pat 已在 have 集合；feed=3 使 first-feed 在首次判定时解锁
  assert.deepEqual(r.unlocks, ['first-feed'])
  assert.equal(g.snapshot().counters.pat, 1)
})

test('存储降级：save 抛错（配额/隐私模式）不影响 ingest 返回与内存态', () => {
  const g = createGrowth({
    storage: { load: () => null, save() { throw new Error('quota') } },
    now: () => T0,
    random: () => 0.5,
  })
  assert.deepEqual(g.ingest({ metric: 'pat' }).unlocks, ['first-pat'])
  assert.equal(g.snapshot().affinity, 2)
})

test('默认适配器：localStorage 缺席（Node 现状）退实例独立内存态', () => {
  delete globalThis.localStorage
  const a = createGrowth({ now: () => T0, random: () => 0.5 })
  a.ingest({ metric: 'pat' })
  const b = createGrowth({ now: () => T0, random: () => 0.5 })
  assert.equal(a.snapshot().affinity, 2)
  assert.equal(b.snapshot().affinity, 0) // 实例间不串台
})

test('默认适配器：globalThis.localStorage 存在时自动接线、跨实例持久；坏 JSON 回 fresh', (t) => {
  const backing = new Map()
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => { backing.set(k, String(v)) },
  }
  t.after(() => { delete globalThis.localStorage })
  const ga = createGrowth({ now: () => T0, random: () => 0.5 })
  ga.ingest({ metric: 'pat' })
  assert.equal(ga.snapshot().affinity, 2)
  assert.ok(backing.has('whale-pet-growth-v1'))
  const gb = createGrowth({ now: () => T0, random: () => 0.5 })
  assert.equal(gb.snapshot().affinity, 2)
  assert.deepEqual(gb.snapshot().achievements, ['first-pat'])
  backing.set('whale-pet-growth-v1', '{oops')
  const gc = createGrowth({ now: () => T0, random: () => 0.5 })
  assert.equal(gc.snapshot().affinity, 0)
})
