// CDP GUI 复核共享引导（test/cdp-whale-pet.mjs 与 test/soak-gui.mjs 共用）。
// 职责：隔离 DSH_HOME + 隔离 profile 启动 dsh web（携本插件）→ 启动 headless Chrome
// （CDP）→ 打开宿主页面 → 提供 CDP 调用/断言/输入派发/事实注 mock 帮手。
// 模式参照 musume test/cdp-whale-moe.mjs（原始 CDP over WebSocket，Node 22 内建 WebSocket）。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 找 Chrome/Edge 可执行文件（Windows 常见路径；找不到返回 null）。 */
export function findBrowser() {
  const candidates = process.platform === 'win32'
    ? [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge']
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** Windows 进程树击杀（与 scripts/compat.mjs 同款顺序：先 taskkill /T /F 再 kill）。 */
export function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true }) } catch {}
  }
  try { child.kill() } catch {}
}

/** 启动 dsh web（隔离 profile + 隔离 DSH_HOME），解析带 token 的页面 URL。 */
export async function bootHost({ profile, bootTimeoutMs = 120_000 }) {
  const dshHome = mkdtempSync(join(tmpdir(), 'whale-gui-home-'))
  const env = { ...process.env, DSH_HOME: dshHome }
  const run = (args, timeoutMs = 300_000) => new Promise((resolveRun) => {
    const child = spawn('dsh', args, { shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { killTree(child); resolveRun({ code: -1, out, err }) }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => { clearTimeout(timer); resolveRun({ code, out, err }) })
  })

  const init = await run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], 180_000)
  if (init.code !== 0) throw new Error(`profile 初始化失败：${(init.err || init.out).slice(0, 300)}`)
  const add = await run(['plugin', '--profile', profile, 'add', PACKAGE_ROOT])
  if (add.code !== 0) throw new Error(`plugin add 失败：${(add.err || add.out).slice(0, 400)}`)

  const child = spawn(
    'dsh', ['--profile', profile, '--no-open', '--port', '0'],
    { shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const deadline = Date.now() + bootTimeoutMs
  while (Date.now() < deadline) {
    await delay(1000)
    if (child.exitCode !== null) throw new Error(`dsh web 提前退出：${(out + err).slice(-400)}`)
    const m = out.match(/https?:\/\/[^\s"'<>]+/)
    if (m) {
      const pageUrl = m[0].replace(/[)\].,]+$/, '')
      const base = pageUrl.split('?')[0].replace(/\/+$/, '')
      try {
        const res = await fetch(base + '/api/whale-pet/state', { signal: AbortSignal.timeout(3000) })
        if (res.ok) return {
          base, pageUrl, dshHome,
          stop: () => { killTree(child) },
        }
      } catch { /* 继续等 */ }
    }
  }
  killTree(child)
  throw new Error(`dsh web 探活超时：${(out + err).slice(-400)}`)
}

/** 启动 headless Chrome（CDP）并打开页面；返回 { call, evaluate, close, CDP端口 }。 */
export async function openBrowser({ browserPath, pageUrl, cdpPort = 9333, dataDir }) {
  const child = spawn(browserPath, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${dataDir}`,
    '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,900',
    // headless 后台页节流/遮挡判定会冻结 250ms 决策 tick 与后台定时器（Windows 实测）
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', () => { /* Chromium 噪音忽略 */ })

  // 等 CDP 端点就绪
  let targets = null
  for (let i = 0; i < 40; i += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      break
    } catch { await delay(500) }
  }
  if (targets === null) { killTree(child); throw new Error('CDP 端点未就绪') }

  const created = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' })
  const target = created.ok ? await created.json() : targets[0]
  if (!created.ok) {
    // 老版本无 PUT /json/new：改用 /json/list 首个 page 并 Page.navigate
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    socket.addEventListener('open', res, { once: true })
    socket.addEventListener('error', rej, { once: true })
  })
  let id = 0
  const pending = new Map()
  const events = []
  socket.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    } else if (msg.method) {
      events.push(msg)
      if (events.length > 2000) events.splice(0, 1000)
    }
  })
  const call = (method, params = {}, { timeoutMs = 20_000 } = {}) => new Promise((res, rej) => {
    const callId = ++id
    const timer = setTimeout(() => {
      pending.delete(callId)
      rej(new Error(`CDP call timeout: ${method}`))
    }, timeoutMs)
    pending.set(callId, {
      resolve: (v) => { clearTimeout(timer); res(v) },
      reject: (e) => { clearTimeout(timer); rej(e) },
    })
    socket.send(JSON.stringify({ id: callId, method, params }))
  })
  if (!created.ok) await call('Page.navigate', { url: pageUrl }).catch(() => {})
  await call('Runtime.enable').catch(() => {})
  await call('Page.enable').catch(() => {})
  await call('Log.enable').catch(() => {})
  await call('Page.bringToFront').catch(() => {}) // headless 页面需前置，否则 document.hidden 冻结决策 tick

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result.value
  }
  return {
    call, evaluate, events,
    close: () => { try { socket.close() } catch {} killTree(child) },
  }
}

/** 轮询等待页面表达式为真（默认 10s）；返回最后一次的真值（供断言取文本等）。 */
export async function waitFor(evaluate, expression, label, timeout = 10_000) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    try {
      last = await evaluate(expression)
      if (last) return last
    } catch { /* 页面尚未就绪 */ }
    await delay(250)
  }
  throw new Error(`timeout waiting for ${label}（last=${JSON.stringify(last)}）`)
}

/** 派发一次真实鼠标点击（CDP Input 域 → 浏览器合成 pointer 事件）。
 *  双击须显式 clickCount=2，否则 Chromium 输入管线不合成 dblclick 事件。 */
export async function clickAt(call, x, y, clickCount = 1) {
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, pointerType: 'mouse' })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount, pointerType: 'mouse' })
}

/**
 * 关闭应用首跑弹窗/遮罩（内测声明等），否则遮罩吃掉后续一切合成点击。
 * 参照 musume cdp-whale-moe.mjs 的 DISMISS 模式；逐轮点击直到无可点弹窗，再 Escape 兜底。
 */
export async function dismissOverlays(call, evaluate, rounds = 6) {
  const LABELS = ['稍后配置', '保存并继续', '继续', '我知道了', '跳过', '开始使用', '关闭', '确定', 'Later', 'Skip', 'Close', 'OK']
  for (let i = 0; i < rounds; i += 1) {
    const clicked = await evaluate(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((n) => n.offsetParent !== null)
      for (const d of dialogs) {
        const btn = [...d.querySelectorAll('button')].find((b) => ${JSON.stringify(LABELS)}.includes((b.textContent || '').trim()))
        if (btn) { btn.click(); return (btn.textContent || '').trim() }
      }
      return null
    })()`).catch(() => null)
    if (clicked === null) break
    await new Promise((r) => setTimeout(r, 600))
  }
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 600))
}

