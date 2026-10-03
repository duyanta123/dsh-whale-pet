// 泡泡小游戏纯逻辑单测（二期 ①）：固定时钟 + 种子随机源，覆盖评级边界 / 连击窗口与封顶 / 炸弹不真扣分 /
// 生成与自然消亡 / 限时与 ended / gameResult 聚合 / gameRewardAllowed 每日上限与跨日 / gamePose 全分支 /
// rng 注入确定性（规格 phase2-plan §2.1、§7、§14 game 行）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GAME, gameNewState, gameTick, gamePop, gameGrade, gameResult, gamePose, gameRewardAllowed,
} from '../lib/client/game.mjs'
import { createGrowth } from '../lib/client/growth.mjs'

const T0 = Date.UTC(2026, 9, 2, 10, 0, 0) // 固定时钟基准（dayKey 用例单独用本地时刻构造）

/** mulberry32 种子随机源（确定性；同种子同序列）。 */
function seededRng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 脚手架：把一枚泡泡直接放进棋盘（绕过 rng 控制局面），不 mutate 入参。 */
function withBubble(state, cell, kind, bornAt) {
  const board = state.board.slice()
  board[cell] = { kind, bornAt }
  return { ...state, board }
}

/** 单次生成的种类结果（rng 序列 [0.5 选格, roll 选种]）。 */
function spawnKindFor(roll) {
  const seq = [0.5, roll]
  const ticked = gameTick(gameNewState(T0), T0 + GAME.SPAWN_INTERVAL_MS, () => seq.shift())
  return ticked.events.find((e) => e.kind === 'spawn').bubble
}

test('GAME 常量冻结且与 phase2-plan §7 数值表一致（musume whale-moe-core.js:251-258 原样）', () => {
  assert.equal(Object.isFrozen(GAME), true)
  assert.equal(GAME.DURATION_MS, 30000)
  assert.equal(GAME.GRID, 4)
  assert.equal(GAME.SPAWN_INTERVAL_MS, 500)
  assert.equal(GAME.BUBBLE_LIFE_MS, 1600)
  assert.equal(GAME.STAR_LIFE_MS, 1200)
  assert.equal(GAME.STAR_P, 0.15)
  assert.equal(GAME.BOMB_P, 0.1)
  assert.equal(GAME.COMBO_WINDOW_MS, 1200)
  assert.equal(GAME.WIN_SCORE, 300)
  assert.equal(GAME.DRAW_SCORE, 150)
  assert.equal(GAME.BASE, 10)
  assert.equal(GAME.STAR_SCORE, 30)
  assert.equal(GAME.BOMB_SCORE, -20)
  assert.equal(GAME.COMBO_CAP, 10)
  assert.equal(GAME.REWARDS_PER_DAY, 3)
})

test('gameNewState：初始形状（16 空格 / 满时限 / 首个生成节拍）与非法 now 降级', () => {
  const s = gameNewState(T0, seededRng(1))
  assert.equal(s.board.length, GAME.GRID * GAME.GRID)
  assert.ok(s.board.every((cell) => cell === null))
  assert.equal(s.score, 0)
  assert.equal(s.combo, 0)
  assert.equal(s.comboAt, 0)
  assert.equal(s.comboMax, 0)
  assert.equal(s.remainingMs, GAME.DURATION_MS)
  assert.equal(s.nextSpawnAt, T0 + GAME.SPAWN_INTERVAL_MS)
  assert.equal(s.lastAt, T0)
  assert.equal(s.status, 'playing')
  // 非法 now 回退 0（musume 同款）；调用方应传真实时刻。
  const dirty = gameNewState('not-a-number', seededRng(1))
  assert.equal(dirty.lastAt, 0)
  assert.equal(dirty.nextSpawnAt, GAME.SPAWN_INTERVAL_MS)
  // 两次开局不共享棋盘引用。
  const a = gameNewState(T0)
  const b = gameNewState(T0)
  a.board[0] = { kind: 'bubble', bornAt: T0 }
  assert.equal(b.board[0], null)
})

test('gameGrade 评级边界：149 lose / 150 draw / 299 draw / 300 win（含 0/负分/高分）', () => {
  assert.equal(gameGrade(149), 'lose')
  assert.equal(gameGrade(150), 'draw')
  assert.equal(gameGrade(299), 'draw')
  assert.equal(gameGrade(300), 'win')
  assert.equal(gameGrade(0), 'lose')
  assert.equal(gameGrade(-5), 'lose')
  assert.equal(gameGrade(1000), 'win')
})

