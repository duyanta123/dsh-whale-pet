// 余额不足提醒（二期 balance-low 姿势，默认关）：阈值判定 + 低频轮询节拍 + 提醒去重。
// 全部纯函数（零 DOM/零定时器/零 fetch，时刻一律入参）：/api/whale-pet/balance 的拉取、
// 轮询定时器与深夜静音门控（care.mjs isNightMute，静音段连轮询都暂停、醒来自然恢复）
// 全部在宿主薄执行层 main.mjs 接线（phase2-plan §2.5/§11）；默认关由设置层落实
// （balanceLow.enabled 默认 false，§9 红线：隐私/强主动项默认关），本模块不含开关逻辑。
// 数值语义适配自 musume（refs/dsh-whale-musume/assets/whale-moe-core.js）：
// balanceTier = 132-141 行、pickBalanceAccount = 143-151 行（CNY 优先、回退首条）。

/** 基础轮询节拍：约 10 分钟（固定契约口径，phase2-plan §2.5）。 */
export const BALANCE_POLL_MS = 10 * 60_000

/** 轮询失败退避封顶：60 分钟（成功后下一轮回到基础节拍）。 */
export const BALANCE_BACKOFF_MAX_MS = 60 * 60_000

/**
 * 余额档位表（沿用 musume BALANCE_TIERS：whale-moe-core.js:130-141，仅作气泡文案选择，
 * 判定只看 thresholdCNY）。阈值梯度：empty ≤ 0 < critical < 1 < low < 5 < ok < 20 < good < 100 ≤ rich。
 */
export const BALANCE_TIERS = Object.freeze(['empty', 'critical', 'low', 'ok', 'good', 'rich'])

/**
 * 余额档位（musume balanceTier 同款阈值，仅作气泡文案选择）。
 * amount 为数组/对象等非 number/string 脏形状（Number([])===0 的隐式收敛坑，白名单姿势
 * 对齐 weather.mjs toCoord）、null/undefined/空串/布尔/非有限数时返回 'unknown'
 * （拿不到数据，不参与判定，绝不误判成 empty 档）。
 * @param {unknown} amount 余额数值（或官方返回的数字字符串）
 * @returns {'empty'|'critical'|'low'|'ok'|'good'|'rich'|'unknown'}
 */
export function balanceTier(amount) {
  // 类型白名单（对齐 weather.mjs toCoord 姿势）：Number() 收敛前先拦数组/对象等脏形状，
  // Number([])===0 的隐式强转曾把脏数据误判成 empty 档。
  if (typeof amount !== 'number' && typeof amount !== 'string') return 'unknown'
  const n = Number(amount)
  if (
    amount === null || amount === undefined || amount === '' || typeof amount === 'boolean' ||
    (typeof amount === 'string' && amount.trim() === '') || !Number.isFinite(n)
  ) return 'unknown'
  if (n <= 0) return 'empty'
  if (n < 1) return 'critical'
  if (n < 5) return 'low'
  if (n < 20) return 'ok'
  if (n < 100) return 'good'
  return 'rich'
}

/**
 * total_balance → 非负有限数值；仅接受有限 number 或非空数字 string，其余类型（含数组/对象）
 * 一律 NaN——类型白名单（对齐 weather.mjs toCoord 姿势）拦下 Number([])===0 一类隐式收敛。
 * 告警安全优先：脏金额绝不映射成 0（0 会触发「余额不足」误报），而是视为坏载荷交给退避重试。
 * @param {unknown} raw 官方条目的 total_balance 字段
 * @returns {number} 合法金额或 NaN
 */
function toAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : Number.NaN
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : Number.NaN
  }
  return Number.NaN
}

/**
 * 解析宿主余额路由（GET /api/whale-pet/balance）返回体（纯函数，不做任何请求）。
 * 接受两种成功形状：升级后宿主路由透传 DeepSeek 响应并附 ok:true（phase2-plan §10.2），
 * 以及裸 DeepSeek 形状 { is_available, balance_infos: [{ currency, total_balance, ... }] }；
 * 未配置/上游失败形状 { ok:false, reason } 原样带回 reason（现 stub 恒 'balance-not-configured'）。
 * 币种按 musume pickBalanceAccount 语义（whale-moe-core.js:143-151）：CNY 优先，无 CNY 回退首条；
 * 回退条目 currency 缺省/空串时按 'CNY' 兜底（girl-pet shapeBalance 同语义）。
 * 坏载荷（非对象 / 缺 balance_infos / is_available:false / 金额不可解析）→ { ok:false, reason }。
 * @param {unknown} payload 宿主路由 JSON
 * @returns {{ ok: true, currency: string, amount: number } | { ok: false, reason: string }}
 */
