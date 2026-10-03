// 成长系统（phase2-② growth）：39 条成就 + 每日任务（3 槽、signin-1 恒在、当日幂等）+ 每周签到（7 天）。
// 纯逻辑零 DOM 零依赖：now/rng/storage 全部注入；除 createGrowth 外全是无状态纯函数，node --test 直测。
// 指标单一入口 ingest({ metric, amount[, pet] })——
//   · pet 快照指标 task/failure/session/activeMin/level/day：main.mjs 对 /api/whale-pet/state 的
//     pet 快照（lib/pet-state.mjs 账本，经 lib/index.mjs snapshot().pet 下发）做差分换算后喂入；
//     信号可携带最新 pet 快照（signal.pet），growth 缓存供成就谓词使用（不传则 pet 系成就暂不解锁，不报错）。
//   · 本地交互 pat/belly/tail/feed：热区点击 / 双击喂食事件；meme：表情包气泡弹出；
//     comeback：离开 ≥2h 回归；night-interact / night-work：main.mjs 按 care.mjs isNightMute
//     判定后喂入（本模块不 import care.mjs，保持零依赖可测）。
//   · 小游戏 game-play/game-win/game-draw/game-lose/game-combo/game-highscore：结算时喂入；
//     blob.game（highscore/playsToday/playsDay）由本模块独占维护，game.mjs 只读
//     （gameRewardAllowed(growthBlob, now) 是读视图，REWARDS_PER_DAY=3 的跨日重置与
//     结算好感发放门控都落在本模块）。
//   · signin 不需要外部喂：signinDaily 内部同步推进 signin-1 槽（外部重喂无害，进度被 target 钳制）。
// 成就清单/任务池/好感公式适配自 refs/dsh-whale-musume assets/whale-moe-core.js:476-730（MIT）；
// 39 条谓词逐条映射见 docs/phase2-plan.md §3，任务/签到状态机见 §4。
// blob（JSON, version 1）唯一写方 = 本模块；存储适配器 { load, save } 注入，默认接 localStorage
// （键 GROWTH_STORAGE_KEY，typeof 守卫，缺席/写失败退内存态）。

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 好感上限（musume whale-moe-core.js:476 同款）。 */
export const AFFINITY_MAX = 10000

/** 好感等级步长：等级 = max(1, floor(affinity / 500) + 1)（whale-moe-core.js:477 同款）。 */
export const LEVEL_STEP = 500

/** 默认本地持久化键（main.mjs 的 localStorage 适配器与内建默认适配器共用）。 */
export const GROWTH_STORAGE_KEY = 'whale-pet-growth-v1'

/** 一天 / 一小时的毫秒数（day1/7/30 与陪跑时长谓词用）。 */
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** 周签到里程碑奖励（phase2-plan §4.2：满 1/3/7 天各 +10/+20/+40）。 */
const WEEK_MILESTONE_REWARD = Object.freeze({ 1: 10, 3: 20, 7: 40 })

/** 小游戏结算好感（phase2-plan §7：win +12 / draw +3 / lose +0 / 破纪录另 +5）。 */
const GAME_RESULT_AFFINITY = Object.freeze({ 'game-win': 12, 'game-draw': 3, 'game-lose': 0 })
const GAME_RECORD_AFFINITY = 5

/**
 * 每日发好感奖励的局数上限（与 game.mjs GAME.REWARDS_PER_DAY=3 同值；本模块零依赖不 import）。
 * 结算好感（win/draw/破纪录）只在前 3 局发放，第 4 局起只记结算不记好感（§7「超出只显示结算」）；
 * 门控与跨日重置都落在本模块（§4.3 growth 每日结算一致性）。
 */
const GAME_REWARDS_PER_DAY = 3

/** counters 全字段（blob 归一化与 freshBlob 单源）。 */
const COUNTER_FIELDS = Object.freeze([
  'pat', 'belly', 'tail', 'feed',
  'gamePlays', 'gameWins', 'gameComboMax', 'gameHighscoreBreaks',
  'meme', 'balanceAlert', 'nightInteracts', 'nightWorks', 'comebacks',
  'questsClaimed', 'questAllDays',
])

/** ingest metric → counters 落点（game-draw/game-lose 无计数器，只发好感）。 */
const COUNTER_KEY_OF = Object.freeze({
  pat: 'pat',
  belly: 'belly',
  tail: 'tail',
  feed: 'feed',
  meme: 'meme',
  'balance-alert': 'balanceAlert',
  'night-interact': 'nightInteracts',
  'night-work': 'nightWorks',
  comeback: 'comebacks',
  'game-play': 'gamePlays',
  'game-win': 'gameWins',
})

// ---------------------------------------------------------------------------
// 小工具（全部纯函数，坏数据一律降级为安全值，不抛错）
// ---------------------------------------------------------------------------

/** 有限数字原样返回，其余按 0（成就/任务谓词的宽容取数）。 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Date|number → Date；非法输入兜底当前时刻（musume「非数字 → Date.now()」同口径）。 */
function toDate(now) {
  if (now instanceof Date) return Number.isNaN(now.getTime()) ? new Date() : now
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now)
  return new Date()
}