test('gamePop 普通泡：+10 基础分 + 首击连击加成 min(1,10)*2，命中后泡泡消失', () => {
  const s0 = withBubble(gameNewState(T0), 3, 'bubble', T0)
  const pop = gamePop(s0, 3, T0 + 100)
  assert.equal(pop.hit, true)
  assert.equal(pop.kind, 'bubble')
  assert.equal(pop.delta, GAME.BASE + 2)
  assert.equal(pop.state.score, 12)
  assert.equal(pop.combo, 1)
  assert.equal(pop.state.combo, 1)
  assert.equal(pop.state.comboAt, T0 + 100)
  assert.equal(pop.state.comboMax, 1)
  assert.equal(pop.state.board[3], null)
})

test('gamePop 星星泡：+30 基础分（同样吃连击加成）', () => {
  const s0 = withBubble(gameNewState(T0), 5, 'star', T0)
  const pop = gamePop(s0, 5, T0 + 100)
  assert.equal(pop.kind, 'star')
  assert.equal(pop.delta, GAME.STAR_SCORE + 2)
  assert.equal(pop.state.score, 32)
})

test('gamePop 炸弹：delta −20 仅作展示、score 不变、清连击不加成、纪录不清（musume 原样）', () => {
  const s0 = withBubble({ ...gameNewState(T0), score: 50, combo: 5, comboAt: T0, comboMax: 5 }, 7, 'bomb', T0)
  const pop = gamePop(s0, 7, T0 + 100)
  assert.equal(pop.hit, true)
  assert.equal(pop.kind, 'bomb')
  assert.equal(pop.delta, GAME.BOMB_SCORE)
  assert.equal(pop.state.score, 50) // bomb does not add score（whale-moe-game.test.mjs:35-37 注记口径）
  assert.equal(pop.state.combo, 0)
  assert.equal(pop.state.comboAt, 0)
  assert.equal(pop.combo, 0)
  assert.equal(pop.state.comboMax, 5) // 纪录是历史峰值，炸弹只清当前连击
  assert.equal(pop.state.board[7], null)
})

test('gamePop 空格 / 越界 miss：不加分、不动连击、状态原样返回（引用不变）', () => {
  const s0 = withBubble(gameNewState(T0), 0, 'bubble', T0)
  const miss = gamePop(s0, 1, T0 + 100)
  assert.equal(miss.hit, false)
  assert.equal(miss.kind, null)
  assert.equal(miss.delta, 0)
  assert.equal(miss.combo, 0)
  assert.equal(miss.state, s0)
  assert.equal(gamePop(s0, 99, T0 + 100).hit, false)
  assert.equal(gamePop(s0, -1, T0 + 100).hit, false)
})

test('gamePop 已结束 / null 状态：降级为 miss，不抛错、局面原样', () => {
  const ended = { ...gameNewState(T0), status: 'ended' }
  const r1 = gamePop(ended, 0, T0 + 1)
  assert.equal(r1.hit, false)
  assert.equal(r1.state, ended)
  const r2 = gamePop(null, 0, T0)
  assert.equal(r2.hit, false)
  assert.equal(r2.combo, 0)
  // 非法时刻无法判定连击窗口 → 降级 miss（不沿用 musume 的 t=0 回退，避免负差值误续连击）。
  const s0 = withBubble({ ...gameNewState(T0), combo: 3, comboAt: T0 }, 2, 'bubble', T0)
  const r3 = gamePop(s0, 2, null)
  assert.equal(r3.hit, false)
  assert.equal(r3.state, s0)
})

test('连击窗口 1200ms：窗口内递增（恰 1200ms 算命中）、窗外重置为 1；comboMax 记录峰值', () => {
  let s = withBubble(gameNewState(T0), 0, 'bubble', T0)
  s = gamePop(s, 0, T0 + 100).state // combo 1，锚点 T0+100
  s = withBubble(s, 1, 'bubble', T0 + 100)
  s = gamePop(s, 1, T0 + 1300).state // 距上次恰 1200ms → 窗口内 → combo 2（delta 10+4）
  assert.equal(s.combo, 2)
  assert.equal(s.comboMax, 2)
  s = withBubble(s, 2, 'bubble', T0 + 1300)
  const out = gamePop(s, 2, T0 + 2501) // 距上次 1201ms → 重置
  assert.equal(out.combo, 1)
  assert.equal(out.state.comboMax, 2) // 峰值保留
  assert.equal(out.delta, GAME.BASE + 2)
  assert.equal(out.state.score, 12 + 14 + 12)
})