/** 断言桌宠未被遮挡：宠物中心点 elementFromPoint 必须落在 [data-whale-pet] 内。 */
export async function petUnobstructed(evaluate) {
  return evaluate(`(() => {
    const stage = document.querySelector('[data-whale-pet] .whale-pet-stage')
    if (!stage) return { ok: false, reason: 'stage 未挂载' }
    const r = stage.getBoundingClientRect()
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return { ok: Boolean(el && el.closest('[data-whale-pet]')), reason: el ? el.tagName + '.' + el.className : 'null' }
  })()`)
}

/** POST JSON 小帮手（打宿主路由用）。 */
export const postJson = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** 收尾：杀浏览器 + 宿主（含按 tag 兜底清扫脱树孙进程）+ 删隔离目录。 */
export function cleanup(browser, host, { dshHome, chromeDir, tag } = {}) {
  try { browser?.close?.() } catch {}
  try { host?.stop?.() } catch {}
  if (tag && process.platform === 'win32') {
    // 兜底：按命令行特征清扫 shell:true 造成的脱树孙进程（同 scripts/compat.mjs）。
    try {
      spawn('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
        `Where-Object { $_.CommandLine -match '${tag}' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' })
    } catch {}
  }
  try { if (chromeDir) rmSync(chromeDir, { recursive: true, force: true }) } catch {}
  try { if (dshHome) rmSync(dshHome, { recursive: true, force: true }) } catch {}
}
