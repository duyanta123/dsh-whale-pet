// dsh-whalegirl 用量与计费（M3-1 纯逻辑，零外部依赖）。
// 结构与价目照抄 yanzwzz/dsh-whale-girl-pet lib/usage.js（MIT；2026-09-29 摘录），
// 事件接线留在 Node half（lib/index.mjs M3-5），本模块保持纯函数面供 node --test。
//
// 【口径】（摘自 whale-girl 原文）
//   - 数据来源：assistant/message.usage，或 assistant/message / assistant/attempt
//     嵌入 stream 里最后一个 usage chunk（DSH ≥0.1.3 的 V3 信封；0.1.2 及更早的
//     assistant/chunk 仍兼容）。
//   - 去重：同一步（turn,step）内后到的样本替换先到的样本；llm/retry-started
//     关闭替换槽——重试是另一次真实计费调用，前后两次都要累加。
//   - 价格：DeepSeek 官方价目（元/百万 tokens）。价目表给空闲价，
//     高峰时段乘 peakMultiplier；高峰为北京时间（UTC+8）周一至周五
//     9:00-12:00、14:00-18:00，其余（含周末全天）为空闲。
//   - 缓存写入按「未命中」单价计（对应官方 prompt_cache_miss_tokens）。
//   - 每条用量按其事件时间戳选档，跨换价、跨峰谷的一次任务也能算准。

// ============================================================================
// 价格表（whale-girl 摘录；元/百万 tokens）
// ============================================================================

/**
 * 分档价目：每档给出生效时刻与空闲单价。`peakMultiplier` 为 1 表示该档不分峰谷。
 * 同一档位内按生效时刻取"不晚于该时刻的最后一档"。
 */
const PRICE_SCHEDULES = {
  flash: [
    { from: 0, hit: 0.02, miss: 1, out: 2, peakMultiplier: 1 },
    { from: Date.UTC(2026, 7, 16, 16, 0, 0), hit: 0.05, miss: 1.5, out: 4.5, peakMultiplier: 2 },
    { from: Date.UTC(2026, 8, 10, 4, 0, 0), hit: 0.02, miss: 1, out: 4, peakMultiplier: 2 },
  ],
  pro: [
    { from: 0, hit: 0.025, miss: 3, out: 6, peakMultiplier: 1 },
    { from: Date.UTC(2026, 7, 16, 16, 0, 0), hit: 0.15, miss: 4.5, out: 13.5, peakMultiplier: 2 },
  ],
}

/** 北京时间（UTC+8）是否处于高峰时段（周一至周五 9:00-12:00、14:00-18:00）。 */
export function isPeakBeijing(timeMs) {
  const bj = new Date(timeMs + 8 * 3600e3)
  const weekday = bj.getUTCDay()
  if (weekday === 0 || weekday === 6) return false // 周末全天按空闲计价
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

/** 模型名 → 价目档位：含 flash 走 flash 价，其余（v4-pro / 未知）走 pro 价。 */
export function tierOfModel(model) {
  return String(model || '').toLowerCase().includes('flash') ? 'flash' : 'pro'
}

/**
 * 某时刻某模型适用的单价（元/百万 tokens）与计费区间。
 * @param model - 模型 id；空串按 pro 档计。
 * @param timeMs - 用量事件的时间戳（UTC 毫秒）。
 * @returns `{ tier, regime, hit, miss, out }`，regime 为 flat / peak / off。
 */
export function rateAt(model, timeMs) {
  const tier = tierOfModel(model)
  const schedules = PRICE_SCHEDULES[tier]
  let chosen = schedules[0]
  for (const schedule of schedules) {
    if (schedule.from <= timeMs) chosen = schedule
  }
  if (chosen.peakMultiplier === 1) {
    return { tier, regime: 'flat', hit: chosen.hit, miss: chosen.miss, out: chosen.out }
  }
  const peak = isPeakBeijing(timeMs)
  const multiplier = peak ? chosen.peakMultiplier : 1
  return {
    tier,
    regime: peak ? 'peak' : 'off',
    hit: chosen.hit * multiplier,
    miss: chosen.miss * multiplier,
    out: chosen.out * multiplier,
  }
}

// ============================================================================
// 事件折叠
// ============================================================================

/**
 * 从一条结算事件里取出 usage。
 * @param ev - 一条会话事件。
 * @returns provider 上报的 usage，或 undefined。
 */
export function usageOfEvent(ev) {
  if (!ev || !ev.data) return undefined
  if (ev.type === 'assistant/message' && ev.data.usage !== undefined) return ev.data.usage
  if (ev.type !== 'assistant/message' && ev.type !== 'assistant/attempt') return undefined
  const stream = ev.data.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record && record.type === 'chunk' && record.chunk && record.chunk.type === 'usage') {
      return record.chunk.usage
    }
  }
  return undefined
}

