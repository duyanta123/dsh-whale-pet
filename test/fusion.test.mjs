// M6-4 融合域单测：遇挫窗口判定（telemetry adapter 映射语义）/ JSONL 折叠 /
// 实测费用（taskSummaryLines 兼容形状）/ 洞察台词 / 播报合并抽取 / 低配降级判定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STRUGGLE_WINDOW_MS, struggleKindOf, parseTelemetryLine, telemetrySampleOf,
  foldTelemetryDay, telemetryCost, toolInsights, cacheHitRate, insightLines, pickProactiveLine,
} from '../lib/client/fusion.mjs'
import { shouldForceStatic } from '../lib/client/renderer.mjs'
import { taskSummaryLines, fmtTokens } from '../lib/client/usage.mjs'

const NOW = 1_000_000_000

// ---- 遇挫窗口（状态机增强的决策面）----
test('struggleKindOf：工具失败 / llm 重试 / 错误收尾三类命中，其余为 null', () => {
  assert.equal(struggleKindOf({ type: 'tool/result', data: { message: { content: [{ isError: true }] } } }), 'tool-fail')
  assert.equal(struggleKindOf({ type: 'tool/result', data: { message: { content: [{ isError: false }] } } }), null)
  assert.equal(struggleKindOf({ type: 'tool/result', data: {} }), null)
  assert.equal(struggleKindOf({ type: 'llm/retry', data: {} }), 'retry')
  assert.equal(struggleKindOf({ type: 'turn/end', data: { reason: { kind: 'error' } } }), 'turn-error')
  assert.equal(struggleKindOf({ type: 'turn/end', data: { reason: { kind: 'blocked' } } }), null)
  assert.equal(struggleKindOf({ type: 'assistant/message', data: {} }), null)
  assert.equal(struggleKindOf(null), null)
  assert.equal(struggleKindOf({}), null)
})

// ---- telemetry JSONL 折叠 ----
const modelLine = (over = {}) => JSON.stringify({
  event: 'model.completed',
  timestamp: new Date(NOW).toISOString(),
  duration_ms: 1200,
  model: { name: 'deepseek-flash', provider: 'deepseek-official' },
  usage: { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 500, reasoning_tokens: 50 },
  result: { status: 'success' },
  ...over,
})
const toolLine = (over = {}) => JSON.stringify({
  event: 'tool.completed',
  timestamp: new Date(NOW).toISOString(),
  duration_ms: 4000,
  tool: { name: 'pwsh' },
  result: { status: 'success' },
  ...over,
})

test('parseTelemetryLine：坏行 fail-open 返回 null', () => {
  assert.equal(parseTelemetryLine('not json'), null)
  assert.equal(parseTelemetryLine(''), null)
  assert.equal(parseTelemetryLine('{"event":"request.started"}').event, 'request.started')
  assert.equal(parseTelemetryLine(null), null)
})

test('telemetrySampleOf：仅 model.completed 且 usage 齐备产出样本', () => {
  const sample = telemetrySampleOf(parseTelemetryLine(modelLine()))
  assert.equal(sample.model, 'deepseek-flash')
  assert.equal(sample.input, 1000)
  assert.equal(sample.cacheRead, 500)
  assert.equal(sample.output, 200)
  assert.equal(sample.time, NOW)
  assert.equal(telemetrySampleOf(parseTelemetryLine(toolLine())), null)
  assert.equal(telemetrySampleOf(parseTelemetryLine(modelLine({ usage: null }))), null)
  assert.equal(telemetrySampleOf(parseTelemetryLine(modelLine({ usage: { input_tokens: 1 } }))), null)
})

test('foldTelemetryDay：混合行折叠 + 坏行计数', () => {
  const fold = foldTelemetryDay([modelLine(), toolLine(), toolLine(), 'garbage', '', 'null'])
  assert.equal(fold.models.length, 1)
  assert.equal(fold.tools.length, 2)
  assert.equal(fold.samples, 3)
  assert.equal(fold.badLines, 2) // 'garbage' 与 'null'（JSON null 非对象）计坏行；空串静默跳过
})

