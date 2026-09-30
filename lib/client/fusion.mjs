// telemetry 融合纯函数层（M6-4）。零包导入的松耦合契约：
// - 状态机增强：复用 dsh-local-telemetry src/adapter-dsh.mjs 的事件映射**语义**（工具失败 /
//   llm/retry / error turn），直接作用在本插件已订阅的宿主 session 事件上，不重复订阅；
// - 实测费用 / 拟人化播报：只消费 telemetry 的 JSONL 产物（~/.dsh/telemetry/YYYY-MM-DD.jsonl，
//   schema v1.0，model.completed.usage 为实测口径），价目用本插件 usage.mjs 的自有表；
// - 缺数据如实缺失（对齐 telemetry「绝不编造」原则）：未知模型/无用量 → missing，不臆造。
import { rateAt, costOfBuckets } from './usage.mjs'

/** 遇挫窗口：最近一次工具失败/模型重试后多久内视为「遇挫中」。 */
export const STRUGGLE_WINDOW_MS = 15000

/**
 * 单条宿主 session 事件的「遇挫」相关性（telemetry adapter-dsh 映射语义的轻量版）：
 * - tool/result：message.content[0].isError === true → 工具失败；
 * - llm/retry：模型调用重试异常；
 * - turn/end：reason.kind === 'error' → 回合错误收尾。
 * @param {{ type?: string, data?: object }} event 宿主 session 事件
 * @returns {null|'tool-fail'|'retry'|'turn-error'}
 */
export function struggleKindOf(event) {
  if (!event || typeof event.type !== 'string') return null
  const data = event.data && typeof event.data === 'object' ? event.data : {}
  if (event.type === 'tool/result') {
    const message = data.message && typeof data.message === 'object' ? data.message : {}
    const block = Array.isArray(message.content) && message.content.length > 0 ? message.content[0] : null
    return Boolean(block && typeof block === 'object' && block.isError === true) ? 'tool-fail' : null
  }
  if (event.type === 'llm/retry') return 'retry'
  if (event.type === 'turn/end') {
    const reason = data.reason && typeof data.reason === 'object' ? data.reason : {}
    return reason.kind === 'error' ? 'turn-error' : null
  }
  return null
}