/** 本地日键 'YYYY-M-D'（不补零，musume dayKey whale-moe-core.js 同款；blob 内部比较用）。 */
function dayKey(now) {
  const d = toDate(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function clampAffinity(v) {
  return Math.max(0, Math.min(AFFINITY_MAX, num(v)))
}

/** 计数型指标分量：非法/缺省 → 1，负数与小数向下取整后夹非负。 */
function countAmount(amount) {
  if (typeof amount === 'number' && Number.isFinite(amount)) return Math.max(0, Math.floor(amount))
  return 1
}

/** 数值型指标分量（连击/得分）：非法 → 0，向下取整夹非负。 */
function scoreValue(amount) {
  return typeof amount === 'number' && Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0
}

function deepClone(blob) {
  return JSON.parse(JSON.stringify(blob))
}

// ---------------------------------------------------------------------------
// 39 条成就（docs/phase2-plan.md §3 逐条；id 沿用 musume，谓词适配本插件指标）
// ---------------------------------------------------------------------------

/** blob.counters 计数（缺字段/坏数据按 0）。 */
function cnt(blob, key) {
  return num(blob && blob.counters ? blob.counters[key] : 0)
}

/** pet 快照 stats 字段（缺快照按 0——pet 系成就不误解锁）。 */
function petStat(pet, key) {
  return num(pet && pet.stats ? pet.stats[key] : 0)
}

function petLevelOf(pet) {
  return num(pet ? pet.level : 0)
}

function streakOf(blob) {
  return num(blob && blob.signin ? blob.signin.streak : 0)
}

function weekFlag(blob, key) {
  return !!(blob && blob.weekSignin && blob.weekSignin[key] === true)
}

/** 距首次会话的天数（pet.stats.firstSeenAt 缺失或 now 非法 → -1，day 谓词恒 false）。 */
function daysSeen(pet, now) {
  const first = pet && pet.stats && Number.isFinite(pet.stats.firstSeenAt) ? pet.stats.firstSeenAt : null
  const t = now instanceof Date ? now.getTime() : now
  if (first === null || !Number.isFinite(t)) return -1
  return (t - first) / DAY_MS
}

function ach(id, icon, name, desc, test, affinity) {
  return Object.freeze({ id, icon, name, desc, test, reward: Object.freeze({ affinity }) })
}

/**
 * 成就定义表（冻结，恰好 39 条；顺序 = 展示与解锁判定顺序）。
 * test(blob, pet, now) 纯谓词：第三参 now 由 evaluateAchievements 透传
 * （day1/7/30 需要 now − pet.stats.firstSeenAt，phase2-plan §14）。
 */
export const ACHIEVEMENTS = Object.freeze([
  ach('first-pat', '🫳', '初次摸头', '第一次摸鲸鱼娘的头', (b) => cnt(b, 'pat') >= 1, 2),
  ach('ten-pats', '🖐️', '摸头十连', '累计摸头 10 次', (b) => cnt(b, 'pat') >= 10, 8),
  ach('hundred-pats', '💯', '摸头百连', '累计摸头 100 次', (b) => cnt(b, 'pat') >= 100, 30),
  ach('first-feed', '🍰', '投喂成功', '第一次投喂 TOKEN 鱼干', (b) => cnt(b, 'feed') >= 1, 5),
  ach('first-triple', '🎉', '三区全触', '头/肚/尾各摸一次', (b) => cnt(b, 'pat') >= 1 && cnt(b, 'belly') >= 1 && cnt(b, 'tail') >= 1, 10),
  ach('thanks', '🐟', '鱼干常客', '累计投喂 10 次 TOKEN 鱼干', (b) => cnt(b, 'feed') >= 10, 20),
  ach('lv5', '⭐', '五级同行', '资历等级达到 Lv5', (b, pet) => petLevelOf(pet) >= 5, 50),
  ach('lv10', '👑', '十级羁绊', '资历等级达到 Lv10', (b, pet) => petLevelOf(pet) >= 10, 150),
  ach('signin3', '📅', '常客', '连续签到 3 天', (b) => streakOf(b) >= 3, 10),
  ach('signin7', '🗓️', '一周之约', '连续签到 7 天', (b) => streakOf(b) >= 7, 30),
  ach('night-owl', '🌙', '深夜陪伴', '深夜静音段内发生一次本地交互', (b) => cnt(b, 'nightInteracts') >= 1, 8),
  ach('comeback', '👋', '欢迎回来', '离开 2 小时以上后回来', (b) => cnt(b, 'comebacks') >= 1, 8),
  ach('day1', '💞', '一日之缘', '鲸鱼娘陪伴满 1 天', (b, pet, now) => daysSeen(pet, now) >= 1, 20),
  ach('day7', '💎', '一周相伴', '鲸鱼娘陪伴满 7 天', (b, pet, now) => daysSeen(pet, now) >= 7, 80),
  ach('day30', '🏛️', '三十日契约', '鲸鱼娘陪伴满 30 天', (b, pet, now) => daysSeen(pet, now) >= 30, 400),
  ach('first-tool', '🛠️', '开工啦', '第一次会话开工', (b, pet) => petStat(pet, 'sessions') >= 1, 5),
  ach('tools-10', '🔧', '会话十连', '累计 10 次会话', (b, pet) => petStat(pet, 'sessions') >= 10, 20),
  ach('tools-50', '🏭', '会话五十连', '累计 50 次会话', (b, pet) => petStat(pet, 'sessions') >= 50, 60),
  ach('tools-100', '🛰️', '会话百连', '累计 100 次会话', (b, pet) => petStat(pet, 'sessions') >= 100, 120),
  ach('first-code', '💻', '陪跑十小时', '累计陪伴时长满 10 小时', (b, pet) => petStat(pet, 'activeMs') >= 10 * HOUR_MS, 10),
  ach('code-20', '📟', '陪跑五十小时', '累计陪伴时长满 50 小时', (b, pet) => petStat(pet, 'activeMs') >= 50 * HOUR_MS, 50),
  ach('first-success', '✅', '旗开得胜', '第一次任务交付完成', (b, pet) => petStat(pet, 'tasksDone') >= 1, 8),
  ach('success-10', '🏆', '任务十连', '累计 10 次任务交付', (b, pet) => petStat(pet, 'tasksDone') >= 10, 25),
  ach('first-failure', '🩹', '初次翻车', '第一次任务报错（只解锁，不扣任何值）', (b, pet) => petStat(pet, 'failures') >= 1, 5),
  ach('fail-10', '🚑', '翻车十连', '累计 10 次任务报错', (b, pet) => petStat(pet, 'failures') >= 10, 20),
  ach('messages-100', '💌', '半百交付', '累计 50 次任务交付', (b, pet) => petStat(pet, 'tasksDone') >= 50, 60),
  ach('messages-500', '📚', '双百老搭档', '累计 200 次任务交付', (b, pet) => petStat(pet, 'tasksDone') >= 200, 150),
  ach('keyword-master', '🔍', '表情包达人', '表情包气泡弹出 10 次', (b) => cnt(b, 'meme') >= 10, 8),
  ach('night-work', '🦉', '深夜赶工', '深夜静音段内会话仍在跑（thinking 事实出现）', (b) => cnt(b, 'nightWorks') >= 1, 12),
  ach('balance-low', '🪙', '余额告急', '触发一次余额不足提醒', (b) => cnt(b, 'balanceAlert') >= 1, 10),
  ach('game-first', '🫧', '初次开玩', '第一次结算一局泡泡小游戏', (b) => cnt(b, 'gamePlays') >= 1, 5),
  ach('game-win', '👑', '泡泡之王', '拿下一局胜利（单局得分 ≥ 300）', (b) => cnt(b, 'gameWins') >= 1, 12),
  ach('game-combo10', '🔥', '连击达人', '单局最高连击达到 10', (b) => cnt(b, 'gameComboMax') >= 10, 12),
  ach('game-highscore', '🏆', '纪录刷新', '打破一次历史最高分', (b) => cnt(b, 'gameHighscoreBreaks') >= 1, 5),
  ach('quest-first', '🎯', '任务初体验', '完成领取第一个每日任务', (b) => cnt(b, 'questsClaimed') >= 1, 8),
  ach('quest-all', '🎟️', '一日全勤', '单日 3 个每日任务全部领取', (b) => cnt(b, 'questAllDays') >= 1, 20),
  ach('week-signin7', '🏆', '周常满勤', '本周签到板集满 7 格', (b) => weekFlag(b, 'rewarded7'), 30),
  ach('bond-action', '🌟', '新动作解锁', '好感等级达到 Lv3', (b) => affinityLevel(num(b ? b.affinity : 0)) >= 3, 0),
  ach('bond-badge', '🎖️', '称号首解锁', '好感等级达到 Lv5', (b) => affinityLevel(num(b ? b.affinity : 0)) >= 5, 0),
])

const ACHIEVEMENT_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]))

