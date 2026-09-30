// M5-7 主动关怀单测：深夜静音段判定 / 关怀定时与交互重置 / 番茄钟状态机 /
// 短剧抽样与间隔 / 散步门控 / 深夜兜底视觉 / 设置归一化（.check 语义）。
// 全部纯函数注入时钟与随机源，不碰 DOM/定时器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  minutesOfDay, isNightMute, careDue, tickPomodoro,
  pickSkit, nextSkitAt, walkAllowed, nightVisualState, SKIT_LINES,
  NIGHT_MUTE_START_MIN, NIGHT_MUTE_END_MIN, POMODORO_FOCUS_MS, POMODORO_BREAK_MS,
} from '../lib/client/care.mjs'
import { normalizeSettings, DEFAULT_SETTINGS, LIMITS } from '../lib/client/settings.mjs'

const at = (h, m = 0) => new Date(2026, 8, 30, h, m) // 本地 2026-09-30 hh:mm

// ---- 深夜静音段（M5-2）----
test('minutesOfDay：本地时刻换算与非法输入', () => {
  assert.equal(minutesOfDay(at(23, 5)), 23 * 60 + 5)
  assert.equal(minutesOfDay(at(0, 1)), 1)
  assert.equal(minutesOfDay(Number.NaN), null)
  assert.equal(minutesOfDay('x'), null)
})

test('isNightMute：默认 23:00–07:00 跨午夜窗口', () => {
  assert.equal(isNightMute(at(22, 59)), false)
  assert.equal(isNightMute(at(23, 0)), true)
  assert.equal(isNightMute(at(2, 30)), true)
  assert.equal(isNightMute(at(6, 59)), true)
  assert.equal(isNightMute(at(7, 0)), false)
  assert.equal(isNightMute(at(12, 0)), false)
})

test('isNightMute：窗口可配（含非跨午夜与零长窗口）与开关', () => {
  const cfg = { startMin: 9 * 60, endMin: 12 * 60 }
  assert.equal(isNightMute(at(8, 59), cfg), false)
  assert.equal(isNightMute(at(9, 0), cfg), true)
  assert.equal(isNightMute(at(11, 59), cfg), true)
  assert.equal(isNightMute(at(12, 0), cfg), false)
  assert.equal(isNightMute(at(3, 0), { ...cfg, enabled: false }), false) // 开关关闭
  assert.equal(isNightMute(at(3, 0), { startMin: 600, endMin: 600 }), false) // 零长窗口=关闭
  assert.equal(isNightMute(at(3, 0), { startMin: 23 * 60, endMin: 5 * 60 }), true) // 自定义跨午夜
})

// ---- 关怀提醒（M5-1）：固定间隔 + 用户交互重置 ----
const MIN45 = 45 * 60_000

test('careDue：到点触发（间隔边界）', () => {
  const base = { lastInteractAt: 0, lastFiredAt: null, intervalMs: MIN45 }
  assert.equal(careDue({ ...base, now: MIN45 - 1 }), false)
  assert.equal(careDue({ ...base, now: MIN45 }), true)
  assert.equal(careDue({ ...base, now: MIN45 * 2 }), true) // 超时未触发也只报一次到期
})

test('careDue：触发后不再重复；交互重置后重新武装', () => {
  // T0 交互 → T45m 提醒（lastFiredAt=T45m）→ T90m 无人理：不重复提醒
  const afterFire = { lastInteractAt: 0, lastFiredAt: MIN45, intervalMs: MIN45 }
  assert.equal(careDue({ ...afterFire, now: MIN45 * 2 }), false)
  assert.equal(careDue({ ...afterFire, now: MIN45 * 10 }), false)
  // T50m 用户再次交互（重置）→ T95m 到期可再次提醒
  const interacted = { lastInteractAt: 50 * 60_000, lastFiredAt: MIN45, intervalMs: MIN45 }
  assert.equal(careDue({ ...interacted, now: 94 * 60_000 }), false)
  assert.equal(careDue({ ...interacted, now: 95 * 60_000 }), true)
})

