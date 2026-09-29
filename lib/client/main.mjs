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
import { createRenderer } from './renderer.mjs'
import { hitZone } from './hitzone.mjs'
import { canFeed, feedCooldownLeft, FEED_COOLDOWN_MS } from './feed.mjs'
import { createBubble, pickMeme } from './bubble.mjs'
import { createDashboard } from './dashboard.mjs'

const STATE_PATH = '/api/whale-pet/state'
const EVENTS_PATH = '/api/whale-pet/events'

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

/** 设置卡（M4-4，React）：等级/XP 进度/称号/关键 stats + 📊 仪表板入口。 */
function createSettingsCard(React) {
  const h = React.createElement
  const { useState, useEffect } = React
  return function SettingsCard() {
    const [pet, setPet] = useState(null)
    useEffect(() => {
      let alive = true
      const load = async () => {
        try {
          const res = await fetch('/api/whale-pet/state', { cache: 'no-store' })
          if (res.ok && alive) setPet((await res.json()).pet ?? null)
        } catch { /* 路由暂不可达：保留上次快照 */ }
      }
      load()
      const timer = setInterval(load, 10000)
      return () => { alive = false; clearInterval(timer) }
    }, [])
    const stats = pet?.stats ?? {}
    const titles = Array.isArray(pet?.titles) ? pet.titles : []
    const xpForLevel = (lv) => (50 * lv * (lv - 1)) / 2
    const level = pet?.level ?? 1
    const cur = xpForLevel(level)
    const next = xpForLevel(level + 1)
    const pct = Math.min(100, Math.round(((pet?.xp ?? 0) - cur) / Math.max(1, next - cur) * 100))
    return h('div', { style: { padding: '8px 0', fontSize: '13px' } },
      h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '鲸鱼娘桌宠'),
      h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #8a93a6)', marginBottom: '8px' } },
        '状态镜像/交互陪伴/用量仪表板/养成已接入。'),
      h('div', { style: { marginBottom: '6px' } },
        h('span', { style: { fontWeight: 600 } }, `Lv.${level}`),
        h('span', { style: { color: '#8a93a6', marginLeft: '8px' } }, `XP ${pet?.xp ?? 0}（${pct}% → Lv.${level + 1}）`),
      ),
      h('div', { style: { background: 'rgba(86,134,254,.14)', borderRadius: '4px', height: '6px', marginBottom: '8px' } },
        h('div', { style: { width: `${pct}%`, height: '6px', borderRadius: '4px', background: 'rgba(86,134,254,.75)' } })),
      h('div', { style: { color: '#8a93a6', marginBottom: '6px' } },
        `任务 ${stats.tasksDone ?? 0} · 失败 ${stats.failures ?? 0} · 会话 ${stats.sessions ?? 0} · 陪伴 ${Math.round((stats.activeMs ?? 0) / 60000)}分钟`),
      h('div', { style: { marginBottom: '8px' } },
        titles.length > 0
          ? h('span', {}, '称号：', titles.join('、'))
          : h('span', { style: { color: '#8a93a6' } }, '称号：尚未解锁（完成任务/会话即可获得）')),
      h('button', {
        type: 'button',
        onClick: () => { window.dispatchEvent(new CustomEvent('whale-pet:dashboard-toggle')) },
        style: { padding: '4px 12px', border: '0', borderRadius: '6px',
          background: 'rgba(86,134,254,.16)', color: '#b7c8fe', cursor: 'pointer', fontSize: '12px' },
      }, '📊 用量仪表板'),
    )
  }
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
  const lastFactsRef = { celebrate: false, error: false, welcome: false }
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
  let facts = { windows: [], wait: false, thinking: false }
  let prevThinking = false

  const applyFacts = (next) => {
    facts = {
      windows: Array.isArray(next?.windows) ? next.windows : [],
      wait: next?.wait === true,
      thinking: next?.thinking === true,
    }
    // 回合完成边沿（client 本地检测）：thinking true→false → 6s 本地庆祝窗。
    if (prevThinking && !facts.thinking) {
      local.celebrateUntil = Date.now() + CELEBRATE_MS
    }
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
    const decision = nextWalkRhythm({ now: Date.now(), walking: local.walking })
    walkTimer = after(() => {
      walkTimer = null
      if (decision.active) {
        local.walking = true
        facing = Math.random() < 0.5 ? 1 : -1 // 散步方向随机
        renderer.setFacing(facing)
      } else {
        local.walking = false
      }
      armWalk()
    }, Math.max(0, decision.until - Date.now()))
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
  every(() => {
    if (disposed) return
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

    let next = selectState(facts, local, now)
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
  }, createSettingsCard(React), 'settings.section')

  return function dispose() {
    if (disposed) return
    disposed = true
    if (workingTimer !== null) clearTimeout(workingTimer)
    if (walkTimer !== null) clearTimeout(walkTimer)
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
