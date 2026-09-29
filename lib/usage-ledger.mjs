// 分时段用量账本（M3-2）：按北京时区的小时桶/日桶聚合 token 与三桶费用。
// 结构照 whale-girl lib/usage-ledger.js（MIT）的口径精简实现：
// - 实时折叠：每条带 usage 的事件按其时间戳入桶（跨换价/跨峰谷逐条选档）；
// - 去重：同 (turn,step) 后到替换先到（替换时从旧桶扣回）；
// - 重试：llm/retry-started 关闭替换槽，重试样本累加（两次真实计费都计入）；
// - 保留窗：小时桶保留 windowDays*24 个，日桶保留 windowDays 个，旧桶淘汰。
// 纯逻辑零依赖：价目/折叠复用 lib/usage.mjs；node --test 可脱离宿主单测。
import { foldUsageSingle } from './usage-fold.mjs'

const BJ_OFFSET_MS = 8 * 3600e3

/** 北京时区某时刻所处的小时桶起点（UTC 毫秒）。 */
export function hourBucketStart(timeMs) {
  return Math.floor((timeMs + BJ_OFFSET_MS) / 3600e3) * 3600e3 - BJ_OFFSET_MS
}

/** 北京时区某时刻所处的日桶起点（UTC 毫秒）。 */
export function dayBucketStart(timeMs) {
  return Math.floor((timeMs + BJ_OFFSET_MS) / 864e5) * 864e5 - BJ_OFFSET_MS
}

const emptyBucket = () => ({
  tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
  costHitCny: 0,
  costMissCny: 0,
  costOutCny: 0,
  costPeakCny: 0,
  costOffCny: 0,
  models: new Set(),
})

/** 把一个已计入样本从桶里扣回（替换去重用）。 */
function subtractSample(bucket, sample) {
  bucket.tokens.input -= sample.input
  bucket.tokens.cacheRead -= sample.cacheRead
  bucket.tokens.cacheWrite -= sample.cacheWrite
  bucket.tokens.output -= sample.output
  bucket.tokens.total -= sample.input + sample.cacheRead + sample.cacheWrite + sample.output
  bucket.costHitCny -= sample.costHit
  bucket.costMissCny -= sample.costMiss
  bucket.costOutCny -= sample.costOut
  if (sample.regime === 'peak') bucket.costPeakCny -= sample.cost
  else bucket.costOffCny -= sample.cost
}

function addSample(bucket, sample, model) {
  bucket.tokens.input += sample.input
  bucket.tokens.cacheRead += sample.cacheRead
  bucket.tokens.cacheWrite += sample.cacheWrite
  bucket.tokens.output += sample.output
  bucket.tokens.total += sample.input + sample.cacheRead + sample.cacheWrite + sample.output
  bucket.costHitCny += sample.costHit
  bucket.costMissCny += sample.costMiss
  bucket.costOutCny += sample.costOut
  if (sample.regime === 'peak') bucket.costPeakCny += sample.cost
  else bucket.costOffCny += sample.cost
  if (model) bucket.models.add(model)
}

/**
 * 创建账本。
 * @param {{ windowDays?: number, now?: () => number }} [opts]
 *   windowDays=保留天数（默认 7）；now=时钟（测试注入）。
 * @returns {{ fold: (ev: object) => void, snapshot: () => object, dispose: () => void }}
 */
