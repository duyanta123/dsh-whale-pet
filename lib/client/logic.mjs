// client 纯逻辑：状态选择与细节规则（无 DOM 引用，node --test 可脱离浏览器单测）。
// 规格：docs/state-machine.md（唯一权威）——本文件实现其 §3 行序 / §4 窗口时长 / §5 细节规则。
// 双端分工：Node half 出事实窗口（windows 数组，已按负面优先级级联排序），client 做本地
// 交互选择（drag/eat/play/wake/celebrate/working/sleep/walk）。行序即优先级、首个命中即返回；
// 窗口结束后重算底层派生状态，不硬编码回 idle。

// ---- 窗口时长常量（Node half 与 client 共用；L2 语义层，代码级不可配）----
export const WELCOME_MS = 6000
export const CELEBRATE_MS = 6000
export const ERROR_MS = 4000
export const DISAPPOINTED_MS = 6000
export const DRAG_RELEASE_MS = 1500
export const WAKE_MS = 3000
export const TRANSIENT_MS = 3000 // eat/play 瞬发
export const JOY_MS = 1600
export const IDLE_SLEEP_MS = 60000
export const WALK_MIN_INTERVAL_MS = 18000
export const WALK_MAX_INTERVAL_MS = 40000
export const WALK_MIN_DUR_MS = 4000
export const WALK_MAX_DUR_MS = 8000

// 状态名权威集合（15 状态，与 docs/state-machine.md §2 一一对应）。
export const STATE_NAMES = Object.freeze([
  'idle', 'working', 'celebrate', 'error', 'disappointed', 'joy', 'eat', 'play',
  'drag', 'walk', 'sleep', 'wake', 'welcome', 'think', 'wait',
  'react-head', 'react-belly', 'react-tail',
])

/**
 * 状态优先级表（文法单源，docs/state-machine.md §3）。
 * 行序即优先级：R1 drag → R2 放下缓冲 → R3 事件 burst → R4/R5 eat/play → R6 wake
 * → R7 wait → R8 回合 celebrate → R9 working → R10 think → R11 joy → R12 sleep
 * → R13 walk → R14 idle 兜底。
 * `when`：命中谓词；`resolve`：命中返回的状态名（缺省恒等 row.state）。
 */
export const STATE_TABLE = [
  // R1 拖拽按住（本地交互优先级最高——用户正拿着它）。
  { state: 'drag', when: (c) => c.dragging },
  // R2 拖拽放下缓冲：松手 1.5s 内保持 idle，避免放下即跳 think/working 的生硬切换；
  // 睡着被拖起让位 wake（醒觉过渡直接播，不吃缓冲）。
  { state: 'idle', when: (c) => c.dragReleaseUntil > c.now && c.transient !== 'wake' },
  // R3 事件 burst：Node 事实窗口（welcome/celebrate/error/disappointed），
  // windows 已按负面优先级级联（error > disappointed > welcome），取首个未过期者。
  { state: 'burst', when: (c) => activeBurst(c.facts, c.now) !== null, resolve: (c) => activeBurst(c.facts, c.now).name },
  { state: 'eat', when: (c) => c.transient === 'eat' },
  { state: 'play', when: (c) => c.transient === 'play' },
  // 热区反应（M2-2）：头/肚子/尾巴点击 → react-* 瞬发（宿主 ~2.2s 后清除 local.react）。
  { state: 'react', when: (c) => c.react !== null, resolve: (c) => `react-${c.react}` },
  { state: 'wake', when: (c) => c.transient === 'wake' },
  // R7 等待审批（持续事实，需要用户注意；低于交互瞬发、高于庆祝）。
  { state: 'wait', when: (c) => c.facts.wait === true },
  // R8 回合完成庆祝（client 本地窗口：session running→false 边沿）。
  { state: 'celebrate', when: (c) => c.celebrateUntil > c.now },
  // R9 working 随机插曲（节奏器，非任务指示灯）。
  { state: 'working', when: (c) => c.workingActive },
  // R10 思考陪伴常态（任一会话 turn 活跃）。
  { state: 'think', when: (c) => c.facts.thinking === true },
  { state: 'joy', when: (c) => c.now < c.joyUntil },
  // R12 空闲入睡（会话活跃时 think/working 先命中，自然覆盖 sleep）。
  { state: 'sleep', when: (c) => c.sleeping },
  { state: 'walk', when: (c) => c.walking },
  { state: 'idle', when: () => true },
]

/** 首个未过期的事实窗口（Node 已排序，直接取第一个）；无则 null。 */
export function activeBurst(facts, now) {
  const windows = Array.isArray(facts?.windows) ? facts.windows : []
  for (const w of windows) {
    if (w && typeof w.name === 'string' && Number.isFinite(w.until) && w.until > now) return w
  }
  return null
}

