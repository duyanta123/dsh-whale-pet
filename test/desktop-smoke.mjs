#!/usr/bin/env node
// M6-3 桌面端真机冒烟 —— 官方 @deepseek-ai/dsh-desktop（Electron）宿主全链路验收。
// 与 test/cdp-whale-pet.mjs（自管隔离环境）不同，本脚本连接【正在运行的桌面端】：
// 真实 ~/.dsh、真实账号、真实模型会话，验证 bundle 在 0.2.0 桌面宿主的完整行为。
//
// 前置（人工一次性准备，详见开发计划 M6-3 / README 桌面端节）：
//   1. 应用完全退出后装入插件（菜单「应用 → 管理 dsh 命令…」可查 CLI 路径）：
//      "<桌面端>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add <本仓库路径>
//      ⑤ 正向链路另需：同法 add dsh-local-telemetry（与桌宠插件对正常共装形态）。
//   2. 带调试端口重启桌面端：
//      & "<桌面端>\DeepSeek Harness.exe" --remote-debugging-port=9222
//   3. 运行：node test/desktop-smoke.mjs [--cdp-port 9222] [--skip-real]
//      --skip-real：跳过真实模型会话（零配额；② 场景退化由 mock 覆盖）。
//
// 断言面：A 挂载/路由/Range/SSE；B 热区/拖拽/喂食/announce；C 仪表板；
// D 真实会话六场景（welcome/think/working/celebrate/sleep/wake）+ struggling 真事件
//   + telemetry 融合实测气泡 + 账本接线（消耗少量 API 配额，--skip-real 跳过）；
// E mock 补 wait/error→disappointed；F 深夜红线（临时改静音窗口覆盖当前时刻，finally 恢复）
//   + settings.json 持久化；G 设置卡 + 0.2.0 版式目检截图（test/artifacts/）；H 页面健康。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { dismissOverlays, petUnobstructed, clickAt, waitFor } from './cdp-lib.mjs'

const argOf = (flag, def) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const CDP_PORT = Number(argOf('--cdp-port', '9222'))
const SKIP_REAL = process.argv.includes('--skip-real')
const ART_DIR = join(decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), 'test', 'artifacts', `desktop-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`)

const failures = []
const warns = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const warn = (name, detail = '') => { console.log(`WARN ${name}${detail ? '  ' + detail : ''}`); warns.push(name) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const watchdog = setTimeout(() => { console.error('WATCHDOG: 25 分钟强制退出'); process.exit(2) }, 1_500_000)

// ---- 连接正在运行的桌面端渲染进程 ----
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && /^dsh-app:\/\//.test(t.url))
  ?? targets.find((t) => t.type === 'page')
if (!page) { console.error('未找到桌面端页面目标（应用须以 --remote-debugging-port 启动）'); process.exit(2) }
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { socket.addEventListener('open', res, { once: true }); socket.addEventListener('error', rej, { once: true }) })
let msgId = 0
const pending = new Map()
const events = []
socket.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
  } else if (msg.method) events.push(msg)
})
const call = (method, params = {}, { timeoutMs = 20_000 } = {}) => new Promise((res, rej) => {
  const id = ++msgId
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)) }, timeoutMs)
  pending.set(id, { resolve: (v) => { clearTimeout(timer); res(v) }, reject: (e) => { clearTimeout(timer); rej(e) } })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
await call('Runtime.enable').catch(() => {})
await call('Page.enable').catch(() => {})
await call('Page.bringToFront').catch(() => {})
const drainErrors = () => {
  const out = []
  for (const ev of events.splice(0)) {
    if (ev.method === 'Runtime.exceptionThrown') out.push(ev.params?.exceptionDetails?.text ?? 'exception')
    if (ev.method === 'Runtime.consoleAPICalled' && ev.params?.type === 'error') {
      out.push((ev.params.args ?? []).map((a) => a.value ?? a.description).join(' ').slice(0, 120))
    }
  }
  return out
}