/**
 * 把 provider usage 映射成四个 token 桶。
 * @param usage - provider 上报的 usage。
 * @returns `{ input, cacheRead, cacheWrite, output }`。
 */
export function bucketsFromUsage(usage) {
  return {
    input: Number(usage.inputTokens) || 0,
    cacheRead: Number(usage.cacheReadTokens) || 0,
    cacheWrite: Number(usage.cacheWriteTokens) || 0,
    output: Number(usage.outputTokens) || 0,
  }
}

/**
 * 按一个价目档给一组 token 桶计费（元）。
 * @param buckets - {@link bucketsFromUsage} 的结果。
 * @param rate - {@link rateAt} 的结果。
 * @returns `{ hit, miss, out, total, regime }`；缓存写入按未命中价计。
 */
export function costOfBuckets(buckets, rate) {
  const hit = (buckets.cacheRead * rate.hit) / 1e6
  const miss = ((buckets.input + buckets.cacheWrite) * rate.miss) / 1e6
  const out = (buckets.output * rate.out) / 1e6
  return { hit, miss, out, total: hit + miss + out, regime: rate.regime }
}

/**
 * 折叠单条事件 → 可计费样本（foldUsage 的逐事件原语；cost-projection 复用）。
 * @param ev 会话事件
 * @param [currentModel] 账本侧跟踪的当前模型（request/header·request/context 更新）
 * @returns undefined | { turn, step, time, model, input, cacheRead, cacheWrite, output,
 *   costHit, costMiss, costOut, cost, regime }；无 usage 的事件返回 undefined。
 */
export function usageSampleOfEvent(ev, currentModel = '') {
  if (!ev || typeof ev.type !== 'string') return undefined
  let turn
  let step
  let usage
  if (ev.type === 'assistant/chunk' && ev.data && ev.data.chunk && ev.data.chunk.type === 'usage') {
    // DSH 0.1.2 及更早的流式用量事件
    ;({ turn, step } = ev.data)
    usage = ev.data.chunk.usage
  } else {
    if (!ev.data) return undefined
    ;({ turn, step } = ev.data)
    usage = usageOfEvent(ev)
  }
  if (usage === undefined) return undefined
  const time = typeof ev.time === 'number' ? ev.time : Date.now()
  const buckets = bucketsFromUsage(usage)
  const rate = rateAt(currentModel, time)
  const cost = costOfBuckets(buckets, rate)
  return {
    turn,
    step,
    time,
    model: currentModel,
    input: buckets.input,
    cacheRead: buckets.cacheRead,
    cacheWrite: buckets.cacheWrite,
    output: buckets.output,
    costHit: cost.hit,
    costMiss: cost.miss,
    costOut: cost.out,
    cost: cost.total,
    regime: rate.regime,
  }
}

/**
 * 汇总单个会话从 sinceMs 起的 token 与费用（同 turn/step 后到替换先到）。
 * @param events - 会话事件快照。
 * @param sinceMs - 只统计该时刻及之后的事件（UTC 毫秒）。
 * @returns `{ totals, costs, regimes, models }`；costs 为三桶费用，regimes 为按计价区间汇总。
 */