/**
 * 好感等级（musume whale-moe-core.js level 公式同款）：max(1, floor(affinity/500)+1)。
 * @param {number} affinity 好感值（非法按 0）
 * @returns {number} 1 起（10000 封顶 → Lv21）
 */
export function affinityLevel(affinity) {
  return Math.max(1, Math.floor(Math.max(0, num(affinity)) / LEVEL_STEP) + 1)
}

/**
 * 幂等解锁判定（musume evaluateAchievements whale-moe-core.js:593-603 的 39 条泛化）：
 * have 集合去重，返回本次新解锁的成就 id 数组（表顺序，确定性）；单条谓词抛错按未达成处理。
 * @param {object|null} blob 成长 blob（读 counters/signin/weekSignin/achievements/affinity）
 * @param {object|null} pet /api/whale-pet/state 的 pet 快照 { level, stats{...} }，可 null
 * @param {Date|number} now 当前时刻（必传：day1/7/30 谓词需要）
 * @returns {string[]} 新解锁成就 id（无则空数组）
 */
export function evaluateAchievements(blob, pet, now) {
  const have = new Set(blob && Array.isArray(blob.achievements) ? blob.achievements : [])
  const out = []
  for (const def of ACHIEVEMENTS) {
    if (have.has(def.id)) continue
    let ok = false
    try {
      ok = def.test(blob, pet, now) === true
    } catch {
      ok = false
    }
    if (ok) out.push(def.id)
  }
  return out
}

