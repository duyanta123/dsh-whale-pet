// 鲸鱼娘桌宠 · client 主模块（ESM，M1-8 集成层）。
// 由 lib/client.js（普通脚本工厂）动态 import 装载；本文件与 lib/client/*.mjs
// 同走 /api/whale-pet/client/* 同源路由，可被 node --test 直接单测（纯逻辑部分）。
// 职责分层（薄执行层）：
// - 状态选择/细节规则 = logic.mjs（纯函数）；working 插曲节奏 = rhythm.mjs（纯函数）；
// - 素材播放 = renderer.mjs；本文件只做「事实输入 + 到点翻转 + DOM/定时器持有」。
// 生命周期：全部计时器/DOM/slots 注册挂 dispose，幂等可重入（0.1.7 运行时卸载契约）。
import {
  selectState, shouldWake, wakeFromInteraction, nextFacingAt, nextWalkRhythm,
  DRAG_RELEASE_MS, WAKE_MS, TRANSIENT_MS, CELEBRATE_MS, IDLE_SLEEP_MS,
} from './logic.mjs'
import { nextWorkingRhythm } from './rhythm.mjs'
import {
  isNightMute, careDue, tickPomodoro, pickSkit, nextSkitAt, walkAllowed, SKIT_LINES,
} from './care.mjs'
import { POMODORO_FOCUS_MS } from './care.mjs'
import { pickProactiveLine } from './fusion.mjs'
import { normalizeSettings, createSettingsCard } from './settings.mjs'
import { createRenderer } from './renderer.mjs'
import { bboxHit } from './bbox.mjs'
import { canFeed, feedCooldownLeft, FEED_COOLDOWN_MS } from './feed.mjs'
import { createBubble, pickMeme } from './bubble.mjs'
import { createDashboard } from './dashboard.mjs'
import { assetUrl, setCharacter } from './assets-manifest.mjs'
import { createGrowth, ACHIEVEMENTS } from './growth.mjs'
import { festivalOf, idleOverlayVisual } from './festival.mjs'
import { resolveWeatherId, WEATHER_POLL_MS } from './weather.mjs'
import { parseBalancePayload, balanceLowDecision, nextPollAt } from './balance-low.mjs'
import {
  gameNewState, gameTick, gamePop, gameResult, gamePose, gameRewardAllowed, GAME,
} from './game.mjs'
import { createMemeCatalog, MEME_CDN_PROBE_TTL_MS } from './meme-catalog.mjs'

const STATE_PATH = '/api/whale-pet/state'
const EVENTS_PATH = '/api/whale-pet/events'
const SETTINGS_PATH = '/api/whale-pet/settings'
const BALANCE_PATH = '/api/whale-pet/balance'
const WEATHER_PATH = '/api/whale-pet/weather'

/** 注入一次的样式（id 幂等：重复挂载先查重）。 */
const STYLE_ID = 'whale-pet-style'

const CSS = `
.whale-pet-host{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:120px;height:120px;
  font-family:system-ui,-apple-system,'Segoe UI',sans-serif;user-select:none;touch-action:none;pointer-events:none}
.whale-pet-stage{position:relative;width:100%;height:100%;pointer-events:auto;cursor:grab;
  transform-origin:50% 100%}
.whale-pet-stage:active{cursor:grabbing}
.whale-pet-media{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.whale-pet-game{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;align-items:center;
  justify-content:center;pointer-events:none}
.whale-pet-game-hud{font-size:10px;line-height:14px;color:#fff;background:rgba(24,28,38,.85);
  border-radius:6px;padding:1px 6px;margin-bottom:2px;text-align:center;white-space:nowrap}
.whale-pet-game-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:2px;pointer-events:auto}
.whale-pet-game-cell{width:26px;height:26px;border:0;border-radius:6px;background:rgba(24,28,38,.45);
  font-size:15px;line-height:1;display:flex;align-items:center;justify-content:center;padding:0;cursor:default}
.whale-pet-game-cell.has-bubble{cursor:pointer}
.whale-pet-game-result{position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:3px;background:rgba(24,28,38,.9);border-radius:10px;color:#e8ebf2;
  font-size:11px;text-align:center;pointer-events:auto;padding:4px;white-space:pre-line}
.whale-pet-game-fx{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;z-index:4}
`

