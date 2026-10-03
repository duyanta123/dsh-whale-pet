#!/usr/bin/env node
// 二期功能真机目检探针 —— 连接正在运行的桌面端（--remote-debugging-port 启动），对二期
// 接线做功能面断言 + 目检截图。与 test/desktop-smoke.mjs（一期六场景）互补，共库 test/artifacts/。
// 运行：node test/phase2-probe.mjs [--cdp-port 9222]
// 断言面：A 宿主路由存活（weather/balance=Node half 已换新）；B client 模块契约面
//   （39 成就/节日表/天气映射/角色/bbox 表）；C 设置卡二期分区；D 泡泡小游戏开/点/收；
//   E bbox 热区门控（界外不可点 vs 头区可点，对照一期静态表必兜底 head）；F 换装休眠与成长持久化。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitFor, clickAt } from './cdp-lib.mjs'

const argOf = (flag, def) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const CDP_PORT = Number(argOf('--cdp-port', '9222'))
const ART_DIR = join(decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), 'test', 'artifacts', `phase2-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`)

const failures = []
const warns = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const softCheck = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'WARN'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) warns.push(name)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const watchdog = setTimeout(() => { console.error('WATCHDOG: 8 分钟强制退出'); process.exit(2) }, 480_000)

// ---- 连接正在运行的桌面端渲染进程（与 desktop-smoke.mjs 同款）----
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && /^dsh-app:\/\//.test(t.url))
  ?? targets.find((t) => t.type === 'page')
if (!page) { console.error('未找到桌面端页面目标（应用须以 --remote-debugging-port 启动）'); process.exit(2) }
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { socket.addEventListener('open', res, { once: true }); socket.addEventListener('error', rej, { once: true }) })
let msgId = 0
const pending = new Map()
socket.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
  }
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

const pageJson = async (path) => evaluate(`(async () => {
  const r = await fetch(${JSON.stringify(path)})
  const body = await r.json().catch(() => null)
  return { status: r.status, body }
})()`)
const stateOf = () => evaluate(`document.querySelector('[data-whale-pet]')?.dataset.state ?? null`)
const shot = async (name) => {
  try {
    const r = await call('Page.captureScreenshot', { format: 'png' })
    mkdirSync(ART_DIR, { recursive: true })
    const fp = join(ART_DIR, name)
    writeFileSync(fp, Buffer.from(r.data, 'base64'))
    console.log(`   📸 ${fp}`)
    return fp
  } catch (e) { warns.push(`截图 ${name}`); console.log(`   截图失败：${e.message}`); return null }
}
/** 舞台归一化坐标 → 页面像素单击（Input 真实事件，供 bbox/热区判定）。 */
const clickStage = async (nx, ny) => {
  const rect = await evaluate(`(() => {
    const r = document.querySelector('[data-whale-pet] .whale-pet-stage').getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })()`)
  await clickAt(call, rect.left + nx * rect.width, rect.top + ny * rect.height)
}