// ---------------------------------------------------------------------------
// 每日任务（3 槽，signin-1 恒在、当日幂等；phase2-plan §4.1）
// ---------------------------------------------------------------------------

function quest(id, desc, metric, target, affinity, always) {
  const def = { id, desc, metric, target, reward: Object.freeze({ affinity }) }
  if (always) def.always = true
  return Object.freeze(def)
}

/**
 * 每日任务池（冻结 6 条，结构对齐 musume whale-moe-core.js:607-614；
 * musume 的 messages/tool 类任务已适配为本插件指标 task/activeMin/game-play）。
 */
export const QUEST_POOL = Object.freeze([
  quest('signin-1', '今日签到', 'signin', 1, 6, true),
  quest('task-1', '完成 1 次任务交付', 'task', 1, 8),
  quest('pat-3', '摸头 3 次', 'pat', 3, 8),
  quest('feed-1', '投喂一次 TOKEN 鱼干', 'feed', 1, 6),
  quest('active-15', '陪伴 15 分钟', 'activeMin', 15, 8),
  quest('game-1', '玩一局泡泡小游戏', 'game-play', 1, 8),
])

const QUEST_BY_ID = new Map(QUEST_POOL.map((q) => [q.id, q]))

/**
 * 任务槽刷新：同日（date 相同且 3 槽完好）原样返回（当日幂等）；跨日重抽——
 * 槽 1 恒为 signin-1，槽 2/3 从其余池抽 2（尽量避开昨日 picks，池不足放开——
 * musume whale-moe-core.js:628-649 同款）。
 * @param {object|null} prev 旧 quests { date, slots[3], allClaimed }
 * @param {Date|number} now 注入时钟
 * @param {() => number} [rng] 注入随机源（缺省 Math.random；返回值会被夹取到池下标范围内）
 * @returns {{ date: string, slots: Array<{id, progress, claimed}>, allClaimed: boolean }}
 */
export function refreshQuests(prev, now, rng) {
  const today = dayKey(now)
  if (prev && prev.date === today && Array.isArray(prev.slots) && prev.slots.length === 3) return prev
  const picks = []
  const pool = QUEST_POOL.slice()
  for (let i = 0; i < pool.length; i += 1) {
    if (pool[i].always) {
      picks.push(pool[i])
      pool.splice(i, 1)
      break
    }
  }
  const prevIds = prev && Array.isArray(prev.slots) ? prev.slots.map((s) => (s && s.id) || null) : []
  const fresh = pool.filter((q) => prevIds.indexOf(q.id) === -1)
  const source = fresh.length >= 2 ? fresh : pool
  while (picks.length < 3 && source.length > 0) {
    const r = typeof rng === 'function' ? rng() : Math.random()
    const idx = Math.min(source.length - 1, Math.max(0, Math.floor(r * source.length)))
    picks.push(source.splice(idx, 1)[0])
  }
  return {
    date: today,
    slots: picks.map((q) => ({ id: q.id, progress: 0, claimed: false })),
    allClaimed: false,
  }
}

/**
 * ingest 单信号推进：命中槽 progress = min(target, progress + amount)（永不超 target；
 * 已领取槽不再累计；amount ≤ 0 不推进；非有限数（NaN/±Infinity）与缺省一律按 1 推进）。
 * completed 为**本次新达到可领取**的槽 id（边沿语义，供「任务完成可领取」气泡去重；
 * 持续可领取但不重复上报——与 musume 的全量可领取集不同，见集成摘要）。
 * @param {object|null} prev 旧 quests
 * @param {{ metric: string, amount?: number }} signal ingest 信号（metric 与槽定义按名匹配）
 * @param {Date|number} now 注入时钟（跨日时先走 refreshQuests）
 * @param {() => number} [rng] 注入随机源
 * @returns {{ quests: object, completed: string[] }} quests=新 quests；completed=本次新达可领取的槽 id
 */
export function computeQuests(prev, signal, now, rng) {
  const quests = refreshQuests(prev, now, rng)
  const metric = signal && typeof signal.metric === 'string' ? signal.metric : null
  const amount = signal && typeof signal.amount === 'number' && Number.isFinite(signal.amount) ? signal.amount : 1
  if (metric === null || !(amount > 0)) return { quests, completed: [] }
  const wasClaimable = new Set(
    quests.slots
      .filter((slot) => {
        const def = QUEST_BY_ID.get(slot && slot.id)
        return def && slot.progress >= def.target && !slot.claimed
      })
      .map((slot) => slot.id),
  )
  const slots = quests.slots.map((slot) => {
    const def = QUEST_BY_ID.get(slot && slot.id)
    if (!def || slot.claimed || def.metric !== metric) return slot
    return { id: slot.id, progress: Math.min(def.target, num(slot.progress) + amount), claimed: slot.claimed }
  })
  const completed = []
  for (const slot of slots) {
    const def = QUEST_BY_ID.get(slot.id)
    if (def && slot.progress >= def.target && !slot.claimed && !wasClaimable.has(slot.id)) completed.push(slot.id)
  }
  return { quests: { date: quests.date, slots, allClaimed: quests.allClaimed }, completed }
}