test('连击加成封顶：min(combo, COMBO_CAP)*2（combo=12 仍只加 20）', () => {
  const s0 = withBubble({ ...gameNewState(T0), combo: 12, comboAt: T0 }, 0, 'bubble', T0)
  const pop = gamePop(s0, 0, T0 + 100)
  assert.equal(pop.combo, 13)
  assert.equal(pop.delta, GAME.BASE + GAME.COMBO_CAP * 2)
  assert.equal(pop.state.comboMax, 13)
})

test('gameTick：到点至多生成 1 泡（跨两个间隔也只补 1）、落随机空格、nextSpawnAt 推进', () => {
  const rng = seededRng(7)
  const s0 = gameNewState(T0, rng)
  const t1 = gameTick(s0, T0 + 499, rng) // 未到生成节拍
  assert.deepEqual(t1.events, [])
  assert.equal(t1.state.board.filter(Boolean).length, 0)
  assert.equal(t1.state.nextSpawnAt, T0 + GAME.SPAWN_INTERVAL_MS)
  const t2 = gameTick(t1.state, T0 + 1100, rng) // 已跨 nextSpawnAt=T0+500
  const spawns = t2.events.filter((e) => e.kind === 'spawn')
  assert.equal(spawns.length, 1)
  assert.equal(t2.state.board.filter(Boolean).length, 1)
  assert.ok(spawns[0].cell >= 0 && spawns[0].cell < GAME.GRID * GAME.GRID)
  assert.equal(t2.state.nextSpawnAt, T0 + 1100 + GAME.SPAWN_INTERVAL_MS)
})

test('gameTick：生成落在空格，不覆盖已有泡泡', () => {
  const rng = seededRng(7)
  let s0 = gameNewState(T0, rng)
  s0 = withBubble(s0, 0, 'bubble', T0 + 600)
  s0 = withBubble(s0, 1, 'star', T0 + 600)
  const t1 = gameTick(s0, T0 + 600, rng) // nextSpawnAt=T0+500 已到
  const spawn = t1.events.find((e) => e.kind === 'spawn')
  assert.ok(spawn)
  assert.ok(spawn.cell >= 2 && spawn.cell <= 15) // 空格从 2 号起
  assert.equal(t1.state.board[0].kind, 'bubble')
  assert.equal(t1.state.board[1].kind, 'star')
  assert.equal(t1.state.board.filter(Boolean).length, 3)
})

test('gameTick：种类概率（炸弹 10% / 星 15% / 普通 75%），rng 注入可测', () => {
  // 种类判定为严格小于（musume 原样）：bomb ⇔ roll < BOMB_P；star ⇔ BOMB_P ≤ roll < BOMB_P+STAR_P；其余 bubble。
  assert.equal(spawnKindFor(0.05), 'bomb')
  assert.equal(spawnKindFor(0.099), 'bomb')
  assert.equal(spawnKindFor(GAME.BOMB_P), 'star') // 恰等于 BOMB_P → 落入星区间（严格小于边界）
  assert.equal(spawnKindFor(0.2), 'star')
  assert.equal(spawnKindFor(0.9), 'bubble')
})

test('gameTick：泡泡自然消长——普通 1600ms 寿命（1599 存活 / 1600 过期，边界含等号）', () => {
  const seq = [0.5, 0.5] // cell=8，种类 roll 0.5 → 普通泡
  const r1 = gameTick(gameNewState(T0), T0 + 500, () => seq.shift())
  const spawn = r1.events.find((e) => e.kind === 'spawn')
  assert.equal(spawn.bubble, 'bubble')
  const mid = gameTick(r1.state, T0 + 500 + 1599, seededRng(1))
  assert.equal(mid.events.filter((e) => e.kind === 'expire').length, 0) // 差 1ms 仍存活
  const fin = gameTick(mid.state, T0 + 500 + 1600, seededRng(1))
  const expires = fin.events.filter((e) => e.kind === 'expire')
  assert.equal(expires.length, 1)
  assert.equal(expires[0].cell, spawn.cell)
  assert.equal(fin.state.board[spawn.cell], null)
})

