#!/usr/bin/env node
// 浸泡测试（M6-2，参照 musume soak-work 思路的 Node 侧等价物）：
// 以加速时钟对纯决策层做 20 万步持续浸泡——状态选择/节奏器/关怀/番茄钟/遇挫折叠/
// telemetry 折叠计价全链路，周期采样 heapUsed 断言无单调增长趋势，决策输出断言恒在
// 合法状态集内。GUI 侧长时间浸泡（真实 DOM/解码）仍待浏览器复核批次（见计划附录 B）。
// 运行：node scripts/soak.mjs [--steps 200000]
import { selectState, STATE_NAMES } from '../lib/client/logic.mjs'
import { nextWorkingRhythm } from '../lib/client/rhythm.mjs'
import { nextWalkRhythm, nextFacingAt, wakeFromInteraction } from '../lib/client/logic.mjs'
import {
  isNightMute, careDue, tickPomodoro, pickSkit, nextSkitAt, walkAllowed, nightVisualState,
} from '../lib/client/care.mjs'
import {
  struggleKindOf, foldTelemetryDay, telemetryCost, insightLines, pickProactiveLine,
} from '../lib/client/fusion.mjs'

const args = process.argv.slice(2)
const stepsFlag = args.indexOf('--steps')
const STEPS = stepsFlag >= 0 ? Number(args[stepsFlag + 1]) || 200000 : 200000

const STATE_SET = new Set(STATE_NAMES)
const WINDOWS = ['welcome', 'celebrate', 'error', 'disappointed']
const SESSION_EVENT_TYPES = [
  'turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result',
  'llm/retry', 'assistant/message', 'assistant/chunk', 'request/context',
]

let clock = Date.now()
let seed = 0x2f6e2b1
const rng = () => {
  // xorshift32：可复现伪随机
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
  return ((seed >>> 0) % 100000) / 100000
}
const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length]

const local = {
  dragging: false, dragReleaseUntil: 0, transient: null, transientUntil: 0, celebrateUntil: 0,
  workingActive: false, joyUntil: 0, sleeping: false, walking: false, react: null, reactUntil: 0,
  lastFedAt: null, lastInteractAt: clock, animState: 'idle',
}
const facts = { windows: [], wait: false, thinking: false, struggling: false, insights: [], announce: null }
let working = { active: false, until: 0 }
let workingTimerUntil = 0
let walkTimerUntil = 0
let facingTurnAt = 0
let strugglingUntil = 0
let pomo = { phase: 'off', endsAt: 0 }
const careWater = { lastFiredAt: null }
const careSedentary = { lastFiredAt: null }
const settings = { care: { sedentaryEnabled: true, waterEnabled: true, pomodoroEnabled: true }, skit: { enabled: true, minMinutes: 40, maxMinutes: 80 }, night: { muteEnabled: true, startMin: 1380, endMin: 420 }, walkEnabled: true, fusion: { enabled: true } }

// telemetry 折叠输入：合成 3 天的 JSONL 行（含坏行）反复折叠计价
const synthLines = []
for (let i = 0; i < 2000; i += 1) {
  const t = new Date(clock - i * 60000).toISOString()
  const r = rng()
  if (r < 0.4) {
    synthLines.push(JSON.stringify({
      event: 'model.completed', timestamp: t, duration_ms: Math.floor(rng() * 5000),
      model: { name: rng() < 0.7 ? 'deepseek-flash' : 'deepseek-chat', provider: 'deepseek-official' },
      usage: { input_tokens: Math.floor(rng() * 5000), output_tokens: Math.floor(rng() * 800), cached_input_tokens: Math.floor(rng() * 3000), reasoning_tokens: 0 },
      result: { status: 'success' },
    }))
  } else if (r < 0.6) {
    synthLines.push(JSON.stringify({
      event: 'tool.completed', timestamp: t, duration_ms: Math.floor(rng() * 20000),
      tool: { name: pick(['pwsh', 'read', 'edit']) },
      result: { status: rng() < 0.9 ? 'success' : 'failed' },
    }))
  } else {
    synthLines.push(rng() < 0.5 ? 'not-json-garbage' : JSON.stringify({ event: 'request.started', timestamp: t }))
  }
}
let lastFoldHash = 0

const heapSamples = []
let decisions = 0
let transitions = 0
let prevAnim = 'idle'
let errors = 0

