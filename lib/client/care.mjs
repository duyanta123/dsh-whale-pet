// 主动关怀决策（M5）：深夜静音段 / 久坐·喝水提醒 / 番茄钟 / 随机情景短剧 / 散步门控。
// 全部纯函数（注入时钟时刻与随机源），node --test 可脱离浏览器单测；
// 宿主（client/main.mjs、Node half）只做「到点执行 + 定时器持有」，决策一律回查本文件。
// 红线（详案 §1.2 / 开发计划 M5）：一切主动行为可关；深夜静音段内无主动气泡、无音效。

// ---- 深夜静音段（M5-2）----
/** 默认静音窗口（本地时钟，分钟-of-day）：23:00 → 次日 07:00，跨午夜。 */
export const NIGHT_MUTE_START_MIN = 23 * 60
export const NIGHT_MUTE_END_MIN = 7 * 60

/** 一天总分钟数（时刻换算用）。 */
export const MINUTES_PER_DAY = 24 * 60

/**
 * 本地时刻 → 分钟-of-day（0–1439）。非法输入返回 null（调用方视为非静音）。
 * @param {Date|number} at 本地时刻（时间戳按本地时区解读）
 */
export function minutesOfDay(at) {
  const date = at instanceof Date ? at : (Number.isFinite(at) ? new Date(at) : null)
  if (date === null || Number.isNaN(date.getTime())) return null
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * 深夜静音段判定（M5-2 红线）：静音段内仅保留 sleep，无主动气泡、无音效、无短剧、
 * 无散步。窗口支持跨午夜（start > end 时按两段拼合判定）。
 * @param {Date|number} at 当前本地时刻
 * @param {{ enabled?: boolean, startMin?: number, endMin?: number }} [cfg]
 * @returns {boolean}
 */
export function isNightMute(at, cfg = {}) {
  if (cfg.enabled === false) return false
  const start = Number.isFinite(cfg.startMin) ? cfg.startMin : NIGHT_MUTE_START_MIN
  const end = Number.isFinite(cfg.endMin) ? cfg.endMin : NIGHT_MUTE_END_MIN
  const m = minutesOfDay(at)
  if (m === null) return false
  if (start === end) return false // 零长窗口视为关闭
  return start < end ? (m >= start && m < end) : (m >= start || m < end)
}

// ---- 关怀提醒（M5-1）：久坐 / 喝水 ----
/** 久坐提醒默认间隔（45min）；喝水默认 60min。用户交互重置计时（红线：交互后不打扰）。 */
export const SEDENTARY_INTERVAL_MS = 45 * 60_000
export const WATER_INTERVAL_MS = 60 * 60_000

/**
 * 关怀提醒是否到期（固定间隔、用户交互重置计时）：
 * 到期时刻 = lastInteractAt + intervalMs；已触发过一次后必须等下次交互重置，
 * 避免「没人理它」时每隔 interval 刷一遍（每轮陪伴只提醒一次，交互重置后重新武装）。
 * @param {{ now: number, lastInteractAt: number, lastFiredAt: number|null, intervalMs: number }} input
 * @returns {boolean}
 */
export function careDue({ now, lastInteractAt, lastFiredAt, intervalMs }) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return false
  if (!Number.isFinite(lastInteractAt)) return false
  const dueAt = lastInteractAt + intervalMs
  if (now < dueAt) return false
  if (Number.isFinite(lastFiredAt) && lastFiredAt >= lastInteractAt) return false // 本轮已提醒
  return true
}

/** 下次关怀到期时刻（设置卡/测试展示用）。 */
export function careDueAt({ lastInteractAt, intervalMs }) {
  if (!Number.isFinite(lastInteractAt) || !Number.isFinite(intervalMs) || intervalMs <= 0) return Infinity
  return lastInteractAt + intervalMs
}

// ---- 番茄钟（M5-1）：25min 专注 + 5min 休息，循环；默认关 ----
export const POMODORO_FOCUS_MS = 25 * 60_000
export const POMODORO_BREAK_MS = 5 * 60_000

/**
 * 番茄钟步进（纯函数状态机）。
 * @param {{ phase: 'off'|'focus'|'break', endsAt: number }} state 当前态
 * @param {number} now 当前时刻
 * @param {{ focusMs?: number, breakMs?: number }} [cfg]
 * @returns {{ phase: 'off'|'focus'|'break', endsAt: number, fired: null|'focus-end'|'break-end' }}
 *   fired：本步进跨过的边沿（气泡播报用）；phase='off' 恒 fired=null。
 */
export function tickPomodoro(state, now, cfg = {}) {
  const focusMs = Number.isFinite(cfg.focusMs) ? cfg.focusMs : POMODORO_FOCUS_MS
  const breakMs = Number.isFinite(cfg.breakMs) ? cfg.breakMs : POMODORO_BREAK_MS
  const phase = state?.phase ?? 'off'
  if (phase === 'off') return { phase: 'off', endsAt: 0, fired: null }
  const endsAt = Number.isFinite(state?.endsAt) ? state.endsAt : 0
  if (now < endsAt) return { phase, endsAt, fired: null }
  if (phase === 'focus') {
    return { phase: 'break', endsAt: now + breakMs, fired: 'focus-end' }
  }
  return { phase: 'focus', endsAt: now + focusMs, fired: 'break-end' }
}