test('careDue：非法间隔/未交互不触发', () => {
  assert.equal(careDue({ now: 1e15, lastInteractAt: 0, lastFiredAt: null, intervalMs: 0 }), false)
  assert.equal(careDue({ now: 1e15, lastInteractAt: 0, lastFiredAt: null, intervalMs: Number.NaN }), false)
  assert.equal(careDue({ now: 1e15, lastInteractAt: Number.NaN, lastFiredAt: null, intervalMs: MIN45 }), false)
})

// ---- 番茄钟（M5-1）----
test('tickPomodoro：off 恒不触发', () => {
  assert.deepEqual(tickPomodoro({ phase: 'off', endsAt: 0 }, 1e12), { phase: 'off', endsAt: 0, fired: null })
})

test('tickPomodoro：focus→break→focus 边沿与时长', () => {
  const t0 = 1_000_000
  // 专注中：不触发
  const focusing = { phase: 'focus', endsAt: t0 + POMODORO_FOCUS_MS }
  assert.deepEqual(tickPomodoro(focusing, t0 + POMODORO_FOCUS_MS - 1), { phase: 'focus', endsAt: t0 + POMODORO_FOCUS_MS, fired: null })
  // 到点：focus-end，进入 5min 休息
  const step1 = tickPomodoro(focusing, t0 + POMODORO_FOCUS_MS)
  assert.equal(step1.fired, 'focus-end')
  assert.equal(step1.phase, 'break')
  assert.equal(step1.endsAt, t0 + POMODORO_FOCUS_MS + POMODORO_BREAK_MS)
  // 休息到点：break-end，回到专注
  const step2 = tickPomodoro(step1, step1.endsAt)
  assert.equal(step2.fired, 'break-end')
  assert.equal(step2.phase, 'focus')
  assert.equal(step2.endsAt, step1.endsAt + POMODORO_FOCUS_MS)
})

test('tickPomodoro：自定义时长（测试注入）', () => {
  const step = tickPomodoro({ phase: 'focus', endsAt: 100 }, 200, { focusMs: 50, breakMs: 10 })
  assert.equal(step.phase, 'break')
  assert.equal(step.endsAt, 210)
  assert.equal(step.fired, 'focus-end')
})

// ---- 随机情景短剧（M5-3）----
test('SKIT_LINES：30-50 条内置台词', () => {
  assert.ok(SKIT_LINES.length >= 30 && SKIT_LINES.length <= 50, `台词数 ${SKIT_LINES.length} 不在 30-50`)
  assert.ok(SKIT_LINES.every((line) => typeof line === 'string' && line.length > 0))
})

test('pickSkit：合法索引 + avoid 生效 + 全避开回退全集', () => {
  const rng = () => 0 // 恒取候选池第一个
  const first = pickSkit(null, rng)
  assert.equal(first.index, 0)
  assert.equal(first.text, SKIT_LINES[0])
  const avoided = pickSkit([0], rng)
  assert.equal(avoided.index, 1) // 池内跳过 0
  const all = Array.from({ length: SKIT_LINES.length }, (_, i) => i)
  assert.equal(pickSkit(all, rng).index, 0) // 全避开 → 回退全集
})

test('nextSkitAt：随机间隔落在 [min, max] 区间', () => {
  const now = 5_000_000
  const lo = 40 * 60_000
  const hi = 80 * 60_000
  assert.equal(nextSkitAt({ now, random: () => 0 }), now + lo)
  assert.equal(nextSkitAt({ now, random: () => 1 - Number.EPSILON }), now + hi)
  const mid = nextSkitAt({ now, random: () => 0.5 })
  assert.ok(mid > now + lo && mid < now + hi)
})

// ---- 散步门控（M5-4）与深夜兜底视觉（M5-2）----
test('walkAllowed：开关/静音段/拖拽任一命中即禁', () => {
  assert.equal(walkAllowed({}), true)
  assert.equal(walkAllowed({ enabled: false }), false)
  assert.equal(walkAllowed({ nightMute: true }), false)
  assert.equal(walkAllowed({ dragging: true }), false)
  assert.equal(walkAllowed({ enabled: true, nightMute: false, dragging: false }), true)
})

test('nightVisualState：仅静音段 idle 替换为 night，其余照常', () => {
  assert.equal(nightVisualState('idle', true), 'night')
  assert.equal(nightVisualState('think', true), 'think') // 状态镜像不静默
  assert.equal(nightVisualState('wait', true), 'wait')
  assert.equal(nightVisualState('idle', false), 'idle')
  assert.equal(nightVisualState('sleep', true), 'sleep')
})

