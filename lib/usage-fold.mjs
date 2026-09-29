// 单事件折叠（M3-2 账本用）：从一条会话事件取 (turn, step, time, model, buckets, cost)。
// 口径与 lib/usage.mjs foldUsage 一致（whale-girl 摘录）：usage 来源 assistant/message
// 或 assistant/attempt 的 stream 尾部 usage chunk；模型路由 request/header（V3 权威）
// 与 request/context；assistant/chunk 为 0.1.2 及更早的流式事件。纯函数零依赖。
import { bucketsFromUsage, costOfBuckets, rateAt } from './usage.mjs'

/** 从一条事件取 usage（与 usage.mjs usageOfEvent 同口径）。 */
function usageOfEvent(ev) {
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
 * 折叠单条事件 → 可入桶样本。
 * @param {object} ev 会话事件
 * @param {string} [currentModel] 账本侧跟踪的当前模型（request/header·context 更新；
 *   空串按 pro 档兜底）。
 * @returns {undefined | { turn, step, time, model, input, cacheRead, cacheWrite, output,
 *   costHit, costMiss, costOut, cost, regime }} 无 usage 的事件返回 undefined。
 */
export function foldUsageSingle(ev, currentModel = '') {
  if (!ev || typeof ev.type !== 'string') return undefined
  let turn
  let step
  let usage
  if (ev.type === 'assistant/chunk' && ev.data && ev.data.chunk && ev.data.chunk.type === 'usage') {
    ;({ turn, step } = ev.data)
    usage = ev.data.chunk.usage
  } else {
    if (!ev.data) return undefined
    ;({ turn, step } = ev.data)
    usage = usageOfEvent(ev)
  }
  if (usage === undefined) return undefined
  const time = typeof ev.time === 'number' ? ev.time : Date.now()
  // 模型路由由账本侧跟踪（request/header V3 权威 + request/context）；
  // 缺省空串走 pro 档兜底。
  const model = String(currentModel || '')
  const buckets = bucketsFromUsage(usage)
  const rate = rateAt(model, time)
  const cost = costOfBuckets(buckets, rate)
  return {
    turn,
    step,
    time,
    model,
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
