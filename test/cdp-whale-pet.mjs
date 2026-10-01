#!/usr/bin/env node
// GUI 复核批次（M1 六场景/M2 拖拽热区/M3 仪表板/M5 部分开关）——CDP 黑盒验收脚本。
// 模式：musume test/cdp-whale-moe.mjs；本脚本自管环境（隔离 profile + 隔离 DSH_HOME +
// headless Chrome），跑完即清理，不触碰用户真实 ~/.dsh 数据。
// 场景方法学：
// - 本地交互面（拖拽/热区/喂食/入睡/散步/醒觉）用真实输入（CDP Input 域合成鼠标事件）。
// - Node 事实面（welcome/think/working/celebrate/error/wait/struggling）用 CDP Fetch 域
//   拦截 /api/whale-pet/state 注入合成事实（mock 阶段）——Node 半侧事件接线已由 M1-6
//   探针 + 单测覆盖，此处验证 client 半侧「事实→决策→渲染→dataset.state」全链路。
// 运行：node test/cdp-whale-pet.mjs [--keep]（--keep 保留环境供人工排查）。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import {
  bootHost, cleanup, clickAt, dismissOverlays, findBrowser, openBrowser, petUnobstructed, postJson, waitFor,
} from './cdp-lib.mjs'

const KEEP = process.argv.includes('--keep')
const watchdog = setTimeout(() => { console.error('WATCHDOG: 10 分钟强制退出'); process.exit(2) }, 600_000)
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = `whale-gui-${process.pid}`
const browserPath = findBrowser()
if (browserPath === null) { console.error('未找到 Chrome/Edge'); process.exit(2) }
console.log(`GUI 复核 · profile=${profile} · browser=${browserPath}`)