// ---- 随机情景短剧（M5-3）：内置台词库 + 几十分钟级随机间隔 ----
/** 短剧默认间隔：40–80min 随机（几十分钟级）。 */
export const SKIT_MIN_INTERVAL_MS = 40 * 60_000
export const SKIT_MAX_INTERVAL_MS = 80 * 60_000

/** 内置台词库（32 条，鲸鱼娘口吻；触发时随机抽取、避免连续重复）。 */
export const SKIT_LINES = Object.freeze([
  '今天也想变成更厉害的鲸鱼娘…（摇尾巴）',
  '唔…Token 会不会被我偷吃太多呀？',
  '大海的那边是什么呢？是更多的需求单吗…',
  '呼啊——伸展一下鱼鳍，继续加油！',
  '悄悄说：你刚才写的代码很漂亮哦。',
  '（吐泡泡）咕噜咕噜…有什么我能帮忙的吗？',
  '困了的话，鲸鱼娘可以唱歌给你听哦…啊呜。',
  '你看你看，我学会新姿势了！（转圈）',
  '海洋垃圾要分类，代码垃圾要重构～',
  '刚才那个报错，我已经帮你记仇了。',
  '今天的浪花也很咸…啊不对，是海的气味！',
  '休息一下下也没关系的，海豚都这么说。',
  '鲸鱼娘的肚皮可以摸，但要小心我打滚。',
  '任务清单像鱼群一样游来游去…抓住一条！',
  '（背对着你假装看海）才没有在等你夸我。',
  '咕嘟…刚喝了口海水，有点咸到皱眉。',
  '你敲键盘的样子，像在给海面打节拍。',
  '今天的风浪级别：适合摸鱼（小声）。',
  '偷偷告诉你：吐泡泡其实是我在练特技。',
  '要是累了就看看我，我可是很治愈的！',
  '鲸鱼的心跳一分钟只有八次…但我为你跳很快！',
  '呜哇，时光过得好快，又到整点报时…才怪。',
  '（认真脸）深海的压力，也压不过你的耐心。',
  '默默把你的咖啡杯想象成小船…航行吧！',
  '今晚的月亮会掉进海里吗？鲸鱼娘帮你接住。',
  '尾巴拍水！啪叽——这是本鲸的问候方式。',
  '数据像洋流一样流过，而你驾驭着它们。',
  '（嘴里含着小鱼干说话）偶界四鲸鱼娘啦！',
  '别怕 bug，它们只是迷路的小虾米。',
  '鲸鱼娘立正！报告：今天也要元气满满！',
  '要是海里也有 Wi-Fi，我想给你发好多泡泡消息。',
  '（打哈欠）海浪的声音…是最温柔的摇篮曲…',
])

/**
 * 抽一条短剧台词（避免与上次重复）。
 * @param {number[]|null} [avoid] 应尽量避开的索引（上次抽中的）
 * @param {() => number} [random]
 * @returns {{ index: number, text: string }}
 */
export function pickSkit(avoid = null, random = Math.random) {
  const lines = SKIT_LINES
  if (lines.length === 0) return { index: -1, text: '' }
  const banned = new Set(Array.isArray(avoid) ? avoid : [])
  const pool = lines.length > banned.size
    ? lines.map((_, i) => i).filter((i) => !banned.has(i))
    : lines.map((_, i) => i)
  const index = pool[Math.floor(random() * pool.length) % pool.length]
  return { index, text: lines[index] }
}

/** 下次短剧时刻（随机间隔，几十分钟级）。 */
export function nextSkitAt({ now, random = Math.random, minMs = SKIT_MIN_INTERVAL_MS, maxMs = SKIT_MAX_INTERVAL_MS }) {
  const lo = Number.isFinite(minMs) && minMs > 0 ? minMs : SKIT_MIN_INTERVAL_MS
  const hi = Number.isFinite(maxMs) && maxMs >= lo ? maxMs : lo
  return now + lo + random() * (hi - lo)
}

// ---- 散步门控（M5-4）：设置开关 + 静音段禁用（拖拽禁用在 main.mjs 已有）----
/**
 * 本帧是否允许武装散步节奏器。
 * @param {{ enabled?: boolean, nightMute?: boolean, dragging?: boolean }} input
 */
export function walkAllowed({ enabled = true, nightMute = false, dragging = false } = {}) {
  return enabled !== false && nightMute !== true && dragging !== true
}

// ---- 深夜兜底视觉（M5-2）：静音段内 idle 显示 night（深夜困倦）----
/**
 * 静音段内的兜底视觉替换：仅作用于 idle 兜底行；其余状态镜像（think/wait/celebrate/error）
 * 照常——深夜静音约束的是主动行为面，不是状态镜像职责本身。
 * @param {string} next 本帧 selectState 结果
 * @param {boolean} nightMute 当前是否处于深夜静音段
 * @returns {string}
 */
export function nightVisualState(next, nightMute) {
  return nightMute === true && next === 'idle' ? 'night' : next
}