export function foldUsage(events, sinceMs) {
  const last = new Map()
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const costs = { hit: 0, miss: 0, out: 0 }
  const regimes = { flat: 0, peak: 0, off: 0 }
  const models = new Set()
  let currentModel = ''

  /** 把一个已计入的样本从各汇总里减去。 */
  const subtract = (sample) => {
    totals.input -= sample.input
    totals.cacheRead -= sample.cacheRead
    totals.cacheWrite -= sample.cacheWrite
    totals.output -= sample.output
    costs.hit -= sample.costHit
    costs.miss -= sample.costMiss
    costs.out -= sample.costOut
    regimes[sample.regime] -= sample.cost
  }

  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string') continue
    // 路由元数据：request/header（V3 权威来源）与 request/context 都更新当前模型
    if (ev.type === 'request/header') {
      const model = ev.data && ev.data.header && ev.data.header.config ? ev.data.header.config.model : ''
      if (model) {
        currentModel = String(model)
        models.add(currentModel)
      }
      continue
    }
    if (ev.type === 'request/context') {
      const model = ev.data ? ev.data.model : ''
      if (model) {
        currentModel = String(model)
        models.add(currentModel)
      }
      continue
    }
    // 重试是另一次真实计费调用：关闭替换槽，让重试样本累加而不是替换。
    // 已计入的前一次尝试保留在 totals 里（官方按两次调用计费）。
    if (ev.type === 'llm/retry-started') {
      const turn = ev.data ? ev.data.turn : undefined
      const step = ev.data ? ev.data.step : undefined
      last.delete(String(turn) + ':' + String(step))
      continue
    }

    const sample = usageSampleOfEvent(ev, currentModel)
    if (sample === undefined) continue

    const isCounted = sample.time >= sinceMs
    const key = String(sample.turn) + ':' + String(sample.step)
    const buckets = { input: sample.input, cacheRead: sample.cacheRead, cacheWrite: sample.cacheWrite, output: sample.output }
    const cost = { hit: sample.costHit, miss: sample.costMiss, out: sample.costOut, total: sample.cost, regime: sample.regime }

    const prev = last.get(key)
    if (prev !== undefined && prev.counted) subtract(prev)
    last.set(key, {
      ...buckets,
      costHit: cost.hit,
      costMiss: cost.miss,
      costOut: cost.out,
      cost: cost.total,
      regime: cost.regime,
      counted: isCounted,
    })
    if (isCounted) {
      totals.input += buckets.input
      totals.cacheRead += buckets.cacheRead
      totals.cacheWrite += buckets.cacheWrite
      totals.output += buckets.output
      costs.hit += cost.hit
      costs.miss += cost.miss
      costs.out += cost.out
      regimes[cost.regime] += cost.total
    }
  }
  return { totals, costs, regimes, models }
}

// ============================================================================
// 对外汇总
// ============================================================================

/** 四舍五入到 4 位小数（元）。 */
export function round4(n) {
  return Math.round((Number(n) || 0) * 1e4) / 1e4
}

/** 毫秒时长人性化显示：155000 → `2分35秒`；不足 1 秒 → `0秒`。 */
export function fmtDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  if (total >= 60) return `${Math.floor(total / 60)}分${total % 60}秒`
  return `${total}秒`
}

/** token 数人性化显示：1234567 → 1.23M，12345 → 12.3k。 */
export function fmtTokens(n) {
  const value = Number(n) || 0
  if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M'
  if (value >= 1e3) return (value / 1e3).toFixed(1) + 'k'
  return String(value)
}

/** 金额显示：不足 1 分显示 <¥0.01，其余保留 2 位。 */
export function money(cost) {
  const value = Number(cost) || 0
  return value > 0 && value < 0.01 ? '<¥0.01' : '≈¥' + value.toFixed(2)
}

/**
 * 任务完成气泡的多行内容：用时 / 消耗 / 花费总额 + 命中 / 未命中 / 输出三桶。
 * 气泡用 `white-space: pre-line` 渲染，前导空格会被折叠，所以三桶用 `· ` 前缀。
 * @param durationText - 已格式化好的用时文本（如 `2分35秒`）。
 * @param usage - 任务用量汇总（与 computeTaskUsage 同形；M3-5 由 Node half 聚合）。
 * @returns 逐行文本。
 */
export function taskSummaryLines(durationText, usage) {
  const lines = ['用时 ' + durationText]
  if (usage && usage.ok && usage.total > 0) {
    lines.push('消耗 ' + fmtTokens(usage.total) + ' tokens')
    lines.push('花费 ' + money(usage.costCny))
    lines.push('· 缓存命中 ' + money(usage.costHitCny))
    lines.push('· 缓存未命中 ' + money(usage.costMissCny))
    lines.push('· 输出 ' + money(usage.costOutCny))
  }
  return lines
}