const tickOnce = () => {
  clock += 250 + Math.floor(rng() * 250)
  const now = clock

  // 事实演化（合成会话流 + 遇挫窗口）
  if (rng() < 0.06) {
    const ev = { type: pick(SESSION_EVENT_TYPES), time: now, data: rng() < 0.1 ? { message: { content: [{ isError: true }] } } : {} }
    const kind = struggleKindOf(ev)
    if (kind !== null) strugglingUntil = Math.max(strugglingUntil, now + 15000)
  }
  strugglingUntil = Math.max(0, strugglingUntil)
  facts.struggling = strugglingUntil > now
  if (rng() < 0.02) facts.thinking = !facts.thinking
  if (rng() < 0.01) facts.wait = !facts.wait
  if (rng() < 0.005 && facts.windows.length < 2) {
    facts.windows.push({ name: pick(WINDOWS), until: now + 6000 })
  }
  facts.windows = facts.windows.filter((w) => w.until > now)
  facts.insights = rng() < 0.01 ? insightLines(foldTelemetryDay(synthLines)) : facts.insights

  // 本地派生 + 节奏器
  local.sleeping = now - local.lastInteractAt >= 60000
  local.workingActive = working.active && facts.thinking
  if (rng() < 0.01) local.lastInteractAt = now // 交互重置

  if (rng() < 0.02) {
    const decision = nextWorkingRhythm({ now, thinking: facts.thinking, working })
    workingTimerUntil = decision.until
    working = { active: decision.active, until: 0 }
  }
  if (rng() < 0.02) {
    const decision = nextWalkRhythm({ now, walking: local.walking })
    walkTimerUntil = decision.until
    if (decision.active && walkAllowed({ enabled: settings.walkEnabled, nightMute: isNightMute(now, settings.night), dragging: local.dragging })) {
      local.walking = true
    } else if (!decision.active) local.walking = false
  }
  if (!walkAllowed({ enabled: settings.walkEnabled, nightMute: isNightMute(now, settings.night), dragging: local.dragging })) local.walking = false

  // 关怀 + 番茄钟（静音段冻结）
  const nightMute = isNightMute(now, settings.night)
  if (!nightMute) {
    if (settings.care.sedentaryEnabled && careDue({ now, lastInteractAt: local.lastInteractAt, lastFiredAt: careSedentary.lastFiredAt, intervalMs: 45 * 60000 })) careSedentary.lastFiredAt = now
    if (settings.care.waterEnabled && careDue({ now, lastInteractAt: local.lastInteractAt, lastFiredAt: careWater.lastFiredAt, intervalMs: 60 * 60000 })) careWater.lastFiredAt = now
    if (settings.care.pomodoroEnabled) {
      if (pomo.phase === 'off') pomo = { phase: 'focus', endsAt: now + 25 * 60000 }
      pomo = tickPomodoro(pomo, now)
    }
  } else if (pomo.phase !== 'off') pomo = { phase: 'off', endsAt: 0 }

  if ((local.animState === 'idle' || local.animState === 'think' || local.animState === 'wait') && now >= facingTurnAt) {
    facingTurnAt = nextFacingAt({ now, random: rng })
  }

  // 决策 + 兜底视觉替换 + 状态合法性
  let next = selectState(facts, local, now)
  next = nightVisualState(next, nightMute)
  if (!STATE_SET.has(next)) throw new Error(`非法状态产出：${next}`)
  if (next !== prevAnim) transitions += 1
  prevAnim = local.animState = next
  decisions += 1

  // 周期折叠计价（每 50 步一轮，模拟洞察/实测刷新频率）
  if (decisions % 50 === 0) {
    const fold = foldTelemetryDay(synthLines)
    const cost = telemetryCost(fold, clock - 3600_000)
    lastFoldHash = (lastFoldHash + Math.round((cost.costCny ?? 0) * 1e6) + fold.tools.length) | 0
    const line = pickProactiveLine({ insights: facts.insights, avoidTexts: [], random: rng }, () => pickSkit(null, rng).text)
    if (typeof line.line !== 'string' || line.line.length === 0) throw new Error('空播报产出')
  }
  // 随机作息决策碰撞检测
  if (rng() < 0.02) wakeFromInteraction({ visuallySleeping: prevAnim === 'sleep' })
}

const t0 = Date.now()
for (let i = 1; i <= STEPS; i += 1) {
  try {
    tickOnce()
  } catch (error) {
    errors += 1
    if (errors > 5) {
      console.error(`soak 失败：连续异常 ${errors} 次：`, error)
      process.exit(1)
    }
  }
  if (i % 25000 === 0) {
    global.gc?.()
    heapSamples.push(process.memoryUsage().heapUsed)
  }
}
const wallMs = Date.now() - t0

// 堆趋势断言：末段均值对比首段均值，容忍 2.5x（GC 噪声），单调泄漏会远超
const head = heapSamples.slice(0, 3)
const tail = heapSamples.slice(-3)
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length
const growth = avg(tail) / Math.max(1, avg(head))

console.log(`soak 完成：${decisions} 步 / ${transitions} 次状态迁移 / ${errors} 次异常 / ${wallMs}ms`)
console.log(`heap 首/末段均值：${(avg(head) / 1048576).toFixed(1)}MB → ${(avg(tail) / 1048576).toFixed(1)}MB（增长 ${growth.toFixed(2)}x，foldHash ${lastFoldHash}）`)
if (errors > 0) {
  console.error(`soak 失败：${errors} 次决策异常`)
  process.exit(1)
}
if (growth > 2.5) {
  console.error('soak 失败：堆增长疑似泄漏（>2.5x）')
  process.exit(1)
}
console.log('soak 通过')