/**
 * 单次幂等领取（纯函数；跨日刷新由组装层先做 refreshQuests）：未满不可领、重复领取无效果；
 * 第三槽领完 → allClaimed 置位且 newlyAll 边沿为 true（成就 quest-all / 气泡用）。
 * @param {object|null} quests quests { date, slots, allClaimed }
 * @param {string} id 槽 id
 * @returns {{ quests: object, claimed: boolean, newlyAll: boolean, reward: {affinity}|null }}
 */
export function claimQuest(quests, id) {
  const slots = quests && Array.isArray(quests.slots) ? quests.slots : []
  let didClaim = false
  const nextSlots = slots.map((slot) => {
    if (!slot || slot.id !== id || slot.claimed) return slot
    const def = QUEST_BY_ID.get(slot.id)
    if (!def || num(slot.progress) < def.target) return slot
    didClaim = true
    return { id: slot.id, progress: slot.progress, claimed: true }
  })
  if (!didClaim) return { quests, claimed: false, newlyAll: false, reward: null }
  const allClaimed = nextSlots.length > 0 && nextSlots.every((s) => s && s.claimed === true)
  const def = QUEST_BY_ID.get(id)
  return {
    quests: {
      date: quests.date,
      slots: nextSlots,
      allClaimed: (quests.allClaimed === true) || allClaimed,
    },
    claimed: true,
    newlyAll: allClaimed && quests.allClaimed !== true,
    reward: def ? def.reward : null,
  }
}

// ---------------------------------------------------------------------------
// 每周签到（7 天，周一基准；phase2-plan §4.2）
// ---------------------------------------------------------------------------

/**
 * 周一基准周键 'YYYY-M-D'（musume weekKey whale-moe-core.js:691-696 同款：周一 0 点起算）。
 * @param {Date|number} now 注入时钟
 */
export function weekKey(now) {
  const d = toDate(now)
  const sinceMonday = (d.getDay() + 6) % 7 // Monday=0
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday)
  return `${monday.getFullYear()}-${monday.getMonth() + 1}-${monday.getDate()}`
}

/**
 * 7 格签到板推进（纯函数）：days 并入今天（去重）；里程碑按序自动结算、一次调用至多一个；
 * 跨周（week 键变化）整板重置。奖励入账由组装层按 milestoneHit 执行。
 * @param {object|null} prev 旧 weekSignin { week, days[], rewarded1, rewarded3, rewarded7 }
 * @param {Date|number} now 注入时钟
 * @returns {{ weekSignin: object, milestoneHit: '1'|'3'|'7'|null }}
 */
export function computeWeekSignin(prev, now) {
  const wk = weekKey(now)
  const sameWeek = !!(prev && prev.week === wk)
  // days 是日期键集合（去重；与 normalizeBlob 加载边界同口径）：畸形 prev 直调时
  // 重复日字符串不得虚增 days.length 提前触发里程碑（计划 §4.2「days 并入今天（去重）」）。
  const days = []
  if (sameWeek && Array.isArray(prev.days)) {
    for (const d of prev.days) {
      if (typeof d === 'string' && days.indexOf(d) === -1) days.push(d)
    }
  }
  let rewarded1 = sameWeek ? prev.rewarded1 === true : false
  let rewarded3 = sameWeek ? prev.rewarded3 === true : false
  let rewarded7 = sameWeek ? prev.rewarded7 === true : false
  const day = dayKey(now)
  if (days.indexOf(day) === -1) days.push(day)
  let milestoneHit = null
  if (!rewarded1 && days.length >= 1) {
    rewarded1 = true
    milestoneHit = '1'
  } else if (!rewarded3 && days.length >= 3) {
    rewarded3 = true
    milestoneHit = '3'
  } else if (!rewarded7 && days.length >= 7) {
    rewarded7 = true
    milestoneHit = '7'
  }
  return { weekSignin: { week: wk, days, rewarded1, rewarded3, rewarded7 }, milestoneHit }
}

/**
 * 每日签到（纯函数）：当日幂等（同日重复签到 first=false、streak 不动）；
 * 昨日签过 → streak+1，断签（含首签）→ 1。昨日按日历日回退（与 weekKey 同口径，
 * DST 切换日的 23/25 小时日不做 24h 减法、不误判断签）。周签到板/任务槽由组装层接力。
 * @param {object|null} blob 成长 blob（读 signin）
 * @param {Date|number} now 注入时钟
 * @returns {{ blob: object, first: boolean }} blob=仅 signin 字段更新的新 blob
 */
export function signinDaily(blob, now) {
  const today = dayKey(now)
  const prev = blob && blob.signin ? blob.signin : {}
  const lastDate = typeof prev.lastDate === 'string' ? prev.lastDate : ''
  const prevStreak = Math.max(0, Math.floor(num(prev.streak)))
  if (lastDate === today) {
    return { blob: { ...blob, signin: { lastDate, streak: prevStreak } }, first: false }
  }
  const d = toDate(now)
  const yesterday = dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1))
  const streak = lastDate === yesterday ? prevStreak + 1 : 1
  return { blob: { ...blob, signin: { lastDate: today, streak } }, first: true }
}