test('gameTick：星 1200ms 过期而同刻出生的普通泡 1200ms 未过期（寿命对照）', () => {
  const mk = (kindRoll) => {
    const seq = [0.5, kindRoll]
    return gameTick(gameNewState(T0), T0 + 500, () => seq.shift())
  }
  const starRun = mk(0.2)
  assert.equal(starRun.events.find((e) => e.kind === 'spawn').bubble, 'star')
  const bubbleRun = mk(0.5)
  const starAt1200 = gameTick(starRun.state, T0 + 500 + 1200, seededRng(1))
  assert.equal(starAt1200.events.filter((e) => e.kind === 'expire').length, 1)
  const bubbleAt1200 = gameTick(bubbleRun.state, T0 + 500 + 1200, seededRng(1))
  assert.equal(bubbleAt1200.events.filter((e) => e.kind === 'expire').length, 0)
})

test('gameTick：棋盘满不再生成（不崩溃、状态不变）', () => {
  const filled = gameNewState(T0).board.map(() => ({ kind: 'bubble', bornAt: T0 + 600 }))
  const s0 = { ...gameNewState(T0), board: filled }
  const t1 = gameTick(s0, T0 + 600, seededRng(3))
  assert.equal(t1.events.filter((e) => e.kind === 'spawn').length, 0)
  assert.equal(t1.events.length, 0)
  assert.equal(t1.state.board.filter(Boolean).length, 16)
  assert.equal(t1.state.status, 'playing')
})

test('remainingMs 实时递减、归零即 ended；ended 后 tick 冻结；时钟回拨不扣时', () => {
  const s0 = gameNewState(T0, seededRng(1))
  const t1 = gameTick(s0, T0 + 1000)
  assert.equal(t1.state.remainingMs, GAME.DURATION_MS - 1000)
  assert.equal(t1.state.status, 'playing')
  // 打完时限：单次 tick 至多扣 2000ms（长停顿钳制，见下个用例）→ 按 ≤2000ms 节拍步进到归零。
  let ended = t1.state
  for (let at = T0 + 3000; ended.status === 'playing'; at += 2000) {
    ended = gameTick(ended, at).state
  }
  assert.equal(ended.remainingMs, 0)
  assert.equal(ended.status, 'ended')
  const t3 = gameTick(ended, T0 + GAME.DURATION_MS + 9999, seededRng(1))
  assert.equal(t3.state, ended) // 原样返回
  assert.deepEqual(t3.events, [])
  const t4 = gameTick(t1.state, T0 + 500) // now < lastAt → dt 钳为 0
  assert.equal(t4.state.remainingMs, GAME.DURATION_MS - 1000)
  assert.equal(t4.state.status, 'playing')
})

test('长停顿 dt 钳制：单次 tick 至多扣 2000ms（标签页隐藏期间时限等效暂停，恢复不整段扣完强结）', () => {
  // main.mjs 决策 tick 在 document.hidden 时停摆，隐藏 ≥ 剩余时限后返回本会把整段墙钟一次扣完
  // → 意外结算 + 白耗每日奖励名额；钳制后恢复只续扣 2s，玩家回来对局还在。
  const s0 = gameNewState(T0, seededRng(1))
  const hidden = gameTick(s0, T0 + 5 * 60_000) // 模拟隐藏 5 分钟后的首个决策 tick
  assert.equal(hidden.state.remainingMs, GAME.DURATION_MS - 2000)
  assert.equal(hidden.state.status, 'playing')
  const hiddenAgain = gameTick(hidden.state, T0 + 10 * 60_000) // 连续第二段长停顿：上限按单次 tick 独立生效
  assert.equal(hiddenAgain.state.remainingMs, GAME.DURATION_MS - 4000)
  assert.equal(hiddenAgain.state.status, 'playing')
})