test('telemetryCost：实测计价 + sinceMs 过滤 + taskSummaryLines 兼容形状', () => {
  const fold = foldTelemetryDay([modelLine()])
  const cost = telemetryCost(fold, null)
  assert.equal(cost.ok, true)
  assert.equal(cost.pricedSamples, 1)
  assert.equal(cost.input, 1000)
  assert.equal(cost.cacheRead, 500)
  assert.equal(cost.output, 200)
  assert.ok(cost.costCny > 0)
  // 形状直接喂 taskSummaryLines（M3 完成气泡实测口径替换）
  const lines = taskSummaryLines('1分00秒', cost)
  assert.equal(lines[0], '用时 1分00秒')
  assert.ok(lines[1].startsWith('消耗 '))
  assert.ok(lines[2].startsWith('花费 '))
  // sinceMs 之后才有样本：过滤后 ok=false（保持估算兜底）
  assert.equal(telemetryCost(fold, NOW + 1000).ok, false)
})

test('telemetryCost：pro 档模型照实计价；空 fold 不计价', () => {
  const proFold = foldTelemetryDay([modelLine({
    model: { name: 'deepseek-chat', provider: 'x' },
    usage: { input_tokens: 1000000, output_tokens: 0, cached_input_tokens: 0 },
  })])
  const proCost = telemetryCost(proFold)
  assert.equal(proCost.pricedSamples, 1)
  assert.ok(proCost.costCny > 1) // 1M 未命中 tokens ≥ 1 元（pro 档 miss=3 或 flash miss=1）
  assert.equal(telemetryCost({ models: [], tools: [] }).ok, false)
})

// ---- 洞察台词（拟人化播报的数据驱动条目）----
test('toolInsights / cacheHitRate：失败数、最慢工具、缓存命中率', () => {
  const fold = foldTelemetryDay([
    toolLine(), toolLine({ result: { status: 'failed' }, duration_ms: 9000 }),
    toolLine({ tool: { name: 'read' }, duration_ms: 500 }),
    modelLine(), modelLine({ usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 900 } }),
  ])
  const tools = toolInsights(fold)
  assert.equal(tools.failures, 1)
  assert.equal(tools.slowest, 'pwsh') // (4000+9000)/2 = 6500 > 500
  assert.equal(tools.slowestAvgMs, 6500)
  // 命中率 = read/(read+input) = (500+900)/((1000+500)+(100+900)) = 1400/2500
  assert.ok(Math.abs(cacheHitRate(fold) - 1400 / 2500) < 1e-9)
})

test('insightLines：无数据不编造；有数据产出台词', () => {
  assert.deepEqual(insightLines(foldTelemetryDay([])), [])
  const lines = insightLines(foldTelemetryDay([
    modelLine(), toolLine({ result: { status: 'failed' }, duration_ms: 9000 }),
  ]))
  assert.ok(lines.length >= 2)
  assert.ok(lines.some((l) => l.includes('缓存命中率')))
  assert.ok(lines.some((l) => l.includes('失败')))
})

// ---- 播报合并抽取（M5 台词库 + M6-4 洞察条目）----
test('pickProactiveLine：洞察优先概率生效 + avoid 过滤 + 空洞察回退台词库', () => {
  const skit = () => '海浪今天很温柔'
  const always = () => 0 // 恒命中洞察分支
  const picked = pickProactiveLine({ insights: ['缓存命中率 66%，省钱小能手上线！'], random: always }, skit)
  assert.equal(picked.source, 'insight')
  assert.equal(picked.line, '缓存命中率 66%，省钱小能手上线！')
  // avoid 掉唯一洞察 → 回退 skit
  const fallback = pickProactiveLine({ insights: ['缓存命中率 66%'], avoidTexts: ['缓存命中率 66%'], random: always }, skit)
  assert.equal(fallback.source, 'skit')
  const noInsight = pickProactiveLine({ insights: [], random: always }, skit)
  assert.equal(noInsight.source, 'skit')
})

// ---- 低配降级（M6-2 shouldForceStatic）----
test('shouldForceStatic：reduced-motion / 低内存 / 少核 / 正常设备', () => {
  assert.equal(shouldForceStatic({ reducedMotion: true }), true)
  assert.equal(shouldForceStatic({ deviceMemory: 2 }), true)
  assert.equal(shouldForceStatic({ deviceMemory: 8 }), false)
  assert.equal(shouldForceStatic({ hardwareConcurrency: 2 }), true)
  assert.equal(shouldForceStatic({ hardwareConcurrency: 8 }), false)
  assert.equal(shouldForceStatic({}), false)
  assert.equal(shouldForceStatic({ deviceMemory: 0, hardwareConcurrency: 0 }), false) // 未知视为不降级
})

// ---- 常量契约 ----
test('融合常量：遇挫窗口 15s', () => {
  assert.equal(STRUGGLE_WINDOW_MS, 15000)
})

test('fmtTokens 冒烟：融合链路引用的格式化函数可用', () => {
  assert.equal(typeof fmtTokens(12345), 'string')
})