// ---------------------------------------------------------------------------
// blob 形状与归一化（JSON, version 1；坏数据逐字段纠正，等价 settings 的 .check 语义）
// ---------------------------------------------------------------------------

function freshBlob() {
  const counters = {}
  for (const k of COUNTER_FIELDS) counters[k] = 0
  return {
    version: 1,
    affinity: 0,
    achievements: [],
    counters,
    signin: { lastDate: '', streak: 0 },
    quests: { date: '', slots: [], allClaimed: false },
    weekSignin: { week: '', days: [], rewarded1: false, rewarded3: false, rewarded7: false },
    game: { highscore: 0, playsToday: 0, playsDay: '' },
    updatedAt: 0,
  }
}

/**
 * 任意 load() 产物 → 合法 blob：未知/坏类型字段纠正回默认，数值夹非负有限，
 * 成就 id 去重（保留未知字符串 id 以防降级丢数据，谓词只查已知 id）。
 */
function normalizeBlob(raw) {
  const blob = freshBlob()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return blob
  if (typeof raw.affinity === 'number' && Number.isFinite(raw.affinity)) {
    blob.affinity = clampAffinity(raw.affinity)
  }
  if (Array.isArray(raw.achievements)) {
    const seen = new Set()
    for (const id of raw.achievements) {
      if (typeof id === 'string' && !seen.has(id)) {
        seen.add(id)
        blob.achievements.push(id)
      }
    }
  }
  const rc = raw.counters
  if (rc && typeof rc === 'object' && !Array.isArray(rc)) {
    for (const k of COUNTER_FIELDS) {
      const v = rc[k]
      if (typeof v === 'number' && Number.isFinite(v)) {
        blob.counters[k] = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(v)))
      }
    }
  }
  const rs = raw.signin
  if (rs && typeof rs === 'object' && !Array.isArray(rs)) {
    if (typeof rs.lastDate === 'string') blob.signin.lastDate = rs.lastDate
    if (typeof rs.streak === 'number' && Number.isFinite(rs.streak)) {
      blob.signin.streak = Math.min(100000, Math.max(0, Math.floor(rs.streak)))
    }
  }
  const rq = raw.quests
  if (rq && typeof rq === 'object' && !Array.isArray(rq)) {
    if (typeof rq.date === 'string') blob.quests.date = rq.date
    if (rq.allClaimed === true) blob.quests.allClaimed = true
    if (Array.isArray(rq.slots)) {
      for (const slot of rq.slots.slice(0, 3)) {
        if (slot && typeof slot.id === 'string' && QUEST_BY_ID.has(slot.id)) {
          blob.quests.slots.push({
            id: slot.id,
            progress: typeof slot.progress === 'number' && Number.isFinite(slot.progress) ? Math.max(0, slot.progress) : 0,
            claimed: slot.claimed === true,
          })
        }
      }
    }
  }
  const rw = raw.weekSignin
  if (rw && typeof rw === 'object' && !Array.isArray(rw)) {
    if (typeof rw.week === 'string') blob.weekSignin.week = rw.week
    if (Array.isArray(rw.days)) {
      for (const d of rw.days) {
        if (typeof d === 'string' && blob.weekSignin.days.indexOf(d) === -1) blob.weekSignin.days.push(d)
      }
    }
    blob.weekSignin.rewarded1 = rw.rewarded1 === true
    blob.weekSignin.rewarded3 = rw.rewarded3 === true
    blob.weekSignin.rewarded7 = rw.rewarded7 === true
  }
  const rg = raw.game
  if (rg && typeof rg === 'object' && !Array.isArray(rg)) {
    if (typeof rg.highscore === 'number' && Number.isFinite(rg.highscore)) blob.game.highscore = Math.max(0, rg.highscore)
    if (typeof rg.playsToday === 'number' && Number.isFinite(rg.playsToday)) blob.game.playsToday = Math.max(0, Math.floor(rg.playsToday))
    if (typeof rg.playsDay === 'string') blob.game.playsDay = rg.playsDay
  }
  if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) blob.updatedAt = raw.updatedAt
  return blob
}

// ---------------------------------------------------------------------------
// ingest 指标落点
// ---------------------------------------------------------------------------

/**
 * 每日奖励局门控：宿主结算顺序先喂 game-play（playsToday 已含本局），前 GAME_REWARDS_PER_DAY
 * 局发结算好感、第 4 局起不再发（计数/统计照记不受影响）。与 game.mjs gameRewardAllowed
 * 读视图同口径：开局前 playsToday < 上限 ⇔ 本局结算时 playsToday ≤ 上限。
 */
function gameRewardDue(blob) {
  return blob.game.playsToday <= GAME_REWARDS_PER_DAY
}

/**
 * 把一条 ingest 信号落到 blob 的 counters/game/affinity 上（任务槽推进由 computeQuests 统一处理）。
 * game-combo 取 max（不回退）；game-highscore 严格 > 才算破纪录（同分不计数）并即时 +5 好感（§7）。
 * 结算好感（win/draw/破纪录 +5）受 gameRewardDue 每日奖励局门控：前 3 局发放、之后只记结算。
 */