// ---- 设置归一化（M5-6 .check 语义）----
test('normalizeSettings：null/脏数据回默认全量配置', () => {
  assert.deepEqual(normalizeSettings(null), JSON.parse(JSON.stringify(DEFAULT_SETTINGS)))
  assert.deepEqual(normalizeSettings(undefined), JSON.parse(JSON.stringify(DEFAULT_SETTINGS)))
  assert.deepEqual(normalizeSettings('garbage'), JSON.parse(JSON.stringify(DEFAULT_SETTINGS)))
  assert.deepEqual(normalizeSettings(42), JSON.parse(JSON.stringify(DEFAULT_SETTINGS)))
})

test('normalizeSettings：逐字段类型纠正与范围钳制', () => {
  const out = normalizeSettings({
    care: { sedentaryEnabled: 'true', sedentaryMin: '25', waterEnabled: 0, waterMin: 999, pomodoroEnabled: 1 },
    skit: { enabled: 1, minMinutes: 5, maxMinutes: 1000 },
    night: { muteEnabled: 'false', startMin: -1, endMin: 99999 },
    walkEnabled: '1',
    sound: { enabled: 'yes', file: 123 },
    unknownField: { x: 1 },
  })
  assert.equal(out.care.sedentaryEnabled, true) // 'true' → true
  assert.equal(out.care.sedentaryMin, 25) // '25' → 25
  assert.equal(out.care.waterEnabled, false) // 0 → false
  assert.equal(out.care.waterMin, LIMITS.waterMin[1]) // 999 钳到 180
  assert.equal(out.care.pomodoroEnabled, true) // 1 → true
  assert.equal(out.skit.enabled, true)
  assert.equal(out.skit.minMinutes, LIMITS.skitMinMin[0]) // 5 钳到 15
  assert.equal(out.skit.maxMinutes, LIMITS.skitMaxMin[1]) // 1000 钳到 480
  assert.equal(out.night.muteEnabled, false) // 'false' → false
  assert.equal(out.night.startMin, LIMITS.muteStartMin[0]) // -1 钳到 0
  assert.equal(out.night.endMin, LIMITS.muteEndMin[1]) // 99999 钳到 1439
  assert.equal(out.walkEnabled, true)
  assert.equal(out.sound.enabled, DEFAULT_SETTINGS.sound.enabled) // 'yes' 非法 → 回默认 false
  assert.equal(out.sound.file, '') // 非字符串回默认
  assert.equal('unknownField' in out, false) // 未知字段忽略
})

test('normalizeSettings：skit 区间颠倒时交换（保留用户意图）+ 合法配置透传', () => {
  const swapped = normalizeSettings({ skit: { minMinutes: 90, maxMinutes: 30 } })
  assert.deepEqual([swapped.skit.minMinutes, swapped.skit.maxMinutes], [30, 90])
  const pass = normalizeSettings({
    care: { sedentaryEnabled: false, sedentaryMin: 30, waterEnabled: false, waterMin: 90, pomodoroEnabled: true },
    skit: { enabled: false, minMinutes: 20, maxMinutes: 60 },
    night: { muteEnabled: false, startMin: 22 * 60, endMin: 6 * 60 },
    walkEnabled: false,
    sound: { enabled: true, file: 'D:\\sounds\\done.wav' },
  })
  assert.equal(pass.care.pomodoroEnabled, true)
  assert.equal(pass.sound.file, 'D:\\sounds\\done.wav')
  assert.equal(pass.night.startMin, 22 * 60)
})

test('默认值红线：完成音效默认关、番茄钟默认关、深夜静音默认开', () => {
  assert.equal(DEFAULT_SETTINGS.sound.enabled, false) // M5-5：默认关
  assert.equal(DEFAULT_SETTINGS.care.pomodoroEnabled, false) // 强主动项默认关
  assert.equal(DEFAULT_SETTINGS.night.muteEnabled, true) // 静音段默认守护
  assert.equal(DEFAULT_SETTINGS.night.startMin, NIGHT_MUTE_START_MIN)
  assert.equal(DEFAULT_SETTINGS.night.endMin, NIGHT_MUTE_END_MIN)
})