/** 规范化输入并遍历 STATE_TABLE（now 显式传入，测试确定性）。 */
export function selectState(facts, local, now = Date.now()) {
  const ctx = {
    facts: facts ?? {},
    dragging: local?.dragging ?? false,
    dragReleaseUntil: local?.dragReleaseUntil ?? 0,
    transient: local?.transient ?? null,
    react: local?.react ?? null,
    celebrateUntil: local?.celebrateUntil ?? 0,
    workingActive: local?.workingActive ?? false,
    joyUntil: local?.joyUntil ?? 0,
    sleeping: local?.sleeping ?? false,
    walking: local?.walking ?? false,
    now,
  }
  for (const row of STATE_TABLE) {
    if (row.when(ctx)) return row.resolve ? row.resolve(ctx) : row.state
  }
  return 'idle'
}

// ---- 细节规则纯函数（docs/state-machine.md §5）----

/**
 * 用户交互醒觉决策：拖拽/喂食/玩耍/热区都重置空闲计时（sleeping 恒 false——空闲从
 * 交互时刻重新起算）；仅当交互瞬间宠物**视觉上**处于 sleep 动画才附加 wake 过渡。
 * @param {{ visuallySleeping?: boolean }} input 交互开始时刻 animState 是否为 'sleep'
 * @returns {{ sleeping: boolean, wake: boolean }}
 */
export function wakeFromInteraction({ visuallySleeping } = {}) {
  return { sleeping: false, wake: visuallySleeping === true }
}

/** 睡醒边沿：上一帧视觉 sleep、本帧离开 sleep 且无拖拽/瞬发占用 → 播 wake。 */
export function shouldWake(prevState, nextState, { dragging, transient } = {}) {
  return prevState === 'sleep' && nextState !== 'sleep' && !dragging && (transient ?? null) === null
}

// ---- 随机节奏决策（注入随机源，可单测；决策不碰 DOM/定时器）----

/** 静态陪伴态（idle/think/wait）随机转身间隔：10-25s。 */
export const FACING_MIN_INTERVAL_MS = 10000
export const FACING_MAX_INTERVAL_MS = 25000

/**
 * 下一次转身时刻。
 * @param {{ now: number, random?: () => number }} input
 * @returns {number} 下次转身触发时刻
 */
export function nextFacingAt({ now, random = Math.random }) {
  const wait = FACING_MIN_INTERVAL_MS + random() * (FACING_MAX_INTERVAL_MS - FACING_MIN_INTERVAL_MS)
  return now + wait
}

/**
 * 周期散步决策（M5-4 打通 STATE_TABLE walk 行）：空闲陪伴期间随机间隔触发一次散步。
 * @param {{ now: number, walking: boolean, random?: () => number }} input
 *   walking=true 时返回散步结束时刻（dur），否则返回下次散步开始时刻（wait）。
 * @returns {{ active: boolean, until: number }} active=是否应进入/保持 walk；
 *   until=该状态目标切换时刻（宿主据此设 setTimeout）
 */
export function nextWalkRhythm({ now, walking, random = Math.random }) {
  if (walking) {
    const dur = WALK_MIN_DUR_MS + random() * (WALK_MAX_DUR_MS - WALK_MIN_DUR_MS)
    return { active: false, until: now + dur }
  }
  const wait = WALK_MIN_INTERVAL_MS + random() * (WALK_MAX_INTERVAL_MS - WALK_MIN_INTERVAL_MS)
  return { active: true, until: now + wait }
}

/**
 * 回合完成边沿检测：会话快照 running true→false 的会话即一个 turn 结束。
 * @param {object} snapshot sessions 快照 { byId: { [id]: { running } } }
 * @param {Map<string, boolean>} prevRunning 上次观察的 running 位（宿主持有）
 * @returns {{ flips: Array<{ id: string }>, prevRunning: Map<string, boolean> }}
 */
export function detectTurnCompleted(snapshot, prevRunning) {
  const byId = snapshot?.byId ?? {}
  const nextPrev = new Map(prevRunning)
  const flips = []
  for (const id of Object.keys(byId)) {
    const s = byId[id]
    if (s === null || typeof s !== 'object') continue
    const running = s.running === true
    if (nextPrev.get(id) === true && !running) flips.push({ id })
    nextPrev.set(id, running)
  }
  for (const id of [...nextPrev.keys()]) {
    if (!(id in byId)) nextPrev.delete(id)
  }
  return { flips, prevRunning: nextPrev }
}