function applyMetric(blob, signal, t) {
  const metric = signal.metric
  if (metric === 'game-combo') {
    const v = scoreValue(signal.amount)
    if (v > blob.counters.gameComboMax) blob.counters.gameComboMax = v
    return
  }
  if (metric === 'game-highscore') {
    const v = scoreValue(signal.amount)
    if (v > blob.game.highscore) {
      blob.game.highscore = v
      blob.counters.gameHighscoreBreaks += 1
      if (gameRewardDue(blob)) {
        blob.affinity = clampAffinity(blob.affinity + GAME_RECORD_AFFINITY)
      }
    }
    return
  }
  const counterKey = COUNTER_KEY_OF[metric]
  if (counterKey) {
    const n = countAmount(signal.amount)
    blob.counters[counterKey] += n
    if (metric === 'game-play') {
      const today = dayKey(t)
      if (blob.game.playsDay !== today) {
        blob.game.playsDay = today
        blob.game.playsToday = 0
      }
      blob.game.playsToday += n
    } else if (metric === 'game-win' && gameRewardDue(blob)) {
      blob.affinity = clampAffinity(blob.affinity + GAME_RESULT_AFFINITY['game-win'])
    }
    return
  }
  if (metric === 'game-draw') {
    // game-draw 无计数器落点，但结算好感 +3（§7，同样受每日奖励局门控）
    if (gameRewardDue(blob)) {
      blob.affinity = clampAffinity(blob.affinity + GAME_RESULT_AFFINITY['game-draw'])
    }
    return
  }
  if (metric === 'game-lose') return // lose +0（§7）：仅结算记录
  // 其余 metric（signin/task/failure/session/activeMin/level/day 与未知值）无计数器落点：
  // signin/task/activeMin 走任务槽（computeQuests 按名匹配），failure/session/level/day 为
  // 观察面占位（成就谓词直接读 pet 快照），未知 metric 静默忽略（降级不抛错）。
}

// ---------------------------------------------------------------------------
// 组装层（唯一有副作用的导出）
// ---------------------------------------------------------------------------

/** 内建默认存储：localStorage 可用则用之（读写均 try/catch），缺席退各实例独立的内存态。 */
function defaultStorage() {
  const hasLS = typeof localStorage !== 'undefined' && localStorage !== null
  let mem = null
  return {
    load() {
      if (!hasLS) return mem
      try {
        return JSON.parse(localStorage.getItem(GROWTH_STORAGE_KEY) ?? 'null')
      } catch {
        return null // 坏 JSON 按无数据处理（normalizeBlob 再兜一层）
      }
    },
    save(b) {
      if (!hasLS) {
        mem = deepClone(b)
        return
      }
      try {
        localStorage.setItem(GROWTH_STORAGE_KEY, JSON.stringify(b))
      } catch {
        /* 隐私模式/配额满：静默降级，内存态继续 */
      }
    },
  }
}

/**
 * 组装层：存储适配器注入（storage={load(),save(blob)}；缺省接 localStorage，缺席退内存态），
 * now/random 注入（缺省 Date.now/Math.random）。返回面 { ingest, signin, claimQuest, snapshot, dispose }，
 * 全程不抛错（存储读写失败静默），dispose 幂等（flush 兜底）；重复 createGrowth 各自独立，可重入。
 * load 抛错（自建适配器瞬态故障；默认 localStorage 适配器 load 恒不抛）→ 存储态未知：
 * 本实例禁写（persist 静默跳过），防 fresh 空 blob 覆写存储既有成长数据——内存态照常工作。
 * @param {{ storage?: {load: () => any, save: (b) => void}, now?: () => number, random?: () => number }} deps
 * @returns {{ ingest: (signal) => {unlocks, questCompleted}, signin: (now?) => {first, milestoneHit, milestoneReward, unlocks, questCompleted}, claimQuest: (id) => {claimed, newlyAll, reward, unlocks}, snapshot: () => object, dispose: () => void }}
 */