// ---- telemetry JSONL 折叠（实测费用 + 洞察）----
/** 解析一行 JSONL → 事件对象；坏行返回 null（fail-open，对齐 telemetry sink 语义）。 */
export function parseTelemetryLine(line) {
  if (typeof line !== 'string' || line.length === 0) return null
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** telemetry 单事件 → 计费样本（model.completed 且 usage 齐）；不齐返回 null。 */
export function telemetrySampleOf(event) {
  if (!event || event.event !== 'model.completed') return null
  const usage = event.usage && typeof event.usage === 'object' ? event.usage : null
  if (!usage) return null
  const input = Number.isInteger(usage.input_tokens) ? usage.input_tokens : null
  const output = Number.isInteger(usage.output_tokens) ? usage.output_tokens : null
  if (input === null || output === null) return null
  const model = event.model && typeof event.model === 'object' ? event.model.name : ''
  const time = Date.parse(event.timestamp)
  return {
    model: typeof model === 'string' ? model : '',
    time: Number.isFinite(time) ? time : null,
    input,
    cacheRead: Number.isInteger(usage.cached_input_tokens) ? usage.cached_input_tokens : 0,
    output,
    durationMs: Number.isInteger(event.duration_ms) ? event.duration_ms : null,
  }
}

/** telemetry 单事件 → 工具样本（tool.completed）；其余事件返回 null。 */
export function telemetryToolSampleOf(event) {
  if (!event || event.event !== 'tool.completed') return null
  const tool = event.tool && typeof event.tool === 'object' ? event.tool : {}
  const status = event.result && typeof event.result === 'object' ? event.result.status : null
  return {
    name: typeof tool.name === 'string' && tool.name.length > 0 ? tool.name : 'unknown',
    ok: status === 'success',
    durationMs: Number.isInteger(event.duration_ms) ? event.duration_ms : null,
  }
}

/**
 * 折叠 telemetry JSONL 行（当日/前一日文件合并后传入）为聚合视图。
 * @param {string[]} lines 原始行（上限内截尾由调用方控制）
 * @returns {{ models: object[], tools: object[], samples: number, badLines: number }}
 */
export function foldTelemetryDay(lines) {
  const models = []
  const tools = []
  let samples = 0
  let badLines = 0
  for (const line of lines) {
    const event = parseTelemetryLine(line)
    if (event === null) {
      if (typeof line === 'string' && line.length > 0) badLines += 1
      continue
    }
    const modelSample = telemetrySampleOf(event)
    if (modelSample !== null) {
      models.push(modelSample)
      samples += 1
      continue
    }
    const toolSample = telemetryToolSampleOf(event)
    if (toolSample !== null) {
      tools.push(toolSample)
      samples += 1
    }
  }
  return { models, tools, samples, badLines }
}

/**
 * 实测费用核算（M6-4：M3 完成气泡的实测口径）：
 * usage 为实测（telemetry model.completed），价目沿用本插件 usage.mjs 档位表——
 * 模型名映射与 M3 估算一致（含 flash 走 flash，其余按 pro），故恒可计价。
 * @param {object} fold foldTelemetryDay 产物
 * @param {number|null} [sinceMs] 只统计该时刻之后的样本（任务起点）；null/非法 = 全部
 */
export function telemetryCost(fold, sinceMs = null) {
  const from = Number.isFinite(sinceMs) ? sinceMs : -Infinity
  let hit = 0
  let miss = 0
  let out = 0
  let input = 0
  let cacheRead = 0
  let output = 0
  let priced = 0
  for (const sample of fold?.models ?? []) {
    if (sample.time !== null && sample.time < from) continue
    input += sample.input
    cacheRead += sample.cacheRead
    output += sample.output
    const rate = rateAt(sample.model, sample.time ?? Date.now())
    const cost = costOfBuckets({ input: sample.input, cacheRead: sample.cacheRead, cacheWrite: 0, output: sample.output }, rate)
    hit += cost.hit
    miss += cost.miss
    out += cost.out
    priced += 1
  }
  return {
    ok: priced > 0,
    total: input + cacheRead + output, // 与 computeTaskUsage 口径一致（命中+未命中+输出）
    costCny: priced > 0 ? hit + miss + out : 0,
    costHitCny: hit,
    costMissCny: miss,
    costOutCny: out,
    input,
    cacheRead,
    output,
    pricedSamples: priced,
  }
}

/** 工具聚合视图：失败数 + 最慢工具（按平均耗时）。 */
export function toolInsights(fold) {
  const byName = new Map()
  let failures = 0
  for (const tool of fold?.tools ?? []) {
    if (!tool.ok) failures += 1
    const slot = byName.get(tool.name) ?? { total: 0, count: 0 }
    if (Number.isFinite(tool.durationMs)) {
      slot.total += tool.durationMs
      slot.count += 1
    }
    byName.set(tool.name, slot)
  }
  let slowest = null
  let slowestAvg = 0
  for (const [name, slot] of byName) {
    if (slot.count === 0) continue
    const avg = slot.total / slot.count
    if (avg > slowestAvg) {
      slowestAvg = avg
      slowest = name
    }
  }
  return { failures, slowest, slowestAvgMs: slowestAvg }
}

/** 缓存命中率（0-1）：cacheRead / (cacheRead + input)，无样本返回 null。 */
export function cacheHitRate(fold) {
  let read = 0
  let miss = 0
  for (const sample of fold?.models ?? []) {
    read += sample.cacheRead
    miss += sample.input
  }
  const total = read + miss
  return total > 0 ? read / total : null
}

/**
 * 洞察台词（M6-4 拟人化播报的数据驱动条目；telemetry report.mjs 的洞察语义子集）。
 * 无数据返回空数组——不编造。
 */
export function insightLines(fold) {
  const lines = []
  const rate = cacheHitRate(fold)
  if (rate !== null) {
    lines.push(`今天的缓存命中率 ${(rate * 100).toFixed(0)}%` + (rate >= 0.5 ? '，省钱小能手上线！' : '，多提重复的问题会更省哦。'))
  }
  const tools = toolInsights(fold)
  if (tools.failures > 0) {
    lines.push(`今天工具失败了 ${tools.failures} 次，鲸鱼娘都帮你记着呢。`)
  }
  if (tools.slowest !== null && tools.slowestAvgMs >= 3000) {
    lines.push(`最慢的工具是 ${tools.slowest}（平均 ${(tools.slowestAvgMs / 1000).toFixed(0)} 秒），等它的时候可以摸摸鱼～`)
  }
  return lines
}

/**
 * 主动播报统一选词（M5-3 台词库 + M6-4 数据驱动条目合并；洞察条目优先轮换）。
 * @param {{ insights?: string[], avoidTexts?: string[], random?: () => number }} input
 * @param {() => string} pickSkitLine 无洞察时的台词抽取器（注入 M5 随机源）
 * @returns {{ line: string, source: 'insight'|'skit' }}
 */
export function pickProactiveLine({ insights, avoidTexts = [], random = Math.random } = {}, pickSkitLine) {
  const pool = Array.isArray(insights) ? insights.filter((s) => typeof s === 'string' && s.length > 0 && !avoidTexts.includes(s)) : []
  const useInsight = pool.length > 0 && random() < 0.5
  if (useInsight) {
    const line = pool[Math.floor(random() * pool.length) % pool.length]
    return { line, source: 'insight' }
  }
  return { line: pickSkitLine(), source: 'skit' }
}
