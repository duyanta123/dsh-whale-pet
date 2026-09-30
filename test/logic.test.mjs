// M1-9 状态机单测：全行序覆盖 + 负面保护 + 醒觉规则（规格：docs/state-machine.md）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  selectState, activeBurst, wakeFromInteraction, shouldWake,
  nextFacingAt, nextWalkRhythm, detectTurnCompleted, STATE_NAMES,
  WELCOME_MS, CELEBRATE_MS, ERROR_MS, DISAPPOINTED_MS,
} from '../lib/client/logic.mjs'

const NOW = 1_000_000
const facts = (over = {}) => ({ windows: [], wait: false, thinking: false, ...over })
const local = (over = {}) => ({
  dragging: false, dragReleaseUntil: 0, transient: null, celebrateUntil: 0,
  workingActive: false, joyUntil: 0, sleeping: false, walking: false, ...over,
})
const burst = (name, until = NOW + 1000) => ({ windows: [{ name, until }] })

test('STATE_NAMES 与 docs/state-machine.md §2 一致（17 agent 状态 + 3 热区反应）', () => {
  assert.deepEqual([...STATE_NAMES], [
    'idle', 'working', 'celebrate', 'error', 'disappointed', 'joy', 'eat', 'play',
    'drag', 'walk', 'sleep', 'wake', 'welcome', 'think', 'wait', 'night', 'struggling',
    'react-head', 'react-belly', 'react-tail',
  ])
})

test('R8.5 struggling：遇挫事实盖过 working/think，低于 celebrate/wait', () => {
  assert.equal(selectState(facts({ struggling: true }), local(), NOW), 'struggling')
  assert.equal(selectState(facts({ struggling: true }), local({ workingActive: true }), NOW), 'struggling')
  assert.equal(selectState(facts({ struggling: true, thinking: true }), local(), NOW), 'struggling')
  assert.equal(selectState(facts({ struggling: true, wait: true }), local(), NOW), 'wait')
  assert.equal(selectState({ windows: [{ name: 'error', until: NOW + 1000 }], struggling: true }, local(), NOW), 'error')
  assert.equal(selectState(facts({ struggling: true }), local({ celebrateUntil: NOW + 1000 }), NOW), 'celebrate')
})

test('R1 drag：拖拽按住压倒一切', () => {
  assert.equal(selectState(burst('error'), local({ dragging: true }), NOW), 'drag')
  assert.equal(selectState(facts({ wait: true }), local({ dragging: true, sleeping: true }), NOW), 'drag')
})

test('R2 放下缓冲：松手 1.5s 内保持 idle；wake 瞬发不吃缓冲', () => {
  const release = local({ dragReleaseUntil: NOW + 1500 })
  assert.equal(selectState(facts(), release, NOW), 'idle')
  assert.equal(selectState(facts(), { ...release, transient: 'wake' }, NOW), 'wake')
  // 缓冲过期后回落底层（think）。
  assert.equal(selectState(facts({ thinking: true }), { ...release, dragReleaseUntil: NOW - 1 }, NOW), 'think')
})

test('R3 事件 burst：窗口内命中并解析为窗口名', () => {
  assert.equal(selectState(burst('welcome', NOW + WELCOME_MS), local(), NOW), 'welcome')
  assert.equal(selectState(burst('celebrate'), local(), NOW), 'celebrate')
  // 窗口过期后回落。
  assert.equal(selectState(burst('welcome', NOW - 1), local({ sleeping: true }), NOW), 'sleep')
})

test('R3 负面保护：welcome 不打断 error/disappointed 尾段（windows 首个命中）', () => {
  const both = { windows: [{ name: 'error', until: NOW + ERROR_MS }, { name: 'welcome', until: NOW + WELCOME_MS }] }
  assert.equal(selectState(facts(both), local(), NOW), 'error')
  const tail = { windows: [{ name: 'disappointed', until: NOW + DISAPPOINTED_MS }, { name: 'welcome', until: NOW + WELCOME_MS }] }
  assert.equal(selectState(facts(tail), local(), NOW), 'disappointed')
  // 负面窗口过期后 welcome 生效。
  const after = { windows: [{ name: 'error', until: NOW - 1 }, { name: 'welcome', until: NOW + WELCOME_MS }] }
  assert.equal(selectState(facts(after), local(), NOW), 'welcome')
})

test('activeBurst：取首个未过期窗口；空/全过期返回 null', () => {
  assert.equal(activeBurst(facts(), NOW), null)
  assert.equal(activeBurst({ windows: [{ name: 'error', until: NOW - 1 }] }, NOW), null)
  assert.equal(activeBurst(burst('celebrate'), NOW)?.name, 'celebrate')
})

test('R4-R6 eat/play/wake 瞬发顺序 + 热区反应行', () => {
  assert.equal(selectState(facts(), local({ transient: 'eat' }), NOW), 'eat')
  assert.equal(selectState(facts(), local({ transient: 'play' }), NOW), 'play')
  assert.equal(selectState(facts(), local({ react: 'head' }), NOW), 'react-head')
  assert.equal(selectState(facts(), local({ react: 'belly' }), NOW), 'react-belly')
  assert.equal(selectState(facts(), local({ react: 'tail' }), NOW), 'react-tail')
  assert.equal(selectState(facts(), local({ transient: 'wake' }), NOW), 'wake')
  // 热区反应低于 eat/play 瞬发（同时发生时投喂优先）。
  assert.equal(selectState(facts(), local({ transient: 'eat', react: 'tail' }), NOW), 'eat')
})

