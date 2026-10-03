// 节日换装（二期 §2.3 / §5）：公历日期 → 节日素材（春节/中秋查表，万圣/圣诞公历直判）+
// idle 兜底视觉覆盖合成（gamePose > night > balanceLowPose > festival > weather > idle）。
// 全部纯函数：零 DOM / 零定时器 / 零 fetch，无内部时钟——日期一律由调用方传入；
// node --test 可直测。宿主接线：main.mjs 每 tick 用 idleOverlayVisual 替换
// care.mjs nightVisualState 调用点（main.mjs:480，care.mjs 本体不改，§11 步骤 2）。
// 深夜红线口径：festival/weather 属视觉面（同状态镜像语义，深夜不受限，§0）；
// night 兜底优先级高于二者，且「仅 idle 行替换、非 idle 原样」与 nightVisualState
//（care.mjs:175-177）逐字一致，可直接作为其超集替换。

// ---- 节日 id 与文案（对齐素材 festival-{spring,christmas,halloween,mid-autumn}）----
/** 节日短 id 集合（festivalOf 返回值；素材状态 id = `festival-<id>`）。 */
export const FESTIVAL_IDS = Object.freeze(['spring', 'christmas', 'halloween', 'mid-autumn'])

/** 节日短 id → 展示文案（气泡/工具提示用；§5 label 列 + 万圣/圣诞惯用中文名）。 */
export const FESTIVAL_LABELS = Object.freeze({
  spring: '春节',
  christmas: '圣诞节',
  halloween: '万圣节',
  'mid-autumn': '中秋节',
})

// ---- 农历节日查表（2026–2030，冻结）----
/**
 * 农历节日（春节 / 中秋节）公历日期查表，键 'YYYY-MM-DD' → 节日短 id。
 * 表外年份一律回退 null（固定契约原文：农历节日「只用查表」，不内置农历换算）。
 *
 * 日期来源（phase2-plan §5，2026-10-02 检索核实）：
 * - 2026/2027 四条：musume 查表双印证（refs/dsh-whale-musume assets/whale-moe-core.js:1664-1667）；
 * - 2028–2030 六条：Wikipedia《Chinese New Year》/《Mid-Autumn Festival》＋ ChinaHighlights /
 *   TravelChinaGuide / Time and Date（2026-10-02 检索；Wikipedia/ChinaHighlights 2026-10-02
 *   检索 + musume 表 2026/2027 双印证）。逐条：2028 春节 01-26（周三，猴年）、2029 春节
 *   02-13（周二，鸡年）、2030 春节 02-03（周日，狗年；RMG 一源把 02-02 除夕误作初一，不采用）、
 *   2028 中秋 10-03（周二，与国庆相连）、2029 中秋 09-22（周六）、2030 中秋 09-12（周四）。
 */
export const FESTIVAL_LUNAR_TABLE = Object.freeze({
  '2026-02-17': 'spring',
  '2027-02-06': 'spring',
  '2028-01-26': 'spring',
  '2029-02-13': 'spring',
  '2030-02-03': 'spring',
  '2026-09-25': 'mid-autumn',
  '2027-09-15': 'mid-autumn',
  '2028-10-03': 'mid-autumn',
  '2029-09-22': 'mid-autumn',
  '2030-09-12': 'mid-autumn',
})

/** 公历节日直判（musume festivalKey whale-moe-core.js:1676-1677 同款；其 02-14 valentine 无素材，不采用）。 */
const GREGORIAN_FESTIVALS = Object.freeze([
  { month: 10, day: 31, id: 'halloween' },
  { month: 12, day: 25, id: 'christmas' },
])

/** 严格 'YYYY-MM-DD'（补零）格式；其余字符串形态一律视为非法。 */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * y/m/d → 归一化表键；用 UTC 构造回读校验非法日历日（02-30、非闰年 02-29、月/日为 0 等）。
 * @returns {string|null}
 */
function ymdKey(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Date → 本地日历日键（桌宠节日按用户本地时区；与 care.mjs/campus 的本地 getHours 口径一致）。 */
function localYmdKey(date) {
  return ymdKey(date.getFullYear(), date.getMonth() + 1, date.getDate())
}

function festivalResult(id) {
  return Object.freeze({ id, label: FESTIVAL_LABELS[id] })
}

/**
 * 日期 → 节日换装（纯函数）。
 * @param {Date|number|string} date Date 对象 / 时间戳（均按本地日历日）/ 'YYYY-MM-DD'（严格补零格式）
 * @returns {{ id: 'spring'|'christmas'|'halloween'|'mid-autumn', label: string }|null}
 *   命中节日 → 冻结 { id, label }（id 为短 id，素材状态 id = `festival-<id>`）；
 *   非节日 / 表外年份（农历）/ 闰年之外的非法日期 / 任何非法输入 → null。
 */
export function festivalOf(date) {
  let key = null
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) return null
    key = localYmdKey(date)
  } else if (typeof date === 'number') {
    if (!Number.isFinite(date)) return null
    key = localYmdKey(new Date(date))
  } else if (typeof date === 'string') {
    const m = DATE_RE.exec(date)
    if (m === null) return null
    key = ymdKey(Number(m[1]), Number(m[2]), Number(m[3]))
  } else {
    return null
  }
  if (key === null) return null
  const fromTable = FESTIVAL_LUNAR_TABLE[key]
  if (fromTable !== undefined) return festivalResult(fromTable)
  for (const g of GREGORIAN_FESTIVALS) {
    if (Number(key.slice(5, 7)) === g.month && Number(key.slice(8, 10)) === g.day) {
      return festivalResult(g.id)
    }
  }
  return null
}