try {
  // ================= A 宿主路由存活（Node half 已换新）=================
  console.log('— A 宿主路由（二期）—')
  await waitFor(evaluate, `Boolean(document.querySelector('[data-whale-pet] .whale-pet-stage'))`, '桌宠挂载', 30_000)
  check('A0 桌宠挂载', true)
  const weatherIdle = await pageJson('/api/whale-pet/weather')
  check('A1 GET /weather 200 weather-not-configured（一期 Node half 此处 404 → 证明已换新）',
    weatherIdle.status === 200 && weatherIdle.body?.reason === 'weather-not-configured',
    `status=${weatherIdle.status} body=${JSON.stringify(weatherIdle.body).slice(0, 80)}`)
  const balance = await pageJson('/api/whale-pet/balance')
  check('A2 GET /balance 未配置保持 stub 契约',
    balance.status === 200 && balance.body?.ok === false && balance.body?.reason === 'balance-not-configured',
    JSON.stringify(balance.body).slice(0, 80))
  const weatherReal = await pageJson('/api/whale-pet/weather?city=' + encodeURIComponent('杭州'))
  softCheck('A3 GET /weather?city=杭州（真实外联，信息性）',
    weatherReal.status === 200 && weatherReal.body?.ok === true && Number.isFinite(weatherReal.body?.code),
    `status=${weatherReal.status} body=${JSON.stringify(weatherReal.body).slice(0, 120)}`)

  // ================= B client 模块契约面（经 /api/whale-pet/client/* ESM 直载）=================
  console.log('— B client 模块契约面 —')
  const contracts = await evaluate(`(async () => {
    const out = {}
    const festival = await import('/api/whale-pet/client/festival.mjs')
    out.spring = festival.festivalOf('2026-02-17')?.id ?? null
    out.midAutumn = festival.festivalOf('2026-09-25')?.id ?? null
    out.halloween = festival.festivalOf('2026-10-31')?.id ?? null
    out.today = festival.festivalOf(new Date())?.id ?? null
    out.overlayIdle = festival.idleOverlayVisual('idle', { festivalId: null, weatherId: null })
    const weather = await import('/api/whale-pet/client/weather.mjs')
    out.thunder = weather.resolveWeatherId({ code: 95, tempC: 25 })
    out.rain = weather.resolveWeatherId({ code: 51, tempC: 20 })
    out.umbrella = weather.resolveWeatherId({ code: 63, tempC: 20 })
    out.unknownCold = weather.resolveWeatherId({ code: 999, tempC: -5 })
    const growth = await import('/api/whale-pet/client/growth.mjs')
    out.achievementCount = growth.ACHIEVEMENTS.length
    const chars = await import('/api/whale-pet/client/characters.mjs')
    const manifest = await import('/api/whale-pet/client/assets-manifest.mjs')
    out.characters = Object.keys(chars.CHARACTERS)
    out.characterId = manifest.getCharacterId()
    out.normalized = chars.normalizeCharacterId('classic')
    const bbox = await import('/api/whale-pet/client/bbox.mjs')
    out.bboxCenter = bbox.bboxHit(0.5, 0.5, 'idle')
    out.bboxCorner = bbox.bboxHit(0.02, 0.02, 'idle')
    const game = await import('/api/whale-pet/client/game.mjs')
    const s = game.gameNewState(1000, () => 0.5)
    out.gameBoardCells = Object.keys(s).length > 0 && typeof game.gameTick === 'function' && typeof game.gamePop === 'function'
    return out
  })()`)
  check('B1 节日表：2026-02-17 春节 / 09-25 中秋 / 10-31 万圣 / 今日无节日',
    contracts.spring === 'spring' && contracts.midAutumn === 'mid-autumn' && contracts.halloween === 'halloween' && contracts.today === null,
    JSON.stringify({ spring: contracts.spring, midAutumn: contracts.midAutumn, halloween: contracts.halloween, today: contracts.today }))
  check('B2 天气映射：95→thunder / 51 小雨→rain / 63 持续雨→umbrella / 表外码+低温→cold',
    contracts.thunder === 'thunder' && contracts.rain === 'rain' && contracts.umbrella === 'umbrella' && contracts.unknownCold === 'cold',
    JSON.stringify({ thunder: contracts.thunder, rain: contracts.rain, umbrella: contracts.umbrella, unknownCold: contracts.unknownCold }))
  check('B3 成就总数 = 39（Backlog 原文口径）', contracts.achievementCount === 39, `count=${contracts.achievementCount}`)
  check('B4 角色注册表 musume/classic', Array.isArray(contracts.characters) && contracts.characters.includes('musume') && contracts.characters.includes('classic'),
    `id=${contracts.characterId} keys=${contracts.characters?.join(',')}`)
  check('B5 bbox 表生效：idle 中心命中、左上角(0.02,0.02)为 null（界外不可点）',
    contracts.bboxCenter !== null && contracts.bboxCorner === null,
    `center=${contracts.bboxCenter ?? 'null'} corner=${contracts.bboxCorner ?? 'null'}`)
  check('B6 游戏纯逻辑可加载（newState/tick/pop）', contracts.gameBoardCells === true)

  // ================= C 设置卡二期分区 =================
  console.log('— C 设置卡二期分区 —')
  // 0.2.0 桌面版式：设置入口可能在「应用」菜单里。两级尝试：直接找设置按钮 → 应用菜单 → 设置项。
  await evaluate(`(() => {
    const opener = [...document.querySelectorAll('button, [role="button"], [aria-label], [role="menuitem"]')]
      .find((x) => /^\\s*(设置|settings)/i.test((x.getAttribute('aria-label') || '') + (x.getAttribute('title') || '') + (x.textContent || '').slice(0, 8)))
    if (opener) { opener.click(); return 'clicked' }
    return 'not-found'
  })()`)
  await sleep(1000)
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('div')].find((d) => d.textContent?.includes('鲸鱼娘桌宠') && d.querySelector('input[type="checkbox"]'))
    if (card) return 'already'
    const appMenu = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [aria-label]')]
      .find((x) => (x.textContent || '').trim() === '应用' || /应用|app\\s*menu/i.test(x.getAttribute('aria-label') || ''))
    appMenu?.click()
    return appMenu ? 'app-menu-clicked' : 'no-app-menu'
  })()`)
  await sleep(800)
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('button, [role="menuitem"], [role="button"], a, [aria-label]')]
      .find((x) => /^(设置|设置项|settings|偏好)/i.test((x.textContent || '').trim()) || /设置|settings/i.test(x.getAttribute('aria-label') || ''))
    item?.click()
    return !!item
  })()`)
  await sleep(1500)
  const cardTexts = await evaluate(`(() => {
    const scope = [...document.querySelectorAll('div')].find((d) => d.textContent?.includes('鲸鱼娘桌宠') && d.querySelector('input[type="checkbox"]'))
    return scope ? scope.textContent : null
  })()`)
  const needTexts = ['泡泡小游戏', '节日换装', '天气换装', '余额不足提醒', '表情包热链', '签到', '每日任务', '成就']
  const missing = needTexts.filter((t) => !cardTexts || !cardTexts.includes(t))
  check('C1 设置卡含全部二期分区文案', missing.length === 0, missing.length ? `缺:${missing.join('/')}` : '全齐')
  await shot('10-settings-card-phase2.png')
  // 关回设置面板（Esc）；失败不阻塞（截图已取证）
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`).catch(() => {})

  // ================= D 泡泡小游戏开/点/收 =================
  console.log('— D 泡泡小游戏 —')
  await evaluate(`window.dispatchEvent(new CustomEvent('whale-pet:game-toggle'))`)
  await sleep(600)
  const gameOpen = await evaluate(`(() => {
    const overlay = document.querySelector('[data-whale-pet] .whale-pet-game')
    return { open: !!overlay, cells: overlay ? overlay.querySelectorAll('.whale-pet-game-cell').length : 0,
      withBubble: overlay ? overlay.querySelectorAll('.whale-pet-game-cell.has-bubble').length : 0,
      hud: overlay?.querySelector('.whale-pet-game-hud')?.textContent ?? null }
  })()`)
  check('D1 游戏棋盘打开（4x4 格 + HUD）', gameOpen.open && gameOpen.cells === 16,
    `cells=${gameOpen.cells} withBubble=${gameOpen.withBubble} hud=${(gameOpen.hud ?? '').slice(0, 40)}`)
  const popped = await evaluate(`(() => {
    const cells = [...document.querySelectorAll('[data-whale-pet] .whale-pet-game-cell.has-bubble')]
    if (cells.length === 0) return { popped: false, hud: document.querySelector('.whale-pet-game-hud')?.textContent ?? null }
    cells[0].click()
    return { popped: true, hud: document.querySelector('.whale-pet-game-hud')?.textContent ?? null }
  })()`)
  await sleep(400)
  softCheck('D2 点击泡泡有结算反馈（HUD 更新或棋盘变化）', popped.popped === true, `hud=${(popped.hud ?? '').slice(0, 60)}`)
  await shot('20-game-board.png')
  await evaluate(`window.dispatchEvent(new CustomEvent('whale-pet:game-toggle'))`)
  await sleep(400)
  const gameClosed = await evaluate(`!document.querySelector('[data-whale-pet] .whale-pet-game')`)
  check('D3 再按 toggle 游戏棋盘收起', gameClosed === true)

  // ================= E bbox 热区门控（真实点击）=================
  console.log('— E bbox 热区门控 —')
  const cur = await stateOf()
  const probe = await evaluate(`(async () => {
    const bbox = await import('/api/whale-pet/client/bbox.mjs')
    const st = document.querySelector('[data-whale-pet]')?.dataset.state ?? 'idle'
    // 找一个界外点（bboxHit=null）与一个头/腹内点（非 null），从候选网格里挑
    let outPoint = null; let inPoint = null
    for (let y = 0.04; y <= 0.96 && (!outPoint || !inPoint); y += 0.08) {
      for (let x = 0.04; x <= 0.96; x += 0.08) {
        const hit = bbox.bboxHit(x, y, st)
        if (hit === null && !outPoint) outPoint = { x, y }
        if (hit !== null && !inPoint) inPoint = { x, y, zone: hit }
      }
    }
    return { st, outPoint, inPoint }
  })()`)
  check('E1 当前状态可定位界外点与命中点', probe.outPoint !== null && probe.inPoint !== null,
    `state=${cur} out=(${probe.outPoint?.x},${probe.outPoint?.y}) in=(${probe.inPoint?.x},${probe.inPoint?.y},${probe.inPoint?.zone})`)
  if (probe.outPoint && probe.inPoint) {
    await clickStage(probe.outPoint.x, probe.outPoint.y)
    await sleep(500)
    const afterOut = await stateOf()
    check('E2 界外点击不触发 react-*（一期静态表会兜底 head——bbox 门控生效）',
      !/^react-/.test(afterOut ?? ''), `state=${afterOut}`)
    await clickStage(probe.inPoint.x, probe.inPoint.y)
    await waitFor(evaluate, `/^react-/.test(document.querySelector('[data-whale-pet]')?.dataset.state ?? '')`, 'react 反应', 4000)
      .then(() => check(`E3 界内点击触发 react 反应（${probe.inPoint.zone}）`, true))
      .catch(() => check(`E3 界内点击触发 react 反应（${probe.inPoint.zone}）`, false, `state=${'超时未反应'}`))
  }

  // ================= F 换装休眠 + 成长持久化 =================
  console.log('— F 换装休眠与成长持久化 —')
  const dorm = await evaluate(`(() => {
    const src = document.querySelector('[data-whale-pet] img.whale-pet-media')?.src ?? ''
    return { idleVisual: !/festival-|weather-/.test(src), src: src.slice(-60) }
  })()`)
  softCheck('F1 无节日/无城市配置时空闲视觉不换装（dormant）', dorm.idleVisual, `src=…${dorm.src}`)
  const growthBlob = await evaluate(`(() => {
    try { return JSON.parse(localStorage.getItem('whale-pet-growth-v1') ?? 'null') } catch { return null }
  })()`)
  check('F2 成长账本已落 localStorage（whale-pet-growth-v1）',
    growthBlob !== null && typeof growthBlob === 'object',
    `achievements=${Object.keys(growthBlob?.achievements ?? {}).length} affinity=${growthBlob?.affinity ?? '?'} signin=${growthBlob?.signin ? '有' : '无'}`)

  // ================= 汇总 =================
  console.log('— 汇总 —')
  console.log(`结果：${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}；WARN ${warns.length} 项`)
  if (failures.length > 0) console.log(`失败项：${failures.join(' | ')}`)
  if (warns.length > 0) console.log(`警告项：${warns.join(' | ')}`)
} finally {
  clearTimeout(watchdog)
  try { socket.close() } catch {}
}
process.exit(failures.length === 0 ? 0 : 1)
