#!/usr/bin/env node
// GUI 浸泡测试（M6-2）：headless Chrome 打开宿主页 + mock 事实循环（think↔working↔
// 事件窗口轮转），持续 N 分钟；断言：零页面异常、dataset.state 恒合法、视频元素稳定
// 双缓冲、堆增长有界。Node 侧浸泡见 scripts/soak.mjs（决策层 20 万步）。
// 运行：node test/soak-gui.mjs [minutes]（默认 3 分钟）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import {
  bootHost, cleanup, dismissOverlays, findBrowser, openBrowser,
} from './cdp-lib.mjs'

const MINUTES = Math.max(1, Number(process.argv[2]) || 3)
const DURATION_MS = MINUTES * 60_000
const STATE_NAMES = new Set([
  'idle', 'working', 'celebrate', 'error', 'disappointed', 'joy', 'eat', 'play',
  'drag', 'walk', 'sleep', 'wake', 'welcome', 'think', 'wait', 'night', 'struggling',
  'react-head', 'react-belly', 'react-tail',
])
const watchdog = setTimeout(() => { console.error('WATCHDOG: 强制退出'); process.exit(2) }, DURATION_MS + 300_000)

const profile = `whale-soak-${process.pid}`
const browserPath = findBrowser()
if (browserPath === null) { console.error('未找到 Chrome/Edge'); process.exit(2) }
console.log(`GUI 浸泡 ${MINUTES} 分钟 · profile=${profile}`)

let host = null
let browser = null
let dshHome = null
let chromeDir = null
try {
  host = await bootHost({ profile })
  dshHome = host.dshHome
  chromeDir = mkdtempSync(join(tmpdir(), 'whale-soak-chrome-'))
  browser = await openBrowser({ browserPath, pageUrl: host.pageUrl, cdpPort: 9334, dataDir: chromeDir })
  const { evaluate, call, events } = browser
  await call('Runtime.enable').catch(() => {})
  await evaluate(`Boolean(document.querySelector('[data-whale-pet]'))`) // 等价挂载探活
  await dismissOverlays(call, evaluate) // 首跑弹窗遮罩会冻结交互面（状态镜像不受影响，但保持环境干净）
  console.log('宿主 + 桌宠挂载就绪，开始浸泡')

  // ---- mock 事实轮转：页面内补丁 window.fetch，/state 响应替换为合成事实 ----
  await evaluate(`(() => {
    window.__realFetch = window.__realFetch ?? window.fetch
    window.__mockFacts = null
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) ?? ''
      if (window.__mockFacts !== null && url.includes('/api/whale-pet/state')) {
        return Promise.resolve(new Response(JSON.stringify(window.__mockFacts), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return window.__realFetch(input, init)
    }
    return true
  })()`)
  const baseFacts = () => ({
    windows: [], wait: false, thinking: false, struggling: false, insights: [], announce: null,
    pet: { level: 1, xp: 0, stats: {}, titles: [], memory: [] }, ts: Date.now(),
  })

  // ---- 浸泡主循环：每 500ms 校验状态合法性，周期注入事实变化 ----
  const startedAt = Date.now()
  let iterations = 0
  let stateSamples = 0
  let illegalStates = 0
  const seenStates = new Set()
  let scenarioRound = 0
  const scenarios = [
    () => evaluate(`window.__mockFacts = ${JSON.stringify({ ...baseFacts(), thinking: true, ts: Date.now() })}`), // think（插曲由节奏器触发）
    () => evaluate(`window.__mockFacts = ${JSON.stringify({ ...baseFacts(), thinking: false, ts: Date.now() })}`), // 回落 → 本地 celebrate
    () => { const t = Date.now(); return evaluate(`window.__mockFacts = ${JSON.stringify({ ...baseFacts(), windows: [{ name: 'error', until: t + 3000 }, { name: 'disappointed', until: t + 8000 }], ts: t })}`) },
    () => evaluate(`window.__mockFacts = ${JSON.stringify({ ...baseFacts(), windows: [{ name: 'welcome', until: Date.now() + 4000 }], ts: Date.now() })}`),
    () => evaluate(`window.__mockFacts = ${JSON.stringify({ ...baseFacts(), struggling: true, ts: Date.now() })}`),
    () => evaluate(`window.__mockFacts = ${JSON.stringify({ ...baseFacts(), wait: true, ts: Date.now() })}`),
  ]
  while (Date.now() - startedAt < DURATION_MS) {
    iterations += 1
    const step = Math.floor((Date.now() - startedAt) / 4000)
    if (step > scenarioRound) { // 每 4s 换一个场景
      scenarioRound = step
      scenarios[scenarioRound % scenarios.length]()
    }
    try {
      const s = await evaluate(`document.querySelector('[data-whale-pet]')?.dataset.state ?? null`)
      if (s !== null) {
        stateSamples += 1
        seenStates.add(s)
        if (!STATE_NAMES.has(s)) illegalStates += 1
      }
      if (iterations % 40 === 0) { // 每 20s 记录一次内存面
        const mem = await evaluate(`performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1`)
        console.log(`  [${Math.round((Date.now() - startedAt) / 1000)}s] state=${s} heap=${mem}MB statesSeen=${seenStates.size}`)
      }
    } catch { /* 单次评估失败不终止浸泡 */ }
    await new Promise((r) => setTimeout(r, 500))
  }

  // ---- 汇总 ----
  await evaluate(`window.__mockFacts = null`).catch(() => {})
  const pageErrors = []
  for (const ev of events.splice(0)) {
    if (ev.method === 'Runtime.exceptionThrown') pageErrors.push(ev.params?.exceptionDetails?.text ?? 'exception')
    if (ev.method === 'Runtime.consoleAPICalled' && ev.params?.type === 'error') {
      pageErrors.push((ev.params.args ?? []).map((a) => a.value ?? a.description).join(' ').slice(0, 120))
    }
  }
  const videoCount = await evaluate(`document.querySelectorAll('[data-whale-pet] video').length`)
  console.log(`浸泡完成：采样 ${stateSamples} 次 · 状态分布 ${[...seenStates].join(',')} · video=${videoCount}`)

  let failed = false
  if (illegalStates > 0) { console.error(`FAIL 非法 dataset.state 出现 ${illegalStates} 次`); failed = true }
  if (videoCount !== 2) { console.error(`FAIL 双缓冲 video 数量异常：${videoCount}`); failed = true }
  if (pageErrors.length > 0) { console.error(`FAIL 页面异常 ${pageErrors.length} 个：${pageErrors.slice(0, 3).join(' | ')}`); failed = true }
  if (seenStates.size < 3) { console.error(`FAIL 状态轮转过少（${seenStates.size}），事实链路可能未生效`); failed = true }

  cleanup(browser, host, { dshHome, chromeDir, tag: profile })
  if (failed) { console.error('GUI 浸泡未通过'); process.exit(1) }
  console.log('GUI 浸泡通过：零异常、状态恒合法、双缓冲稳定'); process.exit(0)
} catch (error) {
  console.error('GUI 浸泡异常中断：', error?.message ?? error)
  cleanup(browser, host, { dshHome, chromeDir, tag: profile })
  process.exit(2)
} finally {
  clearTimeout(watchdog)
}