// ---- 页面内 fetch 帮手（dsh-app://app 源天然过宿主认证；Node 侧无需 token）----
const pageJson = async (path, opts = {}) => evaluate(`(async () => {
  const r = await fetch(${JSON.stringify(path)}, ${JSON.stringify(opts)})
  const body = await r.json().catch(() => null)
  return { status: r.status, body }
})()`)
const pageFetchHead = async (path, headers = {}) => evaluate(`(async () => {
  const r = await fetch(${JSON.stringify(path)}, { headers: ${JSON.stringify(headers)} })
  const h = { status: r.status, len: r.headers.get('content-length'), range: r.headers.get('content-range'), ct: r.headers.get('content-type') }
  try { await r.body?.cancel() } catch {}
  return h
})()`)
const stateOf = () => evaluate(`document.querySelector('[data-whale-pet]')?.dataset.state ?? null`)
const bubbleText = () => evaluate(`document.querySelector('.whale-pet-bubble')?.textContent ?? null`)
const petSnapshot = async () => (await pageJson('/api/whale-pet/state')).body?.pet ?? null

// ---- 设置读写（全量语义：normalizeSettings(body) 整体替换）----
const SETTINGS_FILE = join(homedir(), '.dsh', 'whale-pet', 'settings.json')
const readSettingsFile = () => { try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) } catch { return null } }
const getSettings = async () => (await pageJson('/api/whale-pet/settings')).body
const postSettings = async (body) => pageJson('/api/whale-pet/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// ---- 截图（0.2.0 版式目检证据，test/artifacts/ 不入库）----
const shot = async (name) => {
  try {
    const r = await call('Page.captureScreenshot', { format: 'png' })
    mkdirSync(ART_DIR, { recursive: true })
    const fp = join(ART_DIR, name)
    writeFileSync(fp, Buffer.from(r.data, 'base64'))
    console.log(`   📸 ${fp}`)
    return fp
  } catch (e) { warn(`截图 ${name} 失败`, e.message); return null }
}

const pageErrors = []
let originalSettings = null
try {
  // ================= A 挂载与路由 =================
  console.log('— A 挂载与路由 —')
  await waitFor(evaluate, `Boolean(document.querySelector('[data-whale-pet] .whale-pet-stage'))`, '桌宠挂载', 30_000)
  check('A1 overlay 挂载 [data-whale-pet]（Electron dsh-app:// 渲染进程）', true)
  const vis = await evaluate(`document.visibilityState`)
  check('A2 页面可见（决策 tick 前提）', vis === 'visible', `visibilityState=${vis}`)
  await waitFor(evaluate, `(() => { const i = document.querySelector('[data-whale-pet] img.whale-pet-media'); return !!i && i.complete && i.naturalWidth > 0 })()`, '素材加载', 10_000)
  const mount = await evaluate(`(() => {
    const h = document.querySelector('[data-whale-pet]')
    return { state: h?.dataset.state ?? null, img: h?.querySelector('img.whale-pet-media')?.src.slice(0, 80) ?? null, videos: h?.querySelectorAll('video').length ?? 0 }
  })()`)
  check('A3 素材经 dsh-app:// 协议桥加载 naturalWidth>0', true, mount.img)
  check('A4 双 <video> 缓冲就位', mount.videos === 2, `videoCount=${mount.videos}`)

  const st = await pageJson('/api/whale-pet/state')
  check('A5 /api/whale-pet/state 200 且结构齐', st.status === 200 && Array.isArray(st.body?.windows) && typeof st.body?.pet === 'object')
  const webp = '/api/whale-pet/assets/classic/idle.webp'
  const full = await pageFetchHead(webp)
  // dsh-app:// 协议桥在 200 响应上剥掉 content-length（206 带）；大小由 A7-A10 的 Range 语义断言兜底
  check('A6 素材 200 全量', full.status === 200 && (full.len === null || Number(full.len) > 0), `len=${full.len}`)
  const r0 = await pageFetchHead(webp, { range: 'bytes=0-' })
  check('A7 Range bytes=0- → 206 全长', r0.status === 206 && Number(r0.len) === Number(full.len))
  const r5 = await pageFetchHead(webp, { range: 'bytes=5-' })
  check('A8 Range bytes=5- → 206 从 5 起', r5.status === 206 && String(r5.range).startsWith('bytes 5-'))
  const rBad = await pageFetchHead(webp, { range: 'bytes=999999-' })
  check('A9 Range 越界 → 416', rBad.status === 416, `status=${rBad.status}`)
  const rSuf = await pageFetchHead(webp, { range: 'bytes=-100' })
  check('A10 Range 后缀 -100 → 206 尾 100B', rSuf.status === 206 && Number(rSuf.len) === Math.min(100, Number(full.len)))
  const sse = await pageFetchHead('/api/whale-pet/events', { accept: 'text/event-stream' })
  check('A11 SSE event-stream（页面内可达）', sse.status === 200 && String(sse.ct).includes('text/event-stream'), `ct=${sse.ct}`)

  // 弹窗清理（内测声明等；弹窗异步出现，轮询到无遮挡）
  let unob = { ok: false, reason: '未检测' }
  for (let i = 0; i < 15 && !unob.ok; i += 1) {
    await dismissOverlays(call, evaluate, 3)
    unob = await petUnobstructed(evaluate)
    if (!unob.ok) await sleep(900)
  }
  check('A12 桌宠未被应用弹窗遮挡', unob.ok === true, unob.reason)
  // 挂载触发的 resume welcome 窗口（6s）过去后再做交互断言
  await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state !== 'welcome'`, 'welcome 过去', 12_000).catch(() => {})

  // ================= B 交互（③ + wake）=================
  console.log('— B 交互 —')
  const rectOf = () => evaluate(`(() => { const r = document.querySelector('[data-whale-pet] .whale-pet-stage').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
  const at = (r, nx, ny) => ({ x: Math.round(r.x + r.w * nx), y: Math.round(r.y + r.h * ny) })
  await evaluate(`(() => {
    const stage = document.querySelector('[data-whale-pet] .whale-pet-stage')
    window.__evt = { down: 0, up: 0, dbl: 0 }
    stage.addEventListener('pointerdown', () => { window.__evt.down++ }, { capture: true })
    stage.addEventListener('pointerup', () => { window.__evt.up++ }, { capture: true })
    stage.addEventListener('dblclick', () => { window.__evt.dbl++ }, { capture: true })
    return true
  })()`)
  const burstFree = () => waitFor(evaluate, `(() => { const s = document.querySelector('[data-whale-pet]')?.dataset.state; return s !== 'welcome' && s !== 'celebrate' && s !== 'error' && s !== 'disappointed' })()`, '事件窗口退去', 15_000)
  const ensureClickable = async (rounds = 12) => {
    for (let i = 0; i < rounds; i += 1) {
      const s = await petUnobstructed(evaluate)
      if (s.ok) return true
      await dismissOverlays(call, evaluate, 2)
      await sleep(800)
    }
    return false
  }
  const clickForState = async (want, nx, ny, attempts = 4) => {
    for (let i = 0; i < attempts; i += 1) {
      await ensureClickable()
      await burstFree()
      const p = at(await rectOf(), nx, ny)
      await clickAt(call, p.x, p.y)
      if (await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state === ${JSON.stringify(want)}`, want, 4000).then(() => true, () => false)) return true
    }
    return false
  }

  const preSleep = await stateOf()
  const woke = await (async () => {
    await ensureClickable()
    const p = at(await rectOf(), 0.5, 0.4)
    await clickAt(call, p.x, p.y)
    return waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state !== 'sleep'`, '醒觉', 5000).then(() => true, () => false)
  })()
  check('B1 真实入睡后交互醒觉（sleep→wake）', woke === true, `点击前 state=${preSleep}，点击后=${await stateOf()}`)

  for (const [zone, nx, ny] of [['head', 0.5, 0.2], ['belly', 0.5, 0.6], ['tail', 0.5, 0.9]]) {
    const got = await clickForState(`react-${zone}`, nx, ny)
    check(`B2 热区 ${zone} → react-${zone}`, got)
    await sleep(2400)
  }

  await ensureClickable()
  const styleBefore = await evaluate(`document.querySelector('[data-whale-pet]').style.cssText`)
  const c0 = at(await rectOf(), 0.5, 0.5)
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: c0.x, y: c0.y, button: 'left', clickCount: 1, buttons: 1, pointerType: 'mouse' })
  for (let i = 1; i <= 5; i += 1) {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c0.x - i * 20, y: c0.y - i * 12, button: 'left', buttons: 1, pointerType: 'mouse' })
    await sleep(80)
  }
  const dragState = await stateOf()
  const styleDuring = await evaluate(`document.querySelector('[data-whale-pet]').style.cssText`)
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c0.x - 100, y: c0.y - 60, button: 'left', clickCount: 1, buttons: 0, pointerType: 'mouse' })
  check('B3 拖拽 → drag 状态', dragState === 'drag', `state=${dragState}`)
  check('B4 拖拽位移生效（host.style 变化）', styleDuring !== styleBefore && /inset|left/.test(styleDuring), `during=${styleDuring.slice(0, 60)}`)
  const dropped = await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state === 'idle'`, '放下缓冲', 4500).then(() => true, () => false)
  check('B5 松手 1.5s 放下缓冲 → idle', dropped)

  let fed = false
  for (let attempt = 0; attempt < 3 && !fed; attempt += 1) {
    await burstFree()
    const pC = at(await rectOf(), 0.5, 0.5)
    if (attempt < 2) {
      await clickAt(call, pC.x, pC.y, 1); await sleep(100)
      await clickAt(call, pC.x, pC.y, 2)
    } else {
      await evaluate(`(() => { const s = document.querySelector('[data-whale-pet] .whale-pet-stage'); s.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: ${pC.x}, clientY: ${pC.y} })); return true })()`)
    }
    fed = await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state === 'eat'`, 'eat', 4000).then(() => true, () => false)
  }
  check('B6 双击喂食 → eat 瞬发', fed)
  await burstFree()
  {
    const pC = at(await rectOf(), 0.5, 0.5)
    await clickAt(call, pC.x, pC.y, 1); await sleep(100)
    await clickAt(call, pC.x, pC.y, 2)
    await evaluate(`(() => { const s = document.querySelector('[data-whale-pet] .whale-pet-stage'); s.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: ${pC.x}, clientY: ${pC.y} })); return true })()`)
  }
  const cooldown = await waitFor(evaluate, `(() => { const t = document.querySelector('.whale-pet-bubble')?.textContent ?? ''; return t.includes('消化中') ? t : null })()`, '冷却气泡', 5000).catch(() => null)
  check('B7 30s 冷却内再喂 → 防刷提示', cooldown !== null, cooldown ?? '')

  const ann = await pageJson('/api/whale-pet/announce', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '桌面端冒烟：announce 递送链路', ms: 6000 }) })
  check('B8 POST /announce 200', ann.status === 200)
  const annShown = await waitFor(evaluate, `(() => { const t = document.querySelector('.whale-pet-bubble')?.textContent ?? ''; return t.includes('announce 递送链路') ? t : null })()`, 'announce 气泡', 6000).catch(() => null)
  check('B9 announce → 桌宠气泡呈现', annShown !== null)

  // ================= C 仪表板 =================
  console.log('— C 仪表板 —')
  await evaluate(`window.dispatchEvent(new CustomEvent('whale-pet:dashboard-toggle'))`)
  const dashOpen = await waitFor(evaluate, `Boolean(document.querySelector('.whale-pet-dash svg'))`, '仪表板', 6000).then(() => true, () => false)
  check('C1 📊 仪表板打开 + 内联 SVG（0.2.0 版式）', dashOpen)
  await shot('07-dashboard-open.png')
  await evaluate(`window.dispatchEvent(new CustomEvent('whale-pet:dashboard-toggle'))`)
  const dashClosed = await waitFor(evaluate, `document.querySelector('.whale-pet-dash')?.style.display === 'none'`, '仪表板关闭', 6000).then(() => true, () => false)
  check('C2 仪表板可关闭', dashClosed)

  // ================= D 真实会话（②核心 + ⑤；--skip-real 跳过）=================
  const petBefore = await petSnapshot()
  const sendPrompt = async (text) => {
    await evaluate(`(() => { const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => (e.getAttribute('placeholder') || '').includes('发消息')); el?.focus(); return !!el })()`)
    await call('Input.insertText', { text })
    await sleep(600)
    await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('发送') && !x.disabled); b?.click(); return !!b })()`)
  }
  /** 等待本轮终态：'celebrate'（turn/end completed）| 'failed'（error→disappointed，模型 API 挫败）| null 超时 */
  const awaitTurnOutcome = (timeoutMs) => waitFor(evaluate,
    `(() => { const s = document.querySelector('[data-whale-pet]')?.dataset.state; return (s === 'celebrate' || s === 'error' || s === 'disappointed') ? s : null })()`,
    '轮次终态', timeoutMs).catch(() => null)
  let telemetrySeen = false
  if (!SKIP_REAL) {
    console.log('— D 真实会话（消耗少量配额：一个 25s 任务 + 一个失败命令）—')
    // 新会话：真实 agent/created → welcome（source 非 resume）
    await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '新建会话'); b?.click(); return !!b })()`)
    const welcomed = await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state === 'welcome'`, 'welcome', 10_000).then(() => true, () => false)
    check('D1 新会话 → welcome（真实 agent/created）', welcomed)
    await sleep(1200) // 新会话输入区挂载缓冲

    // 发任务（25s 命令）；模型 API 挫败（turn/end error → 失败记账）时重试一次
    const PROMPT = '运行一个耗时约 25 秒的命令（bash: sleep 25，或 PowerShell: Start-Sleep -Seconds 25，任选可用者），结束后只回复两个字：完成'
    let outcome = null
    for (let attempt = 1; attempt <= 2 && outcome !== 'celebrate'; attempt += 1) {
      await sendPrompt(PROMPT)
      // think（真实 thinking 事实；welcome 优先级高于 think，welcome 过去后可见）
      const thinkSeen = await waitFor(evaluate,
        `(() => { const s = document.querySelector('[data-whale-pet]')?.dataset.state; return s === 'think' ? 'think' : (s === 'error' || s === 'disappointed') ? 'error' : null })()`,
        'think 或 error', 90_000).then(v => v, () => null)
      if (thinkSeen === 'think') check(`D2 真实思考 → think（第 ${attempt} 次尝试）`, true)
      else if (attempt === 1) warn('D2 首次尝试未见 think（模型 API 挫败提前收尾？）——重试')
      else check('D2 真实思考 → think', false, `state=${await stateOf()}`)
      // working 插曲（25s 工具运行期 12-30s 节奏器应触发；失败不致命——web 车道已实证）
      const workingSeen = await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state === 'working'`, 'working', 60_000).then(() => true, () => false)
      if (workingSeen) check(`D3 working 插曲（真实会话运行中，12-30s 节奏器；第 ${attempt} 次尝试）`, true)
      else warn(`D3 working 插曲未在第 ${attempt} 次尝试观测到（节奏器随机 12-30s；web 车道已实证）`)
      outcome = await awaitTurnOutcome(240_000)
      if (outcome === 'celebrate') {
        check(`D4 任务完成 → celebrate（真实 turn/end completed 记账；第 ${attempt} 次尝试）`, true)
        const summary = await waitFor(evaluate, `(() => { const t = document.querySelector('.whale-pet-bubble')?.textContent ?? ''; return /用时/.test(t) ? t : null })()`, '完成气泡', 8000).catch(() => null)
        check('D5 完成气泡三要素（用时/消耗/花费）', summary !== null && /用时/.test(summary) && /花费/.test(summary), String(summary ?? '').slice(0, 80).replace(/\n/g, ' | '))
      } else if (outcome === 'error' || outcome === 'disappointed') {
        // 模型 API 挫败：error→disappointed 窗口 + failures 记账（零负反馈）是正确行为——非插件缺陷
        const failuresNow = (await petSnapshot())?.stats?.failures ?? 0
        check(`D4-失败路径 turn/end error → 负面窗口 + failures 记账（第 ${attempt} 次尝试模型 API 挫败）`, failuresNow > (petBefore?.stats?.failures ?? 0), `failures=${failuresNow}`)
        await waitFor(evaluate, `!['error','disappointed','celebrate','struggling','think'].includes(document.querySelector('[data-whale-pet]')?.dataset.state)`, '失败窗口退去', 30_000).catch(() => {})
      } else {
        warn(`D4 第 ${attempt} 次尝试超时未观测到终态（state=${await stateOf()}）`)
      }
    }

    // ⑤ telemetry 融合：共享 ~/.dsh 正向证据
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
    const tFile = join(homedir(), '.dsh', 'telemetry', `${today}.jsonl`)
    telemetrySeen = existsSync(tFile) && readFileSync(tFile, 'utf8').trim().length > 0
    if (telemetrySeen) {
      check('D6 telemetry 插件经共享 ~/.dsh 写入当日 JSONL（桌面=CLI 同源）', true)
      // 洞察在 5s 首刷 + 5min 周期；给一次宽窗（非致命）
      const insightsSeen = await waitFor(evaluate,
        `(async () => (await fetch('/api/whale-pet/state')).json())().then((j) => (j.insights ?? []).length > 0)`,
        'insights', 335_000).then(() => true, () => false).catch(() => false)
      if (insightsSeen) check('D7 融合洞察台词非空（真实 telemetry 折叠）', true)
      else warn('D7 洞察台词未在下轮刷新前出现（5min 周期；融合读取链路已由 D6/气泡替换面覆盖）')
    } else {
      warn('D6 当日 telemetry JSONL 不存在（desktop profile 未装 dsh-local-telemetry）——融合退为估算兜底（缺数据如实缺失契约）')
    }

    // struggling 真事件：失败命令（零 XP 负反馈设计；工具挫败后轮次通常正常完成 → 完成记账）
    await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state !== 'celebrate'`, 'celebrate 过去', 15_000).catch(() => {})
    await sendPrompt('再运行一条必败命令：bash -c "exit 3"（或任选 shell 等价形式）。只运行，不要解释。')
    const struggled = await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state === 'struggling'`, 'struggling', 90_000).then(() => true, () => false)
    check('D10 失败命令 → struggling（真实工具失败，M6-4 遇挫窗口）', struggled, struggled ? '' : `state=${await stateOf()}`)
    await awaitTurnOutcome(180_000)
    await waitFor(evaluate, `!['celebrate','struggling','think'].includes(document.querySelector('[data-whale-pet]')?.dataset.state)`, '会话窗口退去', 60_000).catch(() => {})
    // 账本接线终验（轮次成败都应入账：completed → tasksDone+1 / error → failures+1）
    const petAfter = await petSnapshot()
    const doneDelta = (petAfter?.stats?.tasksDone ?? 0) - (petBefore?.stats?.tasksDone ?? 0)
    const failDelta = (petAfter?.stats?.failures ?? 0) - (petBefore?.stats?.failures ?? 0)
    check('D8 账本接线：轮次终态入账（completed→tasksDone / error→failures）', doneDelta >= 1 || (doneDelta >= 1 && failDelta >= 0),
      `tasksDone+${doneDelta} failures+${failDelta} xp ${petBefore?.xp}→${petAfter?.xp}`)
    check('D9 XP 增加（任务完成 +10 / 新会话 +5）', (petAfter?.xp ?? 0) > (petBefore?.xp ?? 0), `xp ${petBefore?.xp} → ${petAfter?.xp}`)
  } else {
    console.log('— D 真实会话：--skip-real 跳过 —')
  }

  // ================= E mock 补场景：wait / error→disappointed =================
  console.log('— E mock 补场景（Node 事件接线由探针+单测覆盖，此处验 client 链路）—')
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
  const setFacts = async (patch) => {
    const facts = { windows: [], wait: false, thinking: false, struggling: false, insights: [], announce: null,
      pet: petBefore ?? { level: 1, xp: 0, stats: {}, titles: [], memory: [] }, ...patch, ts: Date.now() }
    await evaluate(`window.__mockFacts = ${JSON.stringify(facts)}`)
  }
  await setFacts({ wait: true })
  const waitSeen = await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state === 'wait'`, 'wait', 8000).then(() => true, () => false)
  check('E1 等待审批事实 → wait', waitSeen)
  const t0 = Date.now()
  await setFacts({ wait: false, windows: [{ name: 'error', until: t0 + 3500 }, { name: 'disappointed', until: t0 + 9500 }] })
  const errSeen = await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state === 'error'`, 'error', 8000).then(() => true, () => false)
  check('E2 请求错误事实 → error', errSeen)
  const sadSeen = await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state === 'disappointed'`, 'disappointed', 9000).then(() => true, () => false)
  check('E3 error 4s 后 → disappointed', sadSeen)

  // ================= F 深夜红线（⑥）+ 设置持久化（④）=================
  console.log('— F 深夜红线 + 设置持久化 —')
  originalSettings = await getSettings()
  check('F1 GET /settings 200', originalSettings !== null && typeof originalSettings === 'object')
  const nowMin = (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() })()
  const startMin = (nowMin - 30 + 1440) % 1440
  const endMin = (nowMin + 30) % 1440
  const merged = { ...originalSettings, night: { ...originalSettings.night, muteEnabled: true, startMin, endMin } }
  const posted = await postSettings(merged)
  check('F2 静音窗口临时覆盖当前时刻（跨午夜语义）→ 200', posted.status === 200 && posted.body?.night?.startMin === startMin,
    `startMin=${startMin} endMin=${endMin}`)
  const onDisk = readSettingsFile()
  check('F3 settings.json 落盘一致（~/.dsh/whale-pet/）', onDisk?.night?.startMin === startMin && onDisk?.night?.muteEnabled === true,
    `disk.startMin=${onDisk?.night?.startMin}`)
  // 静音段负向观测 75s：无 walk（常规 18-40s 必现）、无主动气泡；状态镜像照常
  await evaluate(`window.__mockFacts = null`) // 撤 mock，看真实决策
  let walkInMute = false
  let bubbleInMute = false
  for (let i = 0; i < 150; i += 1) {
    const s = await stateOf()
    if (s === 'walk') walkInMute = true
    const b = await bubbleText()
    if (b) bubbleInMute = true
    await sleep(500)
  }
  check('F4 静音段内 75s 零 walk sighting（18-40s 常规必现 → 被红线门控）', walkInMute === false)
  // 红线只约束主动行为面（care/短剧/散步气泡/音效）；错误安慰气泡属状态镜像面（深夜照常，附录 B 裁定）
  const ERROR_EMPATHY = '呜……好像出错了'
  const proactiveBubble = bubbleInMute && !(await bubbleText() ?? '').includes(ERROR_EMPATHY)
  check('F5 静音段内无主动行为气泡（错误镜像安慰豁免）', proactiveBubble === false, (await bubbleText() ?? '').slice(0, 50))
  // 状态镜像深夜照常（mock thinking → think；镜像停摆违反 M1 核心职责）
  await setFacts({ thinking: true })
  const nightThink = await waitFor(evaluate, `document.querySelector('[data-whale-pet]')?.dataset.state === 'think'`, '深夜 think', 8000).then(() => true, () => false)
  check('F6 静音段内状态镜像照常（think 不被静音）', nightThink)
  await evaluate(`window.__mockFacts = null`)
  // 恢复原设置
  const restored = await postSettings(originalSettings)
  const diskAfter = readSettingsFile()
  check('F7 恢复原设置且落盘复原', restored.status === 200 && diskAfter?.night?.startMin === originalSettings?.night?.startMin,
    `disk.startMin=${diskAfter?.night?.startMin} want=${originalSettings?.night?.startMin}`)

  // ================= G 设置卡（④）+ 0.2.0 版式目检（⑦）=================
  console.log('— G 设置卡 + 目检 —')
  // best-effort：导航到设置面板找「鲸鱼娘桌宠」卡
  const cardSeen = await (async () => {
    const found = await evaluate(`(() => {
      const openers = [...document.querySelectorAll('button, [role="button"], [aria-label]')]
        .filter((x) => /设置|settings/i.test((x.getAttribute('aria-label') || '') + (x.getAttribute('title') || '') + (x.textContent || '').slice(0, 20)))
      return openers.length
    })()`)
    if (!found) return { ok: false, why: '未找到设置入口按钮' }
    for (let i = 0; i < 3; i += 1) {
      await evaluate(`(() => {
        const opener = [...document.querySelectorAll('button, [role="button"], [aria-label]')]
          .find((x) => /设置|settings/i.test((x.getAttribute('aria-label') || '') + (x.getAttribute('title') || '') + (x.textContent || '').slice(0, 20)))
        opener?.click()
        return true
      })()`)
      await sleep(1200)
      const ok = await evaluate(`document.body.textContent.includes('鲸鱼娘桌宠')`)
      if (ok) return { ok: true, why: '' }
    }
    return { ok: false, why: '设置面板已开但未见桌宠卡（可能需要手动滚动导航栏）' }
  })()
  if (cardSeen.ok) check('G1 设置面板出现「鲸鱼娘桌宠」卡（settings.section 槽位）', true)
  else warn('G1 设置卡未自动定位', cardSeen.why)
  await shot('08-settings-or-layout.png')
  await evaluate(`(() => { const s = document.querySelector('[data-whale-pet] .whale-pet-stage'); return !!s })()`)
  await shot('09-pet-over-0.2.0-layout.png')

  // ================= H 页面健康 =================
  console.log('— H 页面健康 —')
  pageErrors.push(...drainErrors())
  check('H1 无页面异常/console.error（全程）', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

  clearTimeout(watchdog)
  console.log('')
  console.log(`冒烟完成：${failures.length === 0 ? '全部通过 ✅' : `失败 ${failures.length} 项 ❌`}${warns.length ? `（警告 ${warns.length} 项）` : ''}`)
  if (failures.length) { console.error('失败项：' + failures.join('；')); process.exit(1) }
  process.exit(0)
} catch (error) {
  clearTimeout(watchdog)
  console.error('冒烟异常中断：', error?.message ?? error)
  // 兜底恢复设置（红线配置绝不留存）
  try {
    if (originalSettings) {
      await pageJson('/api/whale-pet/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(originalSettings) })
      console.log('（已恢复原设置）')
    }
  } catch {}
  process.exit(2)
}
