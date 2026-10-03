// 费用投影（M3-2）：会话级/每轮费用预估，纯函数零依赖。
// 口径照 whale-girl lib/cost-projection.js（MIT）精简：事件折叠复用 lib/usage.mjs
// 的 foldUsage（turn:step 替换去重 + 重试累加 + 逐事件选档）；单轮归属复用
// usageSampleOfEvent 原语（同口径选档，模型路由同 foldUsage 规则）。
// 会话树/子代理归集由 Node half 接线（M3-5 路由层），本模块保持纯函数面。
import { foldUsage, usageSampleOfEvent, round4 } from './usage.mjs'

/**
 * 会话级费用投影：自 sinceMs 起折叠一组会话事件。
 * @param {Array<object>} events 会话事件快照
 * @param {number} sinceMs 起始时刻（UTC 毫秒）
 * @returns `{ ok, tokens{...}, total, costCny, costHitCny, costMissCny, costOutCny,
 *   costPeakCny, costOffCny, models[] }`；costOffCny 含平价档份额（照账本
 *   usage-ledger 的 else 分支口径），保证 costPeakCny + costOffCny = costCny；
 *   无用量时 ok=false、total=0。
 */
export function projectSessionCost(events, sinceMs) {
  const fold = foldUsage(events, sinceMs)
  const tokens = { ...fold.totals }
  const total = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
  if (total <= 0) return { ok: false, total: 0, costCny: 0 }
  return {
    ok: true,
    tokens,
    total,
    costCny: round4(fold.costs.hit + fold.costs.miss + fold.costs.out),
    costHitCny: round4(fold.costs.hit),
    costMissCny: round4(fold.costs.miss),
    costOutCny: round4(fold.costs.out),
    costPeakCny: round4(fold.regimes.peak),
    // 平价档（peakMultiplier=1 的价目档）并入空闲桶，峰谷之和才等于总额。
    costOffCny: round4(fold.regimes.off + fold.regimes.flat),
    models: [...fold.models].slice(0, 8),
  }
}

/**
 * 单轮费用投影：某 turn 内全部样本的费用合计（输入框旁"每轮"pill 用）。
 * 模型路由与 foldUsage 同规则（request/header 权威、request/context 兜底）；
 * 去重也与 foldUsage 同口径：同 (turn,step) 后到替换先到（先扣回先到样本），
 * llm/retry-started 关闭替换槽——重试是另一次真实计费调用，前后都累加。
 * @param {Array<object>} events 会话事件快照
 * @param {string|number} turnKey turn id
 * @returns `{ ok, total, costCny }`
 */
export function projectTurnCost(events, turnKey) {
  let input = 0
  let cacheRead = 0
  let cacheWrite = 0
  let output = 0
  let costCny = 0
  let currentModel = ''
  const last = new Map() // 'turn:step' → 已计入样本（替换去重用）
  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string') continue
    if (ev.type === 'request/header') {
      const model = ev.data && ev.data.header && ev.data.header.config ? ev.data.header.config.model : ''
      if (model) currentModel = String(model)
      continue
    }
    if (ev.type === 'request/context') {
      const model = ev.data ? ev.data.model : ''
      if (model) currentModel = String(model)
      continue
    }
    if (ev.type === 'llm/retry-started') {
      const turn = ev.data ? ev.data.turn : undefined
      const step = ev.data ? ev.data.step : undefined
      last.delete(String(turn) + ':' + String(step))
      continue
    }
    const sample = usageSampleOfEvent(ev, currentModel)
    if (sample === undefined || String(sample.turn) !== String(turnKey)) continue
    const prev = last.get(String(sample.turn) + ':' + String(sample.step))
    if (prev !== undefined) {
      // 后到替换先到：先从累计值扣回先到样本，再累加后到样本。
      input -= prev.input
      cacheRead -= prev.cacheRead
      cacheWrite -= prev.cacheWrite
      output -= prev.output
      costCny -= prev.cost
    }
    last.set(String(sample.turn) + ':' + String(sample.step), sample)
    input += sample.input
    cacheRead += sample.cacheRead
    cacheWrite += sample.cacheWrite
    output += sample.output
    costCny += sample.cost
  }
  const total = input + cacheRead + cacheWrite + output
  if (total <= 0) return { ok: false, total: 0, costCny: 0 }
  return { ok: true, total, costCny: round4(costCny) }
}
