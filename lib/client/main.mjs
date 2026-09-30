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
  isNightMute, careDue, tickPomodoro, pickSkit, nextSkitAt, walkAllowed, nightVisualState, SKIT_LINES,
} from './care.mjs'
import { POMODORO_FOCUS_MS } from './care.mjs'
import { pickProactiveLine } from './fusion.mjs'
import { normalizeSettings, createSettingsCard } from './settings.mjs'
import { createRenderer } from './renderer.mjs'
import { hitZone } from './hitzone.mjs'
import { canFeed, feedCooldownLeft, FEED_COOLDOWN_MS } from './feed.mjs'
import { createBubble, pickMeme } from './bubble.mjs'
import { createDashboard } from './dashboard.mjs'

const STATE_PATH = '/api/whale-pet/state'
const EVENTS_PATH = '/api/whale-pet/events'
const SETTINGS_PATH = '/api/whale-pet/settings'

/** 注入一次的样式（id 幂等：重复挂载先查重）。 */
const STYLE_ID = 'whale-pet-style'

const CSS = `
.whale-pet-host{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:120px;height:120px;
  font-family:system-ui,-apple-system,'Segoe UI',sans-serif;user-select:none;touch-action:none;pointer-events:none}
.whale-pet-stage{position:relative;width:100%;height:100%;pointer-events:auto;cursor:grab;
  transform-origin:50% 100%}
.whale-pet-stage:active{cursor:grabbing}
.whale-pet-media{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
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

  // ---- 气泡（任务完成信息/表情包/主动播报共用容器）----
  const bubble = createBubble({ stage })

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
      bubble.say(win?.message || '任务完成啦！辛苦辛苦～', { memeUrl: pickMeme() })
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
    if (local.dragging) {
      local.dragging = false
      local.dragReleaseUntil = now + DRAG_RELEASE_MS // 1.5s 放下缓冲
      armWalk() // 拖完再武装漫游（拖拽中禁用）
      return
    }
    // 单击：分区热区反应（full 姿态 tail > head > belly 首个命中）
    const { nx, ny } = stagePoint(event)
    const zone = hitZone(nx, ny, 'full')
    local.react = zone
    local.reactUntil = now + REACT_MS
  }

  // 双击喂食（M2-3）：TOKEN 鱼干 → eat 瞬发 + 气泡；30s 冷却防刷
  const onDblClick = () => {
    if (disposed) return
    const now = Date.now()
    local.lastInteractAt = now
    if (!canFeed(now, local.lastFedAt, FEED_COOLDOWN_MS)) {
      bubble.say(`鱼干还在消化中…（${Math.ceil(feedCooldownLeft(now, local.lastFedAt) / 1000)}s）`, { ms: 2000 })
      return
    }
    local.lastFedAt = now
    local.transient = 'eat'
    local.transientUntil = now + TRANSIENT_MS
    bubble.say('谢谢投喂～ TOKEN 鱼干真好吃！', { memeUrl: pickMeme() })
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
  }
  const loadSettings = async () => {
    try {
      const res = await fetch(SETTINGS_PATH, { cache: 'no-store' })
      if (res.ok && !disposed) applySettings(await res.json())
    } catch { /* 路由暂不可达：先用默认配置跑，下轮组件加载再试 */ }
  }
  loadSettings()

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
    if (prevThinking !== facts.thinking) armWorking()
    prevThinking = facts.thinking
    sayOnFacts()
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
      // 触发时复检门控（武装后设置/时段可能已变化）
      if (decision.active && walkAllowed({
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

    let next = selectState(facts, local, now)
    // M5-2：深夜静音段内 idle 兜底显示 night（深夜困倦）；状态镜像（think/wait/error…）照常。
    next = nightVisualState(next, nightMute)
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
  }), 'settings.section')

  return function dispose() {
    if (disposed) return
    disposed = true
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