// ---- idle 兜底视觉覆盖合成（§2.3）----
/** weather 短 id 集合（§6；clear 无素材语义 = 不换装，天然不在集合内）。 */
const WEATHER_IDS = Object.freeze(['rain', 'snow', 'thunder', 'umbrella', 'cold'])

/** 非空字符串 → 原样；其余（空串/undefined/null/非字符串）→ null（视为未设置）。 */
function overlayId(v) {
  return typeof v === 'string' && v !== '' ? v : null
}

/**
 * festivalId 归一化：'spring' / 'festival-spring' 双形态 → 短 id；未知/空 → null（落空到下一级）。
 * 兼容两种接线写法（festivalOf().id 短 id 与素材全 id），输出统一归一，杜绝双源漂移。
 */
function normFestivalId(v) {
  const id = overlayId(v)
  if (id === null) return null
  const short = id.startsWith('festival-') ? id.slice('festival-'.length) : id
  return Object.hasOwn(FESTIVAL_LABELS, short) ? short : null
}

/**
 * weatherId 归一化：'rain' / 'weather-rain' 双形态 → 短 id；'clear'/'weather-clear' 与未知 → null
 * （clear = 不换装，§6；未知码不牵强映射）。
 */
function normWeatherId(v) {
  const id = overlayId(v)
  if (id === null) return null
  const short = id.startsWith('weather-') ? id.slice('weather-'.length) : id
  return short === 'clear' ? null : (WEATHER_IDS.includes(short) ? short : null)
}

/**
 * idle 兜底视觉覆盖合成（纯函数，替代 care.mjs nightVisualState 的超集）。
 *
 * - next !== 'idle' → 原样返回：不覆盖交互/镜像态（固定契约原文；与 nightVisualState 一致）；
 * - 优先级：gamePose（游戏会话中）> night（深夜兜底）> balanceLowPose（余额提醒伴随姿势）>
 *   festival > weather > idle。
 *
 * opts（全部可缺省）：
 * - nightMute        当前是否深夜静音段（沿用 care.mjs 语义：严格 === true 才生效）；
 * - gamePose         game.mjs gamePose(phase) 的产物（'game-think' 等素材状态 id，原样输出）；
 * - balanceLowPose   main.mjs 每帧算好的 'balance-low' | null（余额提醒窗口内非 null）；
 * - festivalId       festivalOf(date)?.id（'spring' 等短 id；亦容忍 'festival-spring' 全 id）；
 * - weatherId        resolveWeatherId 结果（'rain' 等短 id；'clear' = 不换装；亦容忍 'weather-*' 全 id）。
 *
 * 说明：余额提醒只在非深夜触发（提醒面深夜静默），与 night 实际互斥；night 排其前只影响
 * 不可达序列，festival > weather 的固定契约序在其下保持不变。festival/weather 属视觉面，
 * 深夜静音段不受限——但 nightMute 命中时 night 优先级更高，兜底仍显示 night。
 *
 * @param {string} next 本帧 selectState 结果
 * @param {{ nightMute?: boolean, gamePose?: string|null, balanceLowPose?: string|null,
 *           festivalId?: string|null, weatherId?: string|null }} [opts]
 * @returns {string} 素材状态 id（'night'/'balance-low'/'festival-*'/'weather-*'/gamePose/原值）
 */
export function idleOverlayVisual(next, opts) {
  if (next !== 'idle') return next // 非 idle（交互/镜像态）原样——固定契约原文
  const o = opts ?? {}
  const gamePose = overlayId(o.gamePose)
  if (gamePose !== null) return gamePose
  if (o.nightMute === true) return 'night' // nightVisualState 语义：严格 === true
  const balanceLowPose = overlayId(o.balanceLowPose)
  if (balanceLowPose !== null) return balanceLowPose
  const festival = normFestivalId(o.festivalId)
  if (festival !== null) return `festival-${festival}`
  const weather = normWeatherId(o.weatherId)
  if (weather !== null) return `weather-${weather}`
  return 'idle' // 无覆盖 → 原 idle
}