test('gameTick 降级：null 状态 / 非法 now / 脏棋盘不抛错、局面不被破坏', () => {
  assert.deepEqual(gameTick(null, T0), { state: null, events: [] })
  const s0 = gameNewState(T0)
  const bad = gameTick(s0, null, seededRng(1)) // 非法 now → 原样返回（不把 lastAt 打回 0 污染时钟）
  assert.equal(bad.state, s0)
  assert.deepEqual(bad.events, [])
  assert.equal(bad.state.lastAt, T0)
  const dirty = { ...gameNewState(T0), board: 'not-an-array' }
  const out = gameTick(dirty, T0 + 1000, seededRng(1))
  assert.equal(out.events.length, 0)
  assert.equal(out.state.remainingMs, GAME.DURATION_MS - 1000) // 计时照走，棋盘原样
  assert.equal(out.state.board, 'not-an-array')
})

test('纯函数性：gameTick / gamePop 不 mutate 入参状态', () => {
  const s0 = gameNewState(T0)
  const snapshot = JSON.stringify(s0)
  gameTick(s0, T0 + 1000, seededRng(1))
  gamePop(s0, 0, T0 + 100)
  assert.equal(JSON.stringify(s0), snapshot)
})

test('rng 注入确定性：同种子同序列 → 完全一致的对局轨迹；不同种子轨迹不同', () => {
  const playSeedGame = (seed) => {
    const rng = seededRng(seed)
    let state = gameNewState(T0, rng)
    const events = []
    const pops = []
    for (let step = 0; step < 160; step += 1) {
      const now = T0 + step * 200
      const ticked = gameTick(state, now, rng)
      state = ticked.state
      events.push(...ticked.events)
      if (state.status !== 'playing') break
      const cell = (step * 5 + 3) % (GAME.GRID * GAME.GRID) // 5 与 16 互素 → 遍历全盘
      const popped = gamePop(state, cell, now + 10)
      state = popped.state
      if (popped.hit) pops.push({ step, kind: popped.kind, delta: popped.delta, combo: popped.combo })
    }
    return { state, events, pops }
  }
  const run1 = playSeedGame(20261002)
  const run2 = playSeedGame(20261002)
  assert.deepEqual(run1.state, run2.state)
  assert.deepEqual(run1.events, run2.events)
  assert.deepEqual(run1.pops, run2.pops)
  assert.ok(run1.events.some((e) => e.kind === 'spawn'))
  assert.ok(run1.pops.length > 0) // 用例有效：确有命中发生
  assert.equal(run1.state.status, 'ended') // 160×200ms > 30s → 自然打完
  const run3 = playSeedGame(20261003)
  assert.notEqual(JSON.stringify(run1.state), JSON.stringify(run3.state))
})

test('完整流程冒烟：开局 → tick 生成 → pop 命中 → 时限结束 → 结算 lose', () => {
  const rng = () => 0.99 // cell=最后空格 15，种类 roll 0.99 → 普通泡
  let state = gameNewState(T0, rng)
  state = gameTick(state, T0 + 500, rng).state
  const popped = gamePop(state, 15, T0 + 600)
  assert.equal(popped.hit, true)
  assert.equal(popped.delta, GAME.BASE + 2)
  state = popped.state
  // 时限打完：dt 单次至多扣 2000ms（长停顿钳制）→ 按 ≤2000ms 节拍步进到归零。
  let finished = { state }
  for (let at = T0 + 2600; finished.state.status === 'playing'; at += 2000) {
    finished = gameTick(finished.state, at, rng)
  }
  assert.equal(finished.state.status, 'ended')
  assert.deepEqual(gameResult(finished.state), { score: 12, grade: 'lose', comboMax: 1 })
})

test('gameResult：聚合 score/grade/comboMax（null / NaN 降级 0 分 lose）', () => {
  assert.deepEqual(gameResult({ ...gameNewState(T0), score: 320, comboMax: 7, status: 'ended' }),
    { score: 320, grade: 'win', comboMax: 7 })
  assert.equal(gameResult({ ...gameNewState(T0), score: 150 }).grade, 'draw')
  assert.equal(gameResult({ ...gameNewState(T0), score: 40 }).grade, 'lose')
  assert.deepEqual(gameResult(null), { score: 0, grade: 'lose', comboMax: 0 })
  assert.deepEqual(gameResult({ score: Number.NaN, comboMax: Number.NaN }), { score: 0, grade: 'lose', comboMax: 0 })
})