export function parseBalancePayload(payload) {
  if (payload === null || typeof payload !== 'object') return { ok: false, reason: 'bad-payload' }
  if (payload.ok === false) {
    const reason = typeof payload.reason === 'string' && payload.reason !== '' ? payload.reason : 'balance-error'
    return { ok: false, reason }
  }
  if (payload.is_available === false) return { ok: false, reason: 'unavailable' }
  const infos = Array.isArray(payload.balance_infos) ? payload.balance_infos : null
  if (!infos || infos.length === 0) return { ok: false, reason: 'bad-payload' }
  // pickBalanceAccount 语义：CNY 优先；无 CNY（或条目不可用）回退首条（musume whale-moe-core.js:143-151）
  const preferred =
    infos.find((entry) => entry !== null && typeof entry === 'object' &&
      String(entry.currency ?? '').toUpperCase() === 'CNY') || infos[0]
  if (preferred === null || typeof preferred !== 'object') return { ok: false, reason: 'bad-payload' }
  const amount = toAmount(preferred.total_balance)
  if (Number.isNaN(amount)) return { ok: false, reason: 'bad-amount' }
  const currency = String(preferred.currency ?? 'CNY').toUpperCase() || 'CNY'
  return { ok: true, currency, amount }
}

/**
 * 下次轮询时刻（节拍决策，纯函数，phase2-plan §2.5）：
 * 成功 → now + 10min；失败 → now + 10min × 2^failStreak，封顶 60min（指数退避）。
 * failStreak 语义 = 截至本次为止的连续失败次数（本次失败计入）：宿主每轮失败后 failStreak+=1
 * 再传入；「成功即复位 failStreak」由调用方维护（本函数无状态）——推荐接线：
 *   const at = nextPollAt(now, { ok, failStreak: ok ? 0 : failStreak + 1 })
 *   failStreak = ok ? 0 : failStreak + 1
 * ok 严格 === true 才走成功分支（缺省/undefined 一律按失败退避，宁可慢不可刷）。
 * @param {number} now 当前时刻（ms）
 * @param {{ ok?: boolean, failStreak?: number }} [result] 本轮结果与连续失败计数
 * @returns {number} 下次轮询时刻（ms）
 */
export function nextPollAt(now, { ok, failStreak = 0 } = {}) {
  const base = Number.isFinite(now) ? now : 0
  if (ok === true) return base + BALANCE_POLL_MS
  const streak = Number.isFinite(failStreak) ? Math.max(0, Math.floor(failStreak)) : 0
  return base + Math.min(BALANCE_POLL_MS * 2 ** streak, BALANCE_BACKOFF_MAX_MS)
}

/**
 * 阈值判定 + 提醒去重（同一水位只提醒一次，水位回升重置；phase2-plan §2.5 冻结契约）：
 * - low = amount < thresholdCNY（严格小于：恰好等于阈值视为仍充足）；
 * - low && !alertedLow → alert=true 且置位 alertedLow（同一水位只提醒一次）；
 * - !low（水位回升到阈值及以上）→ alertedLow=false（重置，再次跌破可再提醒）；
 * - amount 或阈值无效 → 不提醒、不重置（水位未知时保留既有记忆，避免脏数据误复位导致重复打扰）。
 * alertedLow 按真值语义读取（与契约伪代码 !alertedLow 一致），输出恒为布尔。
 * tier 仅作气泡文案选择（musume BALANCE_TIERS 档位），不参与 alert 判定。
 * @param {{ amount: unknown, thresholdCNY: unknown, alertedLow?: boolean }} input
 * @returns {{ alert: boolean, alertedLow: boolean, tier: string }}
 */
export function balanceLowDecision({ amount, thresholdCNY, alertedLow } = {}) {
  const tier = balanceTier(amount)
  const n = Number(amount)
  const threshold = Number(thresholdCNY)
  const amountValid =
    amount !== null && amount !== undefined && amount !== '' && typeof amount !== 'boolean' &&
    !(typeof amount === 'string' && amount.trim() === '') && Number.isFinite(n)
  const thresholdValid = Number.isFinite(threshold) && threshold > 0
  if (!amountValid || !thresholdValid) {
    // 不提醒不重置：真值记忆原样保留（归一为布尔输出）
    return { alert: false, alertedLow: Boolean(alertedLow), tier }
  }
  if (n < threshold) {
    // 跌破阈值：未提醒过才提醒（!alertedLow 真值语义）
    return { alert: !alertedLow, alertedLow: true, tier }
  }
  // 水位回升：重置去重记忆
  return { alert: false, alertedLow: false, tier }
}