test('R7 wait 等审批：低于瞬发、高于回合庆祝与 working', () => {
  assert.equal(selectState(facts({ wait: true }), local({ celebrateUntil: NOW + 100 }), NOW), 'wait')
  assert.equal(selectState(facts({ wait: true }), local({ workingActive: true, celebrateUntil: NOW + 100 }), NOW), 'wait')
  // 瞬发仍压过 wait。
  assert.equal(selectState(facts({ wait: true }), local({ transient: 'eat' }), NOW), 'eat')
})

test('R8/R9/R10 回合庆祝 > working 插曲 > think 常态（行序 R8<R9<R10）', () => {
  const celebrating = local({ celebrateUntil: NOW + 100 })
  assert.equal(selectState(facts(), celebrating, NOW), 'celebrate')
  // 庆祝窗压过 working 插曲（事件庆祝优先于插曲）。
  assert.equal(selectState(facts(), { ...celebrating, workingActive: true }, NOW), 'celebrate')
  assert.equal(selectState(facts({ thinking: true }), { ...celebrating, workingActive: true }, NOW), 'celebrate')
  // 庆祝窗过后：working 插曲 > think。
  const after = local({ celebrateUntil: NOW - 1, workingActive: true })
  assert.equal(selectState(facts({ thinking: true }), after, NOW), 'working')
  assert.equal(selectState(facts({ thinking: true }), { ...after, workingActive: false }, NOW), 'think')
})

test('R11-R13 joy < sleep < walk < idle 兜底', () => {
  assert.equal(selectState(facts(), local({ joyUntil: NOW + 10 }), NOW), 'joy')
  assert.equal(selectState(facts(), local({ sleeping: true }), NOW), 'sleep')
  assert.equal(selectState(facts(), local({ walking: true }), NOW), 'walk')
  assert.equal(selectState(facts(), local(), NOW), 'idle')
  // 会话活跃时 think 覆盖 sleep（陪伴优先于入睡）。
  assert.equal(selectState(facts({ thinking: true }), local({ sleeping: true }), NOW), 'think')
})

test('wakeFromInteraction：仅视觉 sleep 才播醒觉；交互恒重置空闲', () => {
  assert.deepEqual(wakeFromInteraction({ visuallySleeping: true }), { sleeping: false, wake: true })
  assert.deepEqual(wakeFromInteraction({ visuallySleeping: false }), { sleeping: false, wake: false })
  assert.deepEqual(wakeFromInteraction({}), { sleeping: false, wake: false })
})

test('shouldWake：sleep→非 sleep 边沿且无拖拽/瞬发才触发', () => {
  assert.equal(shouldWake('sleep', 'think', {}), true)
  assert.equal(shouldWake('sleep', 'think', { dragging: true }), false)
  assert.equal(shouldWake('sleep', 'think', { transient: 'eat' }), false)
  assert.equal(shouldWake('idle', 'think', {}), false)
  assert.equal(shouldWake('sleep', 'sleep', {}), false)
})

test('nextFacingAt：10-25s 区间（注入随机源）', () => {
  assert.equal(nextFacingAt({ now: NOW, random: () => 0 }), NOW + 10000)
  assert.equal(nextFacingAt({ now: NOW, random: () => 1 }), NOW + 25000)
  assert.equal(nextFacingAt({ now: NOW, random: () => 0.5 }), NOW + 17500)
})

test('nextWalkRhythm：18-40s 间隔 / 4-8s 时长', () => {
  assert.deepEqual(nextWalkRhythm({ now: NOW, walking: false, random: () => 0 }), { active: true, until: NOW + 18000 })
  assert.deepEqual(nextWalkRhythm({ now: NOW, walking: false, random: () => 1 }), { active: true, until: NOW + 40000 })
  assert.deepEqual(nextWalkRhythm({ now: NOW, walking: true, random: () => 0 }), { active: false, until: NOW + 4000 })
  assert.deepEqual(nextWalkRhythm({ now: NOW, walking: true, random: () => 1 }), { active: false, until: NOW + 8000 })
})

test('detectTurnCompleted：running true→false 边沿 + 位表收缩', () => {
  const prev = new Map([['a', true], ['b', true], ['gone', true]])
  const { flips, prevRunning } = detectTurnCompleted({ byId: { a: { running: false }, b: { running: true }, c: { running: true } } }, prev)
  assert.deepEqual(flips, [{ id: 'a' }])
  assert.equal(prevRunning.get('a'), false)
  assert.equal(prevRunning.get('b'), true)
  assert.equal(prevRunning.get('c'), true)
  assert.equal(prevRunning.has('gone'), false)
  // 再跑一轮：a 已 false 不重复翻转。
  const again = detectTurnCompleted({ byId: { a: { running: false } } }, prevRunning)
  assert.deepEqual(again.flips, [])
})