function ensureStyle() {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

const POLL_MS = 3000 // 轮询兜底周期（SSE 即时为主，EventSource 内建重连）
const TICK_MS = 250 // 决策 tick（到点翻转的精度）

/**
 * 挂载桌宠（由 client.js 工厂调用）。
 * @param {{ ctx: object, React: object }} deps ctx=client 半侧 cordis 上下文（slots 服务）；
 *   React=平台提供的 react（槽组件用）。
 * @returns {() => void} dispose（幂等可重入）。
 */
export function mountPet({ ctx, React }) {
  const h = React.createElement
  let disposed = false
  const disposers = []
  const timers = []
  const every = (fn, ms) => {
    const t = setInterval(() => { try { fn() } catch (error) { console.warn('[whale-pet] tick 异常：', error) } }, ms)
    timers.push(t)
    return t
  }
  const after = (fn, ms) => {
    const t = setTimeout(() => {
      const i = timers.indexOf(t)
      if (i >= 0) timers.splice(i, 1)
      try { fn() } catch (error) { console.warn('[whale-pet] 定时回调异常：', error) }
    }, ms)
    timers.push(t)
    return t
  }

  ensureStyle()

  // ---- 宠物本体 DOM（挂进 shell.overlay 槽渲染出的容器）----
  const host = document.createElement('div')
  host.className = 'whale-pet-host'
  host.setAttribute('data-whale-pet', '')

  const stage = document.createElement('div')
  stage.className = 'whale-pet-stage'
  stage.setAttribute('role', 'img')
  stage.setAttribute('aria-label', '鲸鱼娘桌宠')
  host.dataset.state = 'idle' // 观测面初值：tick 仅在状态变化时改写（GUI 验收/探针依赖）
  const media = document.createElement('img')
  media.className = 'whale-pet-media'
  media.alt = ''
  media.draggable = false
  media.src = '/api/whale-pet/assets/musume/dsh-whale-state-idle-cute.webp'
  stage.appendChild(media)
  host.appendChild(stage)

  // ---- 渲染器（双缓冲/flip/降级；once 播完清瞬发）----
  const renderer = createRenderer({
    stage,
    onOnceEnded: () => { local.transient = null; local.transientUntil = 0 },
  })

  // ---- 气泡（任务完成信息/表情包/主动播报共用容器；挂 host——stage 有朝向镜像，文字不能翻）----
  const bubble = createBubble({ host })

  // ---- 仪表板（M3-4）：settings 卡 📊 按钮经 window 事件 toggle ----
  const dashboard = createDashboard({ host: document.body })
  const onDashToggle = () => dashboard.toggle()
  window.addEventListener('whale-pet:dashboard-toggle', onDashToggle)
  disposers.push(() => window.removeEventListener('whale-pet:dashboard-toggle', onDashToggle))
  const lastFactsRef = { celebrate: false, error: false, welcome: false, announce: false }
  const sayOnFacts = () => {
    const celebrate = facts.windows.some((w) => w.name === 'celebrate')
    const error = facts.windows.some((w) => w.name === 'error' || w.name === 'disappointed')
    const welcome = facts.windows.some((w) => w.name === 'welcome')
    if (celebrate && !lastFactsRef.celebrate) {
      // M3-3：优先用 Node 携带的任务完成信息（耗时/Token/费用多行，pre-line 渲染）。
      const win = facts.windows.find((w) => w.name === 'celebrate')
      sayMeme(win?.message || '任务完成啦！辛苦辛苦～')
    }
    if (error && !lastFactsRef.error) bubble.say('呜……好像出错了， whale 陪你缓缓。', { ms: 4000 })
    if (welcome && !lastFactsRef.welcome) bubble.say('欢迎回来～鲸鱼娘就位！', { ms: 4000 })
    lastFactsRef.celebrate = celebrate
    lastFactsRef.error = error
    lastFactsRef.welcome = welcome
    // M6-4 周报/外部递送入口（/api/whale-pet/announce）：气泡面呈现，不参与状态机；
    // 属用户主动投递，不受深夜静音红线约束（红线管的是「它主动找你」）。
    const announce = facts.announce
    if (announce !== null && !lastFactsRef.announce && announce.text) {
      bubble.say(announce.text, { ms: announce.ms ?? 8000 })
    }
    lastFactsRef.announce = announce !== null
  }

  // ---- 拖拽 + 分区热区 + 喂食（M2-1/2/3）----
  const pointer = { id: null, startX: 0, startY: 0, moved: false, offX: 0, offY: 0 }
  const DRAG_THRESHOLD_PX = 6
  const REACT_MS = 2200

  const stagePoint = (event) => {
    const rect = stage.getBoundingClientRect()
    return { nx: (event.clientX - rect.left) / rect.width, ny: (event.clientY - rect.top) / rect.height }
  }

  const onPointerDown = (event) => {
    if (disposed || pointer.id !== null) return
    pointer.id = event.pointerId
    pointer.startX = event.clientX
    pointer.startY = event.clientY
    pointer.moved = false
    const rect = stage.getBoundingClientRect()
    pointer.offX = event.clientX - rect.left
    pointer.offY = event.clientY - rect.top
    try { stage.setPointerCapture(event.pointerId) } catch {}
  }

  const onPointerMove = (event) => {
    if (disposed || event.pointerId !== pointer.id) return
    if (!local.dragging) {
      if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < DRAG_THRESHOLD_PX) return
      local.dragging = true // 进入 drag：STATE_TABLE R1 命中，漫游由 armWalk 守卫禁用
    }
    pointer.moved = true
    const width = stage.offsetWidth
    const height = stage.offsetHeight
    const maxX = Math.max(0, window.innerWidth - width)
    const maxY = Math.max(0, window.innerHeight - height)
    const left = Math.min(maxX, Math.max(0, event.clientX - pointer.offX))
    const top = Math.min(maxY, Math.max(0, event.clientY - pointer.offY))
    host.style.left = `${left}px`
    host.style.top = `${top}px`
    host.style.right = 'auto'
    host.style.bottom = 'auto'
  }

  const onPointerUp = (event) => {
    if (disposed || event.pointerId !== pointer.id) return
    pointer.id = null
    try { stage.releasePointerCapture(event.pointerId) } catch {}
    const now = Date.now()
    local.lastInteractAt = now
    touchGrowthInteract() // 二期 growth：回归判定（离开 ≥2h 后的任意交互，含拖拽释放）
    if (local.dragging) {
      local.dragging = false
      local.dragReleaseUntil = now + DRAG_RELEASE_MS // 1.5s 放下缓冲
      armWalk() // 拖完再武装漫游（拖拽中禁用）
      return
    }
    // 单击：分区热区反应（二期 bbox 表优先——点在 bbox 外 → null 不可交互；
    // 无表状态/链首无表在 bbox.mjs 内部自动回退 hitzone.mjs 静态 full 表，
    // 行为与一期 hitZone 一致。plan §11-2：调用点直呼 bboxHit，hitzone.mjs 零修改）
    const { nx, ny } = stagePoint(event)
    const zone = bboxHit(nx, ny, renderer.current(), { flip: facing })
    if (zone === null) return // bbox 外：不设反应、不计互动指标（whale-girl 决策核心收益）
    local.react = zone
    local.reactUntil = now + REACT_MS
    ingestZone(zone) // pat/belly/tail 计数 + 深夜本地交互计数
  }

  // 双击喂食（M2-3）：TOKEN 鱼干 → eat 瞬发 + 气泡；30s 冷却防刷
  const onDblClick = () => {
    if (disposed) return
    const now = Date.now()
    local.lastInteractAt = now
    touchGrowthInteract() // 回归判定（任意交互）
    if (!canFeed(now, local.lastFedAt, FEED_COOLDOWN_MS)) {
      bubble.say(`鱼干还在消化中…（${Math.ceil(feedCooldownLeft(now, local.lastFedAt) / 1000)}s）`, { ms: 2000 })
      return
    }
    local.lastFedAt = now
    local.transient = 'eat'
    local.transientUntil = now + TRANSIENT_MS
    sayMeme('谢谢投喂～ TOKEN 鱼干真好吃！') // meme 弹出计数（meme-catalog 供应）
    if (isNightMute(now, settings.night)) growthIngest({ metric: 'night-interact' })
    growthIngest({ metric: 'feed' }, { announce: true }) // 投喂成功才计（成就/任务 feed 落点）
  }

  stage.addEventListener('pointerdown', onPointerDown)
  stage.addEventListener('pointermove', onPointerMove)
  stage.addEventListener('pointerup', onPointerUp)
  stage.addEventListener('pointercancel', onPointerUp)
  stage.addEventListener('dblclick', onDblClick)
  disposers.push(() => {
    stage.removeEventListener('pointerdown', onPointerDown)
    stage.removeEventListener('pointermove', onPointerMove)
    stage.removeEventListener('pointerup', onPointerUp)
    stage.removeEventListener('pointercancel', onPointerUp)
    stage.removeEventListener('dblclick', onDblClick)
  })

  // ---- 本地交互状态（宿主持有；选择逻辑在 logic.mjs）----
  const local = {
    dragging: false,
    dragReleaseUntil: 0,
    transient: null, // 'eat' | 'play' | 'wake'
    transientUntil: 0,
    celebrateUntil: 0, // 回合完成本地庆祝窗
    workingActive: false, // working 插曲（节奏器翻转）
    joyUntil: 0,
    sleeping: false,
    walking: false,
    react: null, // 热区反应区 id（'head'|'belly'|'tail'；~2.2s 后清除）
    reactUntil: 0,
    lastFedAt: null, // 喂食冷却（30s）
    lastInteractAt: Date.now(), // 交互醒觉：空闲从交互时刻重新起算
    animState: 'idle', // 上一帧视觉状态（醒觉边沿判定）
  }
  let facing = 1
  let facingTurnAt = 0
  let walkUntil = 0
  let walkTimer = null
  let working = { active: false, until: 0 }
  let workingTimer = null

  // ---- Node 事实（SSE 即时 + 轮询兜底；断线重连后由 SSE 首帧/轮询补快照）----
  let facts = { windows: [], wait: false, thinking: false, struggling: false, insights: [], announce: null }
  let prevThinking = false

  // ---- M5 运行时设置（宿主 ~/.dsh/whale-pet/settings.json 的归一化镜像；热应用）----
  let settings = normalizeSettings(null)
  const applySettings = (next) => {
    settings = normalizeSettings(next)
    armSkit() // 频率/开关即时生效（其余决策函数逐 tick 读 settings）
    armWalk() // 散步开关/深夜窗口变化即时重排（关→开、静音段结束都靠这里复活）
    // ---- 二期热应用（phase2-plan §11-2）：角色变体 / memeCdn 开关 / 天气配置 / 游戏开关 ----
    // （下方二期块内函数此处按调用期解析；applySettings 仅在异步回调/设置事件中执行，安全）
    setCharacter(settings.character) // swapChains memo 化，同值幂等零成本
    rebuildMemeCatalogIfNeeded()
    pollWeather() // 节流在 pollWeather 内
    if (settings.game.enabled !== true) closeGame() // 游戏总开关关 → 会话即收（开着时无害幂等）
  }
  const loadSettings = async () => {
    try {
      const res = await fetch(SETTINGS_PATH, { cache: 'no-store' })
      if (res.ok && !disposed) applySettings(await res.json())
    } catch { /* 路由暂不可达：先用默认配置跑，下轮组件加载再试 */ }
  }
  loadSettings()

  // ==================== 二期接线（phase2-plan §11 步骤 2；全部挂 dispose、幂等可重入）====================

  // ---- growth 成长系统（成就/任务/签到；localStorage 适配器内建于 createGrowth，dispose flush）----
  const growth = createGrowth()
  disposers.push(() => { try { growth.dispose() } catch {} })
  const COMEBACK_MS = 2 * 60 * 60 * 1000
  let lastGrowthInteractAt = Date.now()
  /** 成就 id → 解锁气泡（用户操作触发的被动反馈面，深夜可显示——plan §0 分类）。 */
  const announceUnlocks = (ids) => {
    for (const id of Array.isArray(ids) ? ids : []) {
      const def = ACHIEVEMENTS.find((a) => a.id === id)
      if (def) bubble.say(`解锁成就「${def.name}」✨`, { ms: 4000 })
    }
  }
  /**
   * 指标喂入统一入口：announce=true 弹解锁气泡（交互驱动面）；轮询差分喂入
   * （非用户操作）announce=false——成就照常入账只是不弹泡（主动推送面深夜保守）。
   */
  const growthIngest = (signal, { announce = false } = {}) => {
    const result = growth.ingest(signal)
    if (announce) announceUnlocks(result.unlocks)
    return result
  }
  /** 交互时刻记账：距上次交互 ≥2h → comeback（欢迎回来）指标。 */
  const touchGrowthInteract = () => {
    const t = Date.now()
    if (t - lastGrowthInteractAt >= COMEBACK_MS) growthIngest({ metric: 'comeback' }, { announce: true })
    lastGrowthInteractAt = t
  }
  /** 热区交互指标（pat/belly/tail）+ 深夜本地交互计数（isNightMute 判定留在 main——growth 不 import care）。 */
  const ingestZone = (zone) => {
    growthIngest({ metric: zone }, { announce: true })
    if (isNightMute(Date.now(), settings.night)) growthIngest({ metric: 'night-interact' })
  }
  /** 带表情包的气泡：meme-catalog 供应（CDN 开→探测降级本地池）+ meme 弹出计数。 */
  const sayMeme = (text, opts = {}) => {
    bubble.say(text, { ...opts, memeUrl: opts.memeUrl ?? memeSupplyUrl() })
    growthIngest({ metric: 'meme' }, { announce: true })
  }

  // ---- /state pet 快照差分 → 成长指标（task/failure/session/activeMin/level/day；wiring ③）----
  // 首轮只挂快照（signal.pet 缓存供 pet 系成就谓词——不传则这些成就暂不解锁，不报错），
  // 不做历史回填；此后逐字段差分、差值 >0 才 ingest。
  let lastPetSeen = null
  let lastPetDayKey = null
  const localDayKeyOf = (t) => `${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()}`
  const ingestPetDiff = (pet) => {
    if (!pet || typeof pet !== 'object') return
    const stats = pet.stats ?? {}
    const prev = lastPetSeen
    lastPetSeen = pet
    const dayKey = localDayKeyOf(new Date())
    if (prev === null || typeof prev !== 'object') {
      growthIngest({ metric: 'day', amount: 0, pet }) // day 无计数器落点：纯挂最新 pet 快照
      lastPetDayKey = dayKey
      return
    }
    const p = prev.stats ?? {}
    const up = (a, b) => (typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b) && a > b ? a - b : 0)
    const dTask = up(stats.tasksDone, p.tasksDone)
    const dFail = up(stats.failures, p.failures)
    const dSession = up(stats.sessions, p.sessions)
    const dActiveMin = Math.floor(up(stats.activeMs, p.activeMs) / 60000)
    const dLevel = up(pet.level, prev.level)
    const newDay = lastPetDayKey !== null && dayKey !== lastPetDayKey
    lastPetDayKey = dayKey
    if (dTask > 0) growthIngest({ metric: 'task', amount: dTask, pet })
    if (dFail > 0) growthIngest({ metric: 'failure', amount: dFail, pet })
    if (dSession > 0) growthIngest({ metric: 'session', amount: dSession, pet })
    if (dActiveMin > 0) growthIngest({ metric: 'activeMin', amount: dActiveMin, pet })
    if (dLevel > 0) growthIngest({ metric: 'level', amount: dLevel, pet })
    if (newDay) growthIngest({ metric: 'day', amount: 1, pet })
  }

  // ---- meme CDN 目录（474 张热链，探测失败静默回退本地 30 张；实例随 memeCdn.enabled 热应用重建）----
  let memeCatalog = createMemeCatalog({ enabled: settings.memeCdn.enabled !== false })
  let memeCatalogEnabled = settings.memeCdn.enabled !== false // 现役实例开关位：实例引用从不置 null，是否需重建以此比对
  /** 表情包供应入口（plan §11-2：main 调用点直呼 catalog.pick().url，bubble.mjs 零改动）：
   *  目录缺席/意外异常回退一期本地池 pickMeme——供应面永不同步 throw（失败静默红线）。 */
  const memeSupplyUrl = (random = Math.random) => {
    if (memeCatalog) {
      try {
        return memeCatalog.pick(random).url
      } catch { /* 失败静默：回本地池 */ }
    }
    return pickMeme(random)
  }
  disposers.push(() => { try { memeCatalog?.dispose() } catch {} })
  const rebuildMemeCatalogIfNeeded = () => {
    const enabled = settings.memeCdn.enabled !== false
    if (memeCatalog !== null && memeCatalogEnabled === enabled) return // 现役实例已是目标开关（幂等）；关→关复用 disabled 实例，不做无效重建
    try { memeCatalog?.dispose() } catch {}
    memeCatalog = createMemeCatalog({ enabled })
    memeCatalogEnabled = enabled // 重建落地后才更新现役开关位：关→开（含 ON→OFF→ON 二次开）由此被识别并重建首探
    memeCatalog.refresh() // 新实例 lastProbeAt=null → 模块内 TTL 不拦截，立即首探（不等 10min 周期；失败静默；disabled 实例内空转无害）
  }
  every(() => { try { memeCatalog?.refresh() } catch {} }, MEME_CDN_PROBE_TTL_MS) // 模块内 TTL 节流，多调是廉价空转
  if (settings.memeCdn.enabled !== false) memeCatalog.refresh() // 启动首探（不 await，失败静默）

  // ---- 天气换装（30min 低频轮询；'clear'/失败/未配置城市 = 不换装）----
  let weatherId = null
  let weatherBusy = false
  let lastWeatherPollAt = 0
  const pollWeather = async () => {
    if (disposed || weatherBusy) return
    if (settings.weather.enabled !== true) { weatherId = null; return } // 关闭即清：已生效换装即时退场（applySettings 每次开关都调到这里）
    const city = typeof settings.weather.city === 'string' ? settings.weather.city.trim() : ''
    if (city === '') { weatherId = null; return } // 空 = 休眠不查询
    const t = Date.now()
    if (t - lastWeatherPollAt < 30_000) return // applySettings 频繁触发时的节流
    lastWeatherPollAt = t
    weatherBusy = true
    try {
      const res = await fetch(WEATHER_PATH, { cache: 'no-store' })
      const data = res.ok ? await res.json() : null
      const id = data?.ok === true ? resolveWeatherId({ code: data.code, tempC: data.tempC }) : 'clear'
      weatherId = id === 'clear' ? null : id // 'clear' = 不换装
    } catch { /* 静默：保持上次换装 */ } finally {
      weatherBusy = false
    }
  }
  every(pollWeather, WEATHER_POLL_MS)

  // ---- 余额提醒（默认关；nextPollAt 节拍 + 指数退避；深夜静音段连轮询都暂停、醒来自然恢复）----
  let balanceNextAt = 0 // 0 = 设置就绪后首轮尽快
  let balanceFailStreak = 0
  let balanceAlertedLow = false
  let balanceLowUntil = 0 // balance-low 姿势窗口（与气泡 ms 同值 8000——plan §11 r3）
  let balanceBusy = false
  const BALANCE_TIER_TEXT = { empty: '已见底', critical: '告急', low: '偏紧', ok: '尚可', good: '充裕', rich: '豪阔' }
  const pollBalance = async () => {
    if (disposed || balanceBusy) return
    if (settings.balanceLow.enabled !== true) return
    const t = Date.now()
    if (isNightMute(t, settings.night)) return // 静音段：跳过轮询（不推气泡也不换装）
    if (t < balanceNextAt) return
    balanceBusy = true
    try {
      const res = await fetch(BALANCE_PATH, { cache: 'no-store' })
      const payload = res.ok ? await res.json() : { ok: false, reason: `http-${res.status}` }
      const parsed = parseBalancePayload(payload)
      const ok = parsed.ok === true
      balanceNextAt = nextPollAt(t, { ok, failStreak: ok ? 0 : balanceFailStreak + 1 })
      balanceFailStreak = ok ? 0 : balanceFailStreak + 1
      if (ok) {
        const decision = balanceLowDecision({
          amount: parsed.amount,
          thresholdCNY: settings.balanceLow.thresholdCNY,
          alertedLow: balanceAlertedLow,
        })
        balanceAlertedLow = decision.alertedLow
        if (decision.alert) {
          // 同一水位只提醒一次（balanceLowDecision 去重）；气泡显式 8000ms，balanceLowUntil 同值——
          // 姿势经 idleOverlayVisual 通道在窗口内稳定呈现、到期自然回落（禁止直呼 renderer.show）。
          balanceLowUntil = Date.now() + 8000
          bubble.say(
            `💰 余额${BALANCE_TIER_TEXT[decision.tier] ?? '异常'}：${parsed.amount} ${parsed.currency}（阈值 ${settings.balanceLow.thresholdCNY} CNY）`,
            { ms: 8000 },
          )
          growthIngest({ metric: 'balance-alert' })
        }
      }
    } catch {
      balanceFailStreak += 1
      balanceNextAt = nextPollAt(Date.now(), { ok: false, failStreak: balanceFailStreak })
    } finally {
      balanceBusy = false
    }
  }
  every(pollBalance, 30_000) // 心跳：到 nextPollAt 节拍才真正外联

  // ---- 泡泡小游戏（用户主动游玩项；棋盘 DOM 叠 stage、tick 驱动、姿势经 idleOverlayVisual）----
  const gameCtl = {
    open: false,
    state: null, // gameNewState 产物
    overlay: null,
    cells: null, // 16 格 DOM
    hud: null,
    result: null, // 结算面板 DOM
    resultOpen: false,
    resultGrade: null, // 'win'|'draw'|'lose'
    bombUntil: 0, // 点中炸弹后 game-cheat 姿势窗口（1.5s，plan §7）
    rewardAllowed: true, // 开局时的每日奖励局读视图（REWARDS_PER_DAY=3，前 3 局/日）
  }
  const CELL_CHAR = { bubble: '🫧', star: '⭐', bomb: '💣' }
  const updateGameHud = () => {
    if (gameCtl.hud === null || gameCtl.state === null) return
    gameCtl.hud.textContent = `⏱ ${Math.ceil(gameCtl.state.remainingMs / 1000)}s　${gameCtl.state.score} 分　连击 ${gameCtl.state.combo}`
  }
  /** 开局特效：鲸鱼吐泡泡 webm 播一次（once；素材加载失败静默，不影响游戏）。 */
  const playGameEffect = () => {
    try {
      const fx = document.createElement('video')
      fx.className = 'whale-pet-game-fx'
      fx.muted = true
      fx.autoplay = true
      fx.playsInline = true
      fx.src = assetUrl('assets/webm/鲸鱼吐泡泡特效.webm')
      fx.addEventListener('ended', () => fx.remove())
      fx.addEventListener('error', () => fx.remove())
      gameCtl.overlay?.appendChild(fx)
      fx.play().catch(() => {})
    } catch { /* 特效失败不影响游戏 */ }
  }
  const startGame = () => {
    if (disposed || gameCtl.open || settings.game.enabled !== true) return
    const now = Date.now()
    gameCtl.open = true
    gameCtl.resultOpen = false
    gameCtl.resultGrade = null
    gameCtl.bombUntil = 0
    gameCtl.state = gameNewState(now)
    gameCtl.rewardAllowed = gameRewardAllowed(growth.snapshot(), now) // 开局前读视图（跨日重置由 growth 维护）
    const overlay = document.createElement('div')
    overlay.className = 'whale-pet-game'
    const hud = document.createElement('div')
    hud.className = 'whale-pet-game-hud'
    const grid = document.createElement('div')
    grid.className = 'whale-pet-game-grid'
    const cells = []
    for (let i = 0; i < GAME.GRID * GAME.GRID; i += 1) {
      const cell = document.createElement('button')
      cell.type = 'button'
      cell.className = 'whale-pet-game-cell'
      cell.setAttribute('aria-label', `泡泡格 ${i + 1}`)
      // 阻断冒泡：格点交互不进 stage 的拖拽/热区/喂食路径（游戏点击 ≠ 摸头），
      // 但计入交互醒觉（游戏中不入睡）。
      cell.addEventListener('pointerdown', (e) => { e.stopPropagation(); local.lastInteractAt = Date.now() })
      cell.addEventListener('pointerup', (e) => e.stopPropagation())
      cell.addEventListener('dblclick', (e) => e.stopPropagation())
      cell.addEventListener('click', () => {
        if (disposed || !gameCtl.open || gameCtl.resultOpen) return
        const t = Date.now()
        const pop = gamePop(gameCtl.state, i, t)
        gameCtl.state = pop.state
        if (pop.hit) {
          cell.textContent = pop.kind === 'bomb' ? '💥' : '' // 炸弹爆炸反馈；普通/星直接消散
          cell.classList.remove('has-bubble')
          if (pop.kind === 'bomb') {
            gameCtl.bombUntil = t + 1500
            after(() => {
              if (gameCtl.cells !== null && gameCtl.state?.board?.[i] == null) gameCtl.cells[i].textContent = ''
            }, 450)
          }
          updateGameHud()
        }
      })
      grid.appendChild(cell)
      cells.push(cell)
    }
    overlay.appendChild(hud)
    overlay.appendChild(grid)
    host.appendChild(overlay) // 挂 host（stage 朝向镜像会翻转 HUD/棋盘文字；host 与 stage 同盒）
    gameCtl.overlay = overlay
    gameCtl.cells = cells
    gameCtl.hud = hud
    updateGameHud()
    playGameEffect()
  }
  const closeGame = () => {
    gameCtl.open = false
    gameCtl.resultOpen = false
    gameCtl.resultGrade = null
    gameCtl.state = null
    gameCtl.overlay?.remove()
    gameCtl.overlay = null
    gameCtl.cells = null
    gameCtl.hud = null
    gameCtl.result = null
  }
  /** 结算：gameResult 聚合 → growth 四连喂（wiring ③ 顺序）→ 面板展示。 */
  const settleGame = () => {
    const result = gameResult(gameCtl.state)
    gameCtl.resultOpen = true
    gameCtl.resultGrade = result.grade
    const unlocks = []
    unlocks.push(...growthIngest({ metric: 'game-play', amount: 1 }, { announce: true }).unlocks)
    unlocks.push(...growthIngest({ metric: `game-${result.grade}`, amount: 1 }, { announce: true }).unlocks)
    unlocks.push(...growthIngest({ metric: 'game-combo', amount: result.comboMax }, { announce: true }).unlocks)
    unlocks.push(...growthIngest({ metric: 'game-highscore', amount: result.score }, { announce: true }).unlocks)
    announceUnlocks(unlocks)
    const gradeText = result.grade === 'win' ? '🏆 获胜！' : (result.grade === 'draw' ? '🤝 平局' : '💦 惜败')
    const panel = document.createElement('div')
    panel.className = 'whale-pet-game-result'
    panel.appendChild(document.createTextNode(
      `${gradeText}\n得分 ${result.score}（≥300 胜 / ≥150 平）· 最高连击 ${result.comboMax}` +
      `\n${gameCtl.rewardAllowed ? '好感奖励已发放～' : '今日奖励局（3 局）已用完，明天再来～'}`,
    ))
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.textContent = '关闭'
    closeBtn.style.cssText = 'margin-top:2px;padding:3px 14px;border:0;border-radius:6px;background:rgba(86,134,254,.3);color:#fff;cursor:pointer;font-size:11px'
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeGame() })
    panel.appendChild(closeBtn)
    gameCtl.overlay?.appendChild(panel)
    gameCtl.result = panel
  }
  /** 每个决策 tick 驱动一帧（gameTick 纯函数：expire/spawn 事件增删格面 + 时限扣减 + 归零结算）。 */
  const driveGame = (now) => {
    if (!gameCtl.open || gameCtl.resultOpen || gameCtl.state === null || gameCtl.state.status !== 'playing') return
    const ticked = gameTick(gameCtl.state, now, Math.random)
    gameCtl.state = ticked.state
    for (const ev of ticked.events) {
      const cell = gameCtl.cells?.[ev.cell]
      if (cell === undefined) continue
      const has = ev.kind === 'spawn'
      cell.textContent = has ? (CELL_CHAR[ev.bubble] ?? '🫧') : ''
      cell.classList.toggle('has-bubble', has)
    }
    updateGameHud()
    if (ticked.state.status === 'ended') settleGame()
  }
  const onGameToggle = () => {
    if (disposed) return
    if (gameCtl.open) closeGame()
    else startGame()
  }
  window.addEventListener('whale-pet:game-toggle', onGameToggle)
  disposers.push(() => window.removeEventListener('whale-pet:game-toggle', onGameToggle))

  const applyFacts = (next) => {
    facts = {
      windows: Array.isArray(next?.windows) ? next.windows : [],
      wait: next?.wait === true,
      thinking: next?.thinking === true,
      struggling: next?.struggling === true, // M6-4：遇挫事实（工具失败/重试窗口）
      insights: Array.isArray(next?.insights) ? next.insights : [], // M6-4：telemetry 洞察台词
      // M6-4 周报/外部投递气泡（未过期才保留；null = 无）
      announce: (next?.announce && typeof next.announce === 'object' && Number(next.announce.until) > Date.now())
        ? { text: String(next.announce.text ?? ''), ms: Number(next.announce.ms) || undefined }
        : null,
    }
    // 回合完成边沿（client 本地检测）：thinking true→false → 6s 本地庆祝窗。
    if (prevThinking && !facts.thinking) {
      local.celebrateUntil = Date.now() + CELEBRATE_MS
    }
    // working 插曲节奏随 thinking 边沿重排（挂载时事实未就位 → 直接 return，
    // 此后台词上升沿必须有人重武装，否则插曲永不触发——2026-09-30 实测修复）。
    // 二期 growth：深夜赶工边沿（thinking false→true 且深夜静音段内仍有会话在跑，成就 #29）。
    if (prevThinking !== facts.thinking) {
      if (!prevThinking && facts.thinking && isNightMute(Date.now(), settings.night)) {
        growthIngest({ metric: 'night-work' }, { announce: true })
      }
      armWorking()
    }
    prevThinking = facts.thinking
    sayOnFacts()
    ingestPetDiff(next?.pet) // 二期：pet 快照差分 → task/failure/session/activeMin/level/day
  }

  const refresh = async () => {
    if (disposed) return
    try {
      const res = await fetch(STATE_PATH, { cache: 'no-store' })
      if (res.ok) applyFacts(await res.json())
    } catch { /* 宿主路由暂不可达：保留上次事实，下轮再试 */ }
  }

  try {
    const es = new EventSource(EVENTS_PATH)
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data)
        if (data?.type === 'facts') applyFacts(data.facts)
      } catch { /* 非 JSON 心跳帧忽略 */ }
    }
    disposers.push(() => es.close())
  } catch (error) {
    console.warn('[whale-pet] SSE 订阅失败（轮询兜底）：', error)
  }
  every(refresh, POLL_MS)
  refresh()

  // ---- working 插曲节奏器（rhythm.mjs 决策；本层只做「到点翻转」）----
  const armWorking = () => {
    if (workingTimer !== null) {
      clearTimeout(workingTimer)
      const i = timers.indexOf(workingTimer)
      if (i >= 0) timers.splice(i, 1)
      workingTimer = null
    }
    if (disposed) return
    if (facts.thinking !== true) {
      working = { active: false, until: 0 } // 会话不活跃：插曲撤防
      local.workingActive = false
      return
    }
    const decision = nextWorkingRhythm({ now: Date.now(), thinking: true, working })
    const delay = Math.max(0, decision.until - Date.now())
    workingTimer = after(() => {
      workingTimer = null
      working = { active: decision.active, until: 0 } // 进入决策目标状态
      armWorking() // think→working→think…循环武装
    }, delay)
  }

  // ---- 周期散步（logic.mjs nextWalkRhythm 决策；drag 中不触发，拖完再武装）----
  const armWalk = () => {
    if (walkTimer !== null) {
      clearTimeout(walkTimer)
      const i = timers.indexOf(walkTimer)
      if (i >= 0) timers.splice(i, 1)
      walkTimer = null
    }
    if (disposed || local.dragging) return // 拖拽中禁用漫游（M2-1 规则）
    // M5-4/M5-2：设置开关 + 深夜静音段禁用散步
    if (!walkAllowed({
      enabled: settings.walkEnabled,
      nightMute: isNightMute(Date.now(), settings.night),
      dragging: local.dragging,
    })) return
    const decision = nextWalkRhythm({ now: Date.now(), walking: local.walking })
    walkTimer = after(() => {
      walkTimer = null
      // 触发时复检门控（武装后设置/时段可能已变化）；游戏会话进行中不触发散步插曲
      if (decision.active && !gameCtl.open && walkAllowed({
        enabled: settings.walkEnabled,
        nightMute: isNightMute(Date.now(), settings.night),
        dragging: local.dragging,
      })) {
        local.walking = true
        facing = Math.random() < 0.5 ? 1 : -1 // 散步方向随机
        renderer.setFacing(facing)
      } else {
        local.walking = false
      }
      armWalk()
    }, Math.max(0, decision.until - Date.now()))
  }

  // ---- 随机情景短剧（M5-3）：几十分钟级随机间隔主动气泡；开关/频率可配；静音段跳过 ----
  let skitTimer = null
  let lastSkitText = '' // 上次播报文本（含洞察条目，避免连续重复）
  const armSkit = () => {
    if (skitTimer !== null) {
      clearTimeout(skitTimer)
      const i = timers.indexOf(skitTimer)
      if (i >= 0) timers.splice(i, 1)
      skitTimer = null
    }
    if (disposed || settings.skit.enabled !== true) return
    const at = nextSkitAt({
      now: Date.now(),
      minMs: settings.skit.minMinutes * 60000,
      maxMs: settings.skit.maxMinutes * 60000,
    })
    skitTimer = after(() => {
      skitTimer = null
      if (!disposed && settings.skit.enabled === true && !isNightMute(Date.now(), settings.night)) {
        // M6-4：洞察条目（telemetry 数据驱动）与 M5 台词库合并抽取；避免连续重复。
        const picked = pickProactiveLine(
          { insights: facts.insights, avoidTexts: [lastSkitText], random: Math.random },
          () => {
            const pick = pickSkit(null, Math.random)
            return (pick.text === lastSkitText && SKIT_LINES.length > 1)
              ? SKIT_LINES[(pick.index + 1) % SKIT_LINES.length]
              : pick.text
          },
        )
        lastSkitText = picked.line
        bubble.say(picked.line)
      }
      armSkit()
    }, Math.max(0, at - Date.now()))
  }

  // ---- 用户交互醒觉（M1-8）：任何指针交互重置空闲；视觉上在睡才播 wake ----
  const interact = () => {
    const wasVisuallySleeping = local.animState === 'sleep'
    const decision = wakeFromInteraction({ visuallySleeping: wasVisuallySleeping })
    local.sleeping = decision.sleeping
    local.lastInteractAt = Date.now()
    if (decision.wake) {
      local.transient = 'wake'
      local.transientUntil = Date.now() + WAKE_MS
    }
  }
  stage.addEventListener('pointerdown', interact)
  disposers.push(() => stage.removeEventListener('pointerdown', interact))

  // ---- 决策 tick（250ms）：瞬发到期 → 节奏翻转 → 派生 → 选择 → 渲染 ----
  // ---- M5 主动关怀运行时水位（决策在 care.mjs；此处只持有触发态与气泡）----
  const care = { sedentary: { lastFiredAt: null }, water: { lastFiredAt: null } }
  let pomo = { phase: 'off', endsAt: 0 }

  every(() => {
    if (disposed) return
    if (document.hidden) return // M6-2：标签页隐藏暂停决策（恢复后由 visibilitychange 拉快照）
    const now = Date.now()
    if (local.transient !== null && local.transientUntil <= now) {
      local.transient = null
      local.transientUntil = 0
    }
    if (local.react !== null && local.reactUntil <= now) {
      local.react = null // 热区反应瞬发到期
    }
    local.workingActive = working.active
    local.sleeping = now - local.lastInteractAt >= IDLE_SLEEP_MS

    const nightMute = isNightMute(now, settings.night)
    // 节奏器自愈兜底：定时器缺席（武装被门控跳过后门控解除）就在本 tick 补武装。
    if (workingTimer === null && facts.thinking === true) armWorking()
    if (walkTimer === null && !local.dragging && walkAllowed({
      enabled: settings.walkEnabled,
      nightMute: nightMute,
      dragging: local.dragging,
    })) armWalk()

    // M5-2 红线：静音段冻结散步；主动气泡（关怀/番茄钟/短剧）一律静默。
    if (!walkAllowed({ enabled: settings.walkEnabled, nightMute, dragging: local.dragging })) {
      local.walking = false
    }
    if (!nightMute) {
      if (settings.care.sedentaryEnabled === true && careDue({
        now, lastInteractAt: local.lastInteractAt, lastFiredAt: care.sedentary.lastFiredAt,
        intervalMs: settings.care.sedentaryMin * 60000,
      })) {
        care.sedentary.lastFiredAt = now
        bubble.say('坐了好久啦～起来活动一下，鲸鱼娘看着你。')
      }
      if (settings.care.waterEnabled === true && careDue({
        now, lastInteractAt: local.lastInteractAt, lastFiredAt: care.water.lastFiredAt,
        intervalMs: settings.care.waterMin * 60000,
      })) {
        care.water.lastFiredAt = now
        bubble.say('该喝水啦！保持水润，人类和鲸鱼都一样～')
      }
      if (settings.care.pomodoroEnabled === true) {
        if (pomo.phase === 'off') pomo = { phase: 'focus', endsAt: now + POMODORO_FOCUS_MS }
        const step = tickPomodoro(pomo, now)
        if (step.fired === 'focus-end') bubble.say('⏱ 番茄熟啦！休息 5 分钟，看看远处的海～')
        else if (step.fired === 'break-end') bubble.say('⏰ 休息结束，继续加油！鲸鱼娘陪着你。')
        pomo = step
      }
    } else if (pomo.phase !== 'off') {
      pomo = { phase: 'off', endsAt: 0 } // 静音段冻结番茄钟，避免跨窗后补发过期边沿
    }

    // 二期游戏会话：每个 tick 驱动一帧（生成/消亡/时限扣减/结算）；进行中冻结散步插曲。
    driveGame(now)
    if (gameCtl.open) local.walking = false
    let next = selectState(facts, local, now)
    // idle 兜底视觉覆盖（二期，替换 nightVisualState 调用点——care.mjs 零改动，无覆盖通道时逐点一致）：
    // gamePose（游戏会话）> night（深夜兜底）> balance-low（余额提醒伴随姿势）> festival > weather > idle；
    // 非 idle（交互/镜像态）原样返回，不覆盖。festival 按本地日历日每 tick 解析（查表廉价）。
    const gamePhase = gameCtl.open
      ? (gameCtl.resultOpen
        ? gameCtl.resultGrade // 结算面板打开期间按评级（win/draw/lose）
        : (gameCtl.state !== null && gameCtl.state.status === 'playing'
          ? (now < gameCtl.bombUntil ? 'bomb' : (gameCtl.state.combo >= 5 ? 'combo' : 'playing'))
          : null))
      : null
    next = idleOverlayVisual(next, {
      nightMute,
      gamePose: gamePose(gamePhase),
      balanceLowPose: now < balanceLowUntil ? 'balance-low' : null, // 窗口内经 overlay 通道稳定呈现
      festivalId: settings.festival.enabled === true ? (festivalOf(now)?.id ?? null) : null,
      // enabled 门控与 festivalId 同款：关闭即清零（覆盖轮询在途窗口——in-flight 响应回写也不上屏）
      weatherId: settings.weather.enabled === true ? weatherId : null,
    })
    // 睡醒边沿：视觉 sleep → 非 sleep（非拖拽、无瞬发占用）→ 插 wake 过渡后重算。
    if (shouldWake(local.animState, next, local)) {
      local.transient = 'wake'
      local.transientUntil = now + WAKE_MS
      next = selectState(facts, local, now)
    }
    // 静态陪伴态（idle/think/wait）随机转身（10-25s；walk/drag 方向不覆盖）。
    if ((next === 'idle' || next === 'think' || next === 'wait') && now >= facingTurnAt) {
      facing *= -1
      renderer.setFacing(facing)
      facingTurnAt = nextFacingAt({ now })
    }
    if (next !== local.animState) {
      local.animState = next
      renderer.show(next)
      host.dataset.state = next // 可观测面：GUI 验收/探针读这里
    }
  }, TICK_MS)

  // ---- 标签页隐藏/恢复（M6-2）：隐藏暂停视频解码；恢复立即拉取最新快照续播 ----
  const onVisibility = () => {
    if (disposed) return
    if (document.hidden) {
      renderer.setPaused(true)
    } else {
      renderer.setPaused(false)
      refresh()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)
  disposers.push(() => document.removeEventListener('visibilitychange', onVisibility))

  // ---- slots 注入（generator 叠加模式：不替换其他条目）----
  let mountHost = null
  const mountInto = (el) => {
    mountHost = el
    el.appendChild(host)
    armWorking() // 槽就绪后武装插曲节奏（会话事实已可能就位）
    armWalk()
  }
  const unmountFrom = () => {
    host.remove()
    mountHost = null
  }

  function PetMount() {
    return h('div', {
      ref: (el) => { if (el) mountInto(el); else unmountFrom() },
      style: { display: 'contents' },
    })
  }

  const injectSlot = (slotName, def, component, label) => {
    try {
      const off = ctx.slots.inject(slotName, function* () {
        yield ctx.slots.register(def, component)
      })
      if (typeof off === 'function') disposers.push(off)
    } catch (error) {
      console.warn(`[whale-pet] 槽位 ${label} 注册失败（宠物照常尝试直挂）：`, error)
      // 失败隔离：overlay 槽缺席时直挂 body（降级路径，正常组合不会走到）。
      if (slotName === 'shell.overlay') {
        document.body.appendChild(host)
        armWorking()
        armWalk()
      }
    }
  }
  injectSlot('shell.overlay', { name: 'shell.overlay', id: 'whale-pet-overlay', order: 1000 }, PetMount, 'shell.overlay')
  injectSlot('settings.section', {
    name: 'settings.section',
    id: 'whale-pet-settings',
    order: 30,
    label: '鲸鱼娘桌宠',
  }, createSettingsCard(React, {
    onSettingsChange: (next) => { if (!disposed) applySettings(next) }, // M5-6 设置热应用
    // 二期「成长」区数据面：签到/领取经宿主包装（签到成功/周里程碑/领奖/成就解锁气泡——
    // 均为用户操作触发的被动反馈，深夜不受限）
    growth: {
      snapshot: () => growth.snapshot(),
      signin: () => {
        const r = growth.signin(Date.now())
        if (r.first === true) bubble.say('签到成功！今天也一起加油呀～')
        if (r.milestoneHit) bubble.say(`每周签到 ${r.milestoneHit}/7 天里程碑达成，好感 +${r.milestoneReward}！`)
        announceUnlocks(r.unlocks)
        return r
      },
      claimQuest: (id) => {
        const r = growth.claimQuest(id)
        if (r.claimed === true) bubble.say(`任务奖励到账：好感 +${r.reward?.affinity ?? 0}～`)
        if (r.newlyAll === true) bubble.say('今日任务三槽全清！鲸鱼娘崇拜你～')
        announceUnlocks(r.unlocks)
        return r
      },
    },
  }), 'settings.section')

  return function dispose() {
    if (disposed) return
    disposed = true
    closeGame() // 二期：游戏棋盘/结算面板 DOM 移除（growth/meme 目录 dispose 在 disposers 内）
    if (workingTimer !== null) clearTimeout(workingTimer)
    if (walkTimer !== null) clearTimeout(walkTimer)
    if (skitTimer !== null) clearTimeout(skitTimer)
    for (const t of timers.splice(0)) clearInterval(t)
    renderer.dispose()
    bubble.dispose()
    dashboard.dispose()
    for (const off of disposers.splice(0)) {
      try { off() } catch {}
    }
    host.remove()
  }
}