test('gameRewardAllowed：每日 3 局上限 / 跨日重置读视图 / null 与脏 blob 降级', () => {
  const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime() // 本地 2026-10-2（dayKey 格式：本地 YYYY-M-D 无前导零）
  const TODAY = '2026-10-2'
  assert.equal(gameRewardAllowed(null, NOW), true)
  assert.equal(gameRewardAllowed({}, NOW), true)
  assert.equal(gameRewardAllowed({ game: null }, NOW), true)
  assert.equal(gameRewardAllowed({ game: { playsDay: TODAY, playsToday: 0 } }, NOW), true)
  assert.equal(gameRewardAllowed({ game: { playsDay: TODAY, playsToday: 2 } }, NOW), true)
  assert.equal(gameRewardAllowed({ game: { playsDay: TODAY, playsToday: 3 } }, NOW), false)
  assert.equal(gameRewardAllowed({ game: { playsDay: TODAY, playsToday: 99 } }, NOW), false)
  // 跨日：playsDay 还是旧日键 → 视为未消耗（重置动作在 growth.ingest 入口，读视图对凌晨窗口正确放行）。
  assert.equal(gameRewardAllowed({ game: { playsDay: '2026-10-1', playsToday: 3 } }, NOW), true)
  // 脏 playsToday 视为 0。
  assert.equal(gameRewardAllowed({ game: { playsDay: TODAY, playsToday: 'x' } }, NOW), true)
  // now 传 Date 实例亦可；非法 now 无法判定当日 → 放行。
  assert.equal(gameRewardAllowed({ game: { playsDay: TODAY, playsToday: 3 } }, new Date(2026, 9, 2, 23, 59)), false)
  assert.equal(gameRewardAllowed({ game: { playsDay: TODAY, playsToday: 3 } }, null), true)
})

test('跨模块漂移守卫：growth 写入的 blob.game.playsDay 与 game 侧当日键同格式（每日上限不被静默绕过）', () => {
  // game.mjs dayKeyOf 与 growth.mjs dayKey 是各自私有的双实现（game.mjs 头注自称「跨模块契约点」，
  // blob 唯一写方是 growth）：任一侧单改格式（补零/改字段序）→ gameRewardAllowed 的
  // playsDay !== today 恒真 → 每日 3 局奖励上限静默失效且无断言变红。
  // 本用例经两侧公共 API 端到端钉住同格式：createGrowth（固定时钟）喂满 3 局 game-play，
  // 同一时刻 gameRewardAllowed 必须拒绝第 4 局——任一侧格式漂移时它恒返回 true，此断言即红。
  const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime() // 本地 2026-10-2 12:00（两侧 dayKey 同为本地时区）
  let mem = null
  const g = createGrowth({
    storage: {
      load: () => (mem === null ? null : JSON.parse(JSON.stringify(mem))),
      save: (b) => { mem = JSON.parse(JSON.stringify(b)) },
    },
    now: () => NOW,
    random: () => 0.5,
  })
  for (let i = 0; i < 3; i += 1) g.ingest({ metric: 'game-play', amount: 1 })
  const blob = g.snapshot()
  assert.equal(blob.game.playsToday, 3)
  assert.equal(blob.game.playsDay, '2026-10-2') // 'YYYY-M-D' 无前导零字面（growth 侧格式漂移此处先红）
  assert.equal(
    gameRewardAllowed(blob, NOW),
    false,
    'playsDay 与 game 侧当日键格式漂移 → 恒放行（每日上限失效），此断言变红',
  )
})

test('gamePose 姿势映射全分支（素材 game-{think,happy,cheat,win,lose}；未知阶段 → null）', () => {
  assert.equal(gamePose('playing'), 'game-think') // 开局/进行中默认
  assert.equal(gamePose('combo'), 'game-happy') // 连击 ≥5 达成后（宿主判定何时传 'combo'）
  assert.equal(gamePose('bomb'), 'game-cheat') // 点中炸弹瞬间
  assert.equal(gamePose('win'), 'game-win')
  assert.equal(gamePose('draw'), 'game-happy') // 平局复用 happy（无 game-draw 素材，phase2-plan §7 裁定）
  assert.equal(gamePose('lose'), 'game-lose')
  assert.equal(gamePose('ended'), null) // 结算面板关闭/游戏结束 → 无覆盖，回正常状态机
  assert.equal(gamePose(null), null)
  assert.equal(gamePose('nonsense'), null)
})