export function createUsageLedger({ windowDays = 7, now = Date.now } = {}) {
  const hours = new Map() // hourStartMs → bucket
  const days = new Map() // dayStartMs → bucket
  const last = new Map() // 'turn:step' → 已计入样本（含所在桶键，替换时扣回）
  let currentModel = '' // request/header（V3 权威）与 request/context 更新
  const maxHours = windowDays * 24

  const bucketFor = (map, key) => {
    let bucket = map.get(key)
    if (bucket === undefined) {
      bucket = emptyBucket()
      map.set(key, bucket)
    }
    return bucket
  }

  const prune = () => {
    const t = now()
    const minHour = hourBucketStart(t) - (maxHours - 1) * 3600e3
    for (const key of hours.keys()) {
      if (key < minHour) hours.delete(key)
    }
    const minDay = dayBucketStart(t) - (windowDays - 1) * 864e5
    for (const key of days.keys()) {
      if (key < minDay) days.delete(key)
    }
  }

  return {
    /** 折叠一条会话事件（无 usage 的静默跳过；request/header·context 更新当前模型）。 */
    fold(ev) {
      if (ev && ev.type === 'request/header') {
        const model = ev.data && ev.data.header && ev.data.header.config ? ev.data.header.config.model : ''
        if (model) currentModel = String(model)
        return
      }
      if (ev && ev.type === 'request/context') {
        const model = ev.data ? ev.data.model : ''
        if (model) currentModel = String(model)
        return
      }
      if (ev && ev.type === 'llm/retry-started') {
        // 重试是另一次真实计费调用：关闭替换槽，重试样本累加。
        const data = ev.data ?? {}
        last.delete(String(data.turn) + ':' + String(data.step))
        return
      }
      const sample = foldUsageSingle(ev, currentModel)
      if (sample === undefined) return
      const key = String(sample.turn) + ':' + String(sample.step)
      const prev = last.get(key)
      if (prev !== undefined) {
        // 后到替换先到：从旧样本所在桶扣回。
        subtractSample(bucketFor(hours, prev.hourKey), prev)
        subtractSample(bucketFor(days, prev.dayKey), prev)
      }
      const hourKey = hourBucketStart(sample.time)
      const dayKey = dayBucketStart(sample.time)
      addSample(bucketFor(hours, hourKey), sample, sample.model)
      addSample(bucketFor(days, dayKey), sample, sample.model)
      last.set(key, { ...sample, hourKey, dayKey })
      if (last.size > 4096) {
        // 替换槽防膨胀：淘汰最早一半（正常会话远达不到）。
        let drop = last.size - 2048
        for (const k of last.keys()) {
          if (drop-- <= 0) break
          last.delete(k)
        }
      }
      prune()
    },

    /** 快照：今日/窗口合计 + 小时/日序列（北京时区）。 */
    snapshot() {
      const t = now()
      const todayKey = dayBucketStart(t)
      const totals = { today: emptyBucket(), window: emptyBucket() }
      const collect = (map, into) => {
        for (const [key, bucket] of map) {
          into.tokens.input += bucket.tokens.input
          into.tokens.cacheRead += bucket.tokens.cacheRead
          into.tokens.cacheWrite += bucket.tokens.cacheWrite
          into.tokens.output += bucket.tokens.output
          into.tokens.total += bucket.tokens.total
          into.costHitCny += bucket.costHitCny
          into.costMissCny += bucket.costMissCny
          into.costOutCny += bucket.costOutCny
          into.costPeakCny += bucket.costPeakCny
          into.costOffCny += bucket.costOffCny
          for (const model of bucket.models) into.models.add(model)
          void key
        }
      }
      collect(days, totals.window)
      const today = days.get(todayKey)
      if (today !== undefined) {
        totals.today = today
      }
      const round4 = (n) => Math.round(n * 1e4) / 1e4
      const serialize = (bucket) => ({
        tokens: { ...bucket.tokens },
        costHitCny: round4(bucket.costHitCny),
        costMissCny: round4(bucket.costMissCny),
        costOutCny: round4(bucket.costOutCny),
        costPeakCny: round4(bucket.costPeakCny),
        costOffCny: round4(bucket.costOffCny),
        models: [...bucket.models].slice(0, 8),
      })
      return {
        now: t,
        windowDays,
        totals: { today: serialize(totals.today), window: serialize(totals.window) },
        hours: [...hours.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([key, bucket]) => ({ start: key, ...serialize(bucket) })),
        days: [...days.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([key, bucket]) => ({ start: key, ...serialize(bucket) })),
      }
    },

    dispose() {
      hours.clear()
      days.clear()
      last.clear()
    },
  }
}