export function createGrowth({ storage, now, random } = {}) {
  const clock = typeof now === 'function' ? now : Date.now
  const rng = typeof random === 'function' ? random : Math.random
  const store = storage && typeof storage.load === 'function' && typeof storage.save === 'function'
    ? storage
    : defaultStorage()
  let cur = null
  let loaded = false
  let loadFailed = false // load 抛错 → 存储态未知：禁写保护（见 persist），实例内不自动解除
  let disposed = false
  let latestPet = null

  /**
   * 惰性加载 + 归一化（坏数据/抛错一律回 fresh）。
   * load 抛错与「读到的就是垃圾」不同：前者存储态未知（既有数据可能还在），后者是成功读取。
   */
  function state() {
    if (!loaded) {
      loaded = true
      let raw = null
      try {
        raw = store.load()
      } catch {
        raw = null
        loadFailed = true
      }
      cur = normalizeBlob(raw)
    }
    return cur
  }

  function persist() {
    if (loadFailed) return // fail-safe：从未成功读到存储 → 落盘=用 fresh 空档覆写未知存量（丢用户数据），静默跳过
    try {
      store.save(cur)
    } catch {
      /* 写失败静默：内存态继续，下次变更再试 */
    }
  }

  /** 解锁入账（含级联：奖励抬好感等级可能再解锁 bond-*，循环至稳定，上限=成就数防病态）。 */
  function grantAchievements(t) {
    const all = []
    for (let guard = 0; guard <= ACHIEVEMENTS.length; guard += 1) {
      const ids = evaluateAchievements(cur, latestPet, t)
      if (ids.length === 0) break
      for (const id of ids) {
        cur.achievements.push(id)
        const def = ACHIEVEMENT_BY_ID.get(id)
        if (def) cur.affinity = clampAffinity(cur.affinity + def.reward.affinity)
        all.push(id)
      }
    }
    return all
  }

  /**
   * 指标单一入口：counters/game 落点 → 任务槽推进 → 成就级联解锁 → 落盘。
   * signal 可带 pet（最新 /api/whale-pet/state 快照），缓存供 pet 系成就谓词使用。
   * @param {{ metric: string, amount?: number, pet?: object }} signal
   * @returns {{ unlocks: string[], questCompleted: string[] }}
   */
  function ingest(signal) {
    const b = state()
    if (!signal || typeof signal.metric !== 'string') return { unlocks: [], questCompleted: [] }
    const t = clock()
    if (signal.pet && typeof signal.pet === 'object') latestPet = signal.pet
    applyMetric(b, signal, t)
    const qr = computeQuests(b.quests, signal, t, rng)
    b.quests = qr.quests
    const unlocks = grantAchievements(t)
    b.updatedAt = t
    persist()
    return { unlocks, questCompleted: qr.completed }
  }

  /**
   * 每日签到入口（signin-1 槽由此内部推进，外部无需再喂 signin 指标）：
   * 签到 → 周签到板（里程碑 1/3/7 各 +10/+20/+40，跨周重置）→ 首签日推进任务槽 → 成就级联。
   * @param {Date|number} [now] 缺省用注入时钟
   * @returns {{ first: boolean, milestoneHit: '1'|'3'|'7'|null, milestoneReward: number, unlocks: string[], questCompleted: string[] }}
   */
  function signin(nowArg) {
    const b = state()
    const t = nowArg === undefined || nowArg === null ? clock() : nowArg
    const res = signinDaily(b, t)
    const nb = res.blob
    const ws = computeWeekSignin(nb.weekSignin, t)
    nb.weekSignin = ws.weekSignin
    let milestoneReward = 0
    if (ws.milestoneHit) milestoneReward = WEEK_MILESTONE_REWARD[ws.milestoneHit] || 0
    if (milestoneReward > 0) nb.affinity = clampAffinity(nb.affinity + milestoneReward)
    let questCompleted = []
    if (res.first) {
      const qr = computeQuests(nb.quests, { metric: 'signin', amount: 1 }, t, rng)
      nb.quests = qr.quests
      questCompleted = qr.completed
    }
    cur = nb
    const unlocks = grantAchievements(t)
    nb.updatedAt = t
    persist()
    return { first: res.first, milestoneHit: ws.milestoneHit, milestoneReward, unlocks, questCompleted }
  }

  /**
   * 领取每日任务奖励：跨日先刷新任务槽；成功领取 → 发奖 + counters.questsClaimed+1，
   * 三槽全清边沿 → counters.questAllDays+1；未满/重复/未知 id 均安全无效果。
   * @param {string} id 槽 id
   * @returns {{ claimed: boolean, newlyAll: boolean, reward: {affinity}|null, unlocks: string[] }}
   */
  function claimQuestById(id) {
    const b = state()
    const t = clock()
    b.quests = refreshQuests(b.quests, t, rng)
    const res = claimQuest(b.quests, id)
    b.quests = res.quests
    if (res.claimed) {
      b.affinity = clampAffinity(b.affinity + (res.reward ? num(res.reward.affinity) : 0))
      b.counters.questsClaimed += 1
      if (res.newlyAll) b.counters.questAllDays += 1
    }
    const unlocks = grantAchievements(t)
    b.updatedAt = t
    persist()
    return { claimed: res.claimed, newlyAll: res.newlyAll, reward: res.reward, unlocks }
  }

  /**
   * 只读快照（深拷贝，外部改动不回灌）；顺手把任务槽自愈到今天（跨日重抽并落盘），
   * 设置卡「成长」区任意时刻读取都能拿到当日 3 槽。
   * @returns {object} blob 深拷贝
   */
  function snapshot() {
    const b = state()
    const t = clock()
    const q = refreshQuests(b.quests, t, rng)
    if (q !== b.quests) {
      b.quests = q
      persist()
    }
    return deepClone(b)
  }

  /** 幂等 dispose：把当前（已归一）状态 flush 回存储；之后方法仍可用（接线重入安全）。 */
  function dispose() {
    if (disposed) return
    disposed = true
    state()
    persist()
  }

  return { ingest, signin, claimQuest: claimQuestById, snapshot, dispose }
}