let host = null
let browser = null
let dshHome = null
let chromeDir = null
try {
  // ---- 引导 ----
  host = await bootHost({ profile })
  dshHome = host.dshHome
  console.log(`宿主就绪：${host.base}`)
  const state0 = await (await fetch(host.base + '/api/whale-pet/state')).json()
  check('宿主路由 /state 可达', state0 && Array.isArray(state0.windows), JSON.stringify(state0).slice(0, 80))

  chromeDir = mkdtempSync(join(tmpdir(), 'whale-gui-chrome-'))
  browser = await openBrowser({ browserPath, pageUrl: host.pageUrl, cdpPort: 9333, dataDir: chromeDir })
  const { evaluate, call, events } = browser
  const state = () => evaluate(`document.querySelector('[data-whale-pet]')?.dataset.state ?? null`)
  const stateIs = (s) => state() === s
  const bubbleText = () => evaluate(`document.querySelector('.whale-pet-bubble')?.textContent ?? null`)

  // 页面可见性前置检查（headless 后台页会 document.hidden 冻结决策 tick——2026-09-30 实测）
  const visibility = await evaluate(`document.visibilityState`)
  check('页面可见（决策 tick 运行前提）', visibility === 'visible', `visibilityState=${visibility}`)

  // 收集页面异常/console.error
  const pageErrors = []
  const drainErrors = () => {
    for (const ev of events.splice(0)) {
      if (ev.method === 'Runtime.exceptionThrown') pageErrors.push(ev.params?.exceptionDetails?.text ?? 'exception')
      if (ev.method === 'Runtime.consoleAPICalled' && ev.params?.type === 'error') {
        pageErrors.push((ev.params.args ?? []).map((a) => a.value ?? a.description).join(' ').slice(0, 120))
      }
    }
  }

  // ---- 1) 挂载与素材链路（M1）----
  await waitFor(evaluate, `Boolean(document.querySelector('[data-whale-pet] .whale-pet-stage'))`, '桌宠挂载', 60_000) // 应用冷启动可能较慢
  check('overlay 挂载 [data-whale-pet]', true)
  await waitFor(evaluate, `(() => { const host = document.querySelector('[data-whale-pet]'); const img = host?.querySelector('img.whale-pet-media'); return !!img && img.complete && img.naturalWidth > 0 })()`, 'idle 素材加载', 10_000)
  const mountInfo = await evaluate(`(() => {
    const host = document.querySelector('[data-whale-pet]')
    const img = host?.querySelector('img.whale-pet-media')
    const videos = host?.querySelectorAll('video')
    return { state: host?.dataset.state ?? null, imgOk: !!img && img.complete && img.naturalWidth > 0, videoCount: videos?.length ?? 0 }
  })()`)
  check('初始状态合法', mountInfo.state !== null && mountInfo.state.length > 0, `state=${mountInfo.state}`)
  check('idle 素材 img naturalWidth>0', mountInfo.imgOk === true)
  check('双 <video> 缓冲就位', mountInfo.videoCount === 2, `videoCount=${mountInfo.videoCount}`)

  // ---- 1.5) 关闭首跑弹窗（内测声明等遮罩会吃掉合成点击；弹窗异步出现，轮询到无遮挡为止）----
  let unobstructed = { ok: false, reason: '未检测' }
  for (let i = 0; i < 20 && !unobstructed.ok; i += 1) {
    await dismissOverlays(call, evaluate, 3)
    unobstructed = await petUnobstructed(evaluate)
    if (!unobstructed.ok) await sleep(1000)
  }
  check('桌宠未被应用遮罩遮挡', unobstructed.ok === true, unobstructed.reason)
  // 等页面加载触发的真实 agent/created welcome 窗口（6s）过去——R3 事件窗口优先级
  // 高于热区反应（设计如此），不等待会把 react 瞬发（2.2s）整个吞掉。
  await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state !== 'welcome'`, 'welcome 窗口过去', 12_000).catch(() => {})

  // ---- 2) 路由与 Range 修复实证（M1/M6-fix）----
  const webmUrl = host.base + '/api/whale-pet/assets/classic/idle.webp'
  const full = await fetch(webmUrl)
  const size = Number(full.headers.get('content-length'))
  const r0 = await fetch(webmUrl, { headers: { range: 'bytes=0-' } })
  const r5 = await fetch(webmUrl, { headers: { range: 'bytes=5-' } })
  const rBad = await fetch(webmUrl, { headers: { range: 'bytes=999999-' } })
  const rSuffix = await fetch(webmUrl, { headers: { range: `bytes=-100` } })
  check('素材 200 全量', full.status === 200 && size > 0, `status=${full.status} size=${size}`)
  check('Range bytes=0- → 206 全长（修复实证：此前只回 1 字节）',
    r0.status === 206 && Number(r0.headers.get('content-length')) === size,
    `status=${r0.status} len=${r0.headers.get('content-length')} want=${size}`)
  check('Range bytes=5- → 206 从 5 起（此前误 416）',
    r5.status === 206 && String(r5.headers.get('content-range')).startsWith('bytes 5-'),
    `content-range=${r5.headers.get('content-range')}`)
  check('Range 越界 → 416', rBad.status === 416, `status=${rBad.status}`)
  check('Range 后缀 bytes=-100 → 206 末尾 100 字节',
    rSuffix.status === 206 && Number(rSuffix.headers.get('content-length')) === Math.min(100, size),
    `content-range=${rSuffix.headers.get('content-range')}`)
  const sse = await fetch(host.base + '/api/whale-pet/events', { headers: { accept: 'text/event-stream' } })
  check('SSE 端点 event-stream', sse.status === 200 && (sse.headers.get('content-type') ?? '').includes('text/event-stream'))
  try { await sse.body?.cancel() } catch {}

  // ---- 3) 分区热区（M2-2）：head/belly/tail → react-* ----
  // 应用的会话创建时机不固定，真实 welcome/celebrate 窗口（R3 优先级）可能恰好吃掉
  // 2.2s 的 react 瞬发——被窗口打断就等窗口退去后重试。
  let rect = await evaluate(`(() => { const r = document.querySelector('[data-whale-pet] .whale-pet-stage').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
  const at = (nx, ny) => ({ x: Math.round(rect.x + rect.w * nx), y: Math.round(rect.y + rect.h * ny) })
  // 事件计数器（诊断面：失败时区分「输入没到达」与「决策没生效」）
  await evaluate(`(() => {
    const stage = document.querySelector('[data-whale-pet] .whale-pet-stage')
    window.__evt = { down: 0, up: 0, dbl: 0 }
    stage.addEventListener('pointerdown', () => { window.__evt.down++ }, { capture: true })
    stage.addEventListener('pointerup', () => { window.__evt.up++ }, { capture: true })
    stage.addEventListener('dblclick', () => { window.__evt.dbl++ }, { capture: true })
    return true
  })()`)
  const diag = async (nx, ny) => {
    const p = at(nx, ny)
    return evaluate(`(() => {
      const el = document.elementFromPoint(${p.x}, ${p.y})
      return { evt: window.__evt, top: el ? el.tagName + '.' + String(el.className).slice(0, 30) : null,
        vis: document.visibilityState, state: document.querySelector('[data-whale-pet]')?.dataset.state }
    })()`)
  }
  const burstFree = () => waitFor(evaluate, `(() => {
    const s = document.querySelector('[data-whale-pet]')?.dataset.state
    return s !== 'welcome' && s !== 'celebrate' && s !== 'error' && s !== 'disappointed'
  })()`, '事件窗口退去', 15_000)
  // 弹窗可能在初始检查之后才异步弹出（内测声明等应用启动完成才渲染）——
  // 每个点击阶段前都重新保证「无遮挡」，检测到遮罩就重关弹窗。
  const ensureClickable = async (rounds = 15) => {
    for (let i = 0; i < rounds; i += 1) {
      const st = await petUnobstructed(evaluate)
      if (st.ok) return true
      await dismissOverlays(call, evaluate, 2)
      await sleep(800)
    }
    return false
  }
  const clickForState = async (wantState, nx, ny, attempts = 4) => {
    let lastDiag = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await ensureClickable()
      await burstFree()
      const p = at(nx, ny)
      await clickAt(call, p.x, p.y)
      const got = await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state === ${JSON.stringify(wantState)}`, wantState, 4000).then(() => true, () => false)
      if (got) return true
      lastDiag = await diag(nx, ny)
    }
    console.log(`   诊断 ${wantState}: ${JSON.stringify(lastDiag)}`)
    return false
  }
  for (const [zone, nx, ny] of [['head', 0.5, 0.2], ['belly', 0.5, 0.6], ['tail', 0.5, 0.9]]) {
    const got = await clickForState(`react-${zone}`, nx, ny)
    check(`热区 ${zone} → react-${zone}`, got)
    await sleep(2400) // 等 reactUntil 清除
  }

  // ---- 4) 拖拽（M2-1）：按住移动 → drag + 位移；松手 → 1.5s idle 缓冲 ----
  if (!await ensureClickable()) { check('拖拽前置：无遮挡', false, '弹窗无法关闭'); }
  const before = await evaluate(`document.querySelector('[data-whale-pet]').style.cssText`)
  const c0 = at(0.5, 0.5)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: c0.x, y: c0.y, button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse' })
  for (let i = 1; i <= 5; i += 1) {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c0.x - i * 20, y: c0.y - i * 12, button: 'left', buttons: 1, pointerType: 'mouse' })
    await sleep(80)
  }
  const dragState = await state()
  const during = await evaluate(`document.querySelector('[data-whale-pet]').style.cssText`)
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c0.x - 100, y: c0.y - 60, button: 'left', clickCount: 1, buttons: 0, pointerType: 'mouse' })
  check('拖拽进入 drag 状态', dragState === 'drag', `state=${dragState}`)
  // Chromium 会把 left/top/right/bottom 序列化成 inset 简写，两者都算位移生效
  check('拖拽位移生效（host.style 变化）', during !== before && /inset|left/.test(during), `before=${JSON.stringify(before)} during=${JSON.stringify(during)}`)
  await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state === 'idle'`, '放下缓冲回到 idle', 4000)
  check('松手 1.5s 放下缓冲 → idle', true)

  // ---- 5) 喂食与 30s 冷却（M2-3）：双击 = click1 + click2(clickCount=2) ----
  // 同样带 burst 重试；两次 CDP 双击都不触发时退化为页面内合成 dblclick（handler 面验证）。
  if (!await ensureClickable()) { check('喂食前置：无遮挡', false, '弹窗无法关闭'); }
  rect = await evaluate(`(() => { const r = document.querySelector('[data-whale-pet] .whale-pet-stage').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`) // 拖拽挪位后重算
  const pC = at(0.5, 0.5)
  let fed = false
  for (let attempt = 0; attempt < 3 && !fed; attempt += 1) {
    await burstFree()
    if (attempt < 2) {
      await clickAt(call, pC.x, pC.y, 1); await sleep(100)
      await clickAt(call, pC.x, pC.y, 2)
    } else {
      await evaluate(`(() => {
        const stage = document.querySelector('[data-whale-pet] .whale-pet-stage')
        stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: ${pC.x}, clientY: ${pC.y} }))
        return true
      })()`)
    }
    fed = await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state === 'eat'`, '双击喂食 eat', 4000).then(() => true, () => false)
  }
  check('双击喂食 → eat 瞬发', fed, JSON.stringify(await diag(0.5, 0.5)))
  await burstFree()
  await clickAt(call, pC.x, pC.y, 1); await sleep(100)
  await clickAt(call, pC.x, pC.y, 2)
  await evaluate(`(() => {
    const stage = document.querySelector('[data-whale-pet] .whale-pet-stage')
    stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: ${pC.x}, clientY: ${pC.y} }))
    return true
  })()`)
  const cooldownText = await waitFor(evaluate, `(() => { const t = document.querySelector('.whale-pet-bubble')?.textContent ?? ''; return t.includes('消化中') ? t : null })()`, '冷却提示气泡', 5000)
  check('30s 冷却内再喂 → 防刷提示', cooldownText.includes('消化中'), cooldownText)

  // ---- 6) announce 递送入口（M6-4 周报面）----
  const ann = await postJson(host.base + '/api/whale-pet/announce', { text: 'GUI 复核：announce 气泡链路', ms: 6000 })
  check('POST /announce 200', ann.status === 200)
  await waitFor(evaluate, `(() => { const t = document.querySelector('.whale-pet-bubble')?.textContent ?? ''; return t.includes('announce 气泡链路') ? t : null })()`, 'announce 气泡', 6000)
  check('announce → 桌宠气泡呈现', true)

  // ---- 7) 仪表板（M3-4）：window 事件开关 + SVG 柱状图 ----
  await evaluate(`window.dispatchEvent(new CustomEvent('whale-pet:dashboard-toggle'))`)
  await waitFor(evaluate, `Boolean(document.querySelector('.whale-pet-dash svg'))`, '仪表板面板', 6000)
  check('📊 仪表板打开 + 内联 SVG', true)
  await evaluate(`window.dispatchEvent(new CustomEvent('whale-pet:dashboard-toggle'))`)
  await waitFor(evaluate, `document.querySelector('.whale-pet-dash')?.style.display === 'none'`, '仪表板关闭', 6000)
  check('仪表板可关闭', true)

  // ---- 8) 空闲入睡（M1 六场景之 sleep）+ 途中散步 sightings（18-40s 随机间隔竞速）----
  console.log('… 等待空闲入睡（60s 无交互）与散步 sighting（约 70s）')
  const sightings = new Set()
  let sleepSeen = false
  for (let i = 0; i < 240 && !sleepSeen; i += 1) { // 最多 ~120s
    const s = await state()
    if (s !== null) sightings.add(s)
    if (s === 'sleep') sleepSeen = true
    else await sleep(500)
  }
  check('空闲 60s → sleep（M1 场景）', sleepSeen, `sightings=${[...sightings].join(',')}`)
  check('周期散步 sighting（walk 在入睡窗口内出现过）', sightings.has('walk'))
  const pW = at(0.5, 0.4)
  await clickAt(call, pW.x, pW.y)
  const woke = await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state !== 'sleep'`, '醒觉', 5000).then(() => true, () => false)
  check('交互醒觉（离开 sleep，M1 场景）', woke === true, `state=${await state()}`)

  // ---- 9) mock 事实阶段：Node 事实 → client 全链路（M1 六场景之 welcome/think/working/celebrate/error + wait/struggling）----
  // 页面内补丁 window.fetch：/state 响应替换为合成事实（client 3s 轮询应用）。
  // Node 半侧事件接线已由 M1-6 探针 + 单测覆盖，此处验证 client 侧「事实→决策→渲染」链路。
  console.log('… mock 事实阶段（页面内 fetch 补丁注入合成事实）')
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
  const setFacts = async (patch, label) => {
    const facts = {
      windows: [], wait: false, thinking: false, struggling: false, insights: [], announce: null,
      pet: { level: 1, xp: 0, stats: {}, titles: [], memory: [] },
      ...patch, ts: Date.now(),
    }
    await evaluate(`window.__mockFacts = ${JSON.stringify(facts)}`)
    if (label) console.log(`   mock → ${label}`)
  }
  const untilState = (want, timeout, label) => waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state === ${JSON.stringify(want)}`, label, timeout)

  await setFacts({ thinking: true }, 'thinking=true')
  await untilState('think', 8000, 'think 态')
  check('thinking 事实 → think（M1 场景）', true)
  const workingSeen = await untilState('working', 36_000, 'working 插曲').then(() => true, () => false)
  check('working 插曲触发（12-30s 节奏器——修复实证：此前永不触发）', workingSeen, workingSeen ? '' : `state=${await state()}`)
  await setFacts({ thinking: false }, 'thinking=false（回落边沿）')
  const celeabrateSeen = await untilState('celebrate', 6000, '本地 celebrate').then(() => true, () => false)
  check('thinking 回落边沿 → 本地 celebrate', celeabrateSeen, celeabrateSeen ? '' : `state=${await state()}`)

  const t0 = Date.now()
  await setFacts({ windows: [{ name: 'error', until: t0 + 3500 }, { name: 'disappointed', until: t0 + 9000 }] }, 'error→disappointed 窗口')
  await untilState('error', 6000, 'error 态')
  check('error 窗口 → error（M1 场景）', true)
  await untilState('disappointed', 8000, 'disappointed 态')
  check('error 4s 后转 disappointed（M1 场景）', true)

  await setFacts({ windows: [{ name: 'welcome', until: Date.now() + 5000 }] }, 'welcome 窗口')
  await untilState('welcome', 6000, 'welcome 态')
  check('welcome 窗口 → welcome（M1 场景）', true)

  await setFacts({ wait: true }, 'wait=true')
  await untilState('wait', 6000, 'wait 态')
  check('等待审批事实 → wait（M1 场景）', true)

  await setFacts({ struggling: true }, 'struggling=true')
  await untilState('struggling', 6000, 'struggling 态')
  check('遇挫事实 → struggling（M6-4）', true)
  await evaluate(`window.__mockFacts = null`) // 撤销 mock（保留补丁，页面即将关闭）

  // ---- 10) 页面错误汇总（M6-2 渲染健康面）----
  drainErrors()
  check('无页面异常/console.error', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

  // ---- 收尾 ----
  clearTimeout(watchdog)
  if (!KEEP) cleanup(browser, host, { dshHome, chromeDir, tag: profile })
  else console.log(`--keep：宿主 ${host.base} / profile ${profile} 保留待人工检查`)
  if (failures.length > 0) {
    console.error(`GUI 复核失败（${failures.length} 项）：${failures.join('；')}`)
    process.exit(1) // 显式退出：宿主孙进程持有的管道句柄会拖住事件循环（Windows 实测）
  }
  console.log('GUI 复核全部通过')
  process.exit(0)
} catch (error) {
  clearTimeout(watchdog)
  console.error('GUI 复核异常中断：', error?.message ?? error)
  if (!KEEP) cleanup(browser, host, { dshHome, chromeDir, tag: profile })
  process.exit(2)
}
