// 表情包 CDN 目录（二期 ⑦）：474 张鲸鱼娘表情包 Supabase 公开桶热链（phase2-plan §2.7）。
// URL 模式（详案 §2.4 核实）：预览 {BASE}/0_preview/meme/NNN.webp、原图 {BASE}/meme/NNN.webp（NNN 三位补零，001–474）。
// 探测降级：CDN 开 → 随机抽号探 preview（超时 3s）→ 成功 source='cdn'；任何失败静默回退本地池
// （bubble.mjs MEME_POOL = assets/memes/meme-001..030.webp）——pick 同步取号、永不 throw、永不阻塞气泡面。
// 许可注记（README 必写，此处同记）：474 张为社区二创，仅个人使用，商用需画师授权（详案 §2.4 原文）。
// 边界：client 直链外联的唯一例外（详案 §2.4 明示）；fetch/now/random 全注入、零 DOM；
// 周期性重探定时器归宿主（main.mjs 调 refresh()，模块内按 TTL 节流），本模块唯一的 setTimeout
// 是单次探测的 3s 超时守卫，挂 dispose。探测为池级（随机抽号），单编号缺失不在职责内（整包连号口径）。
import { MEME_POOL } from './bubble.mjs'

/** CDN 桶基址（详案 §2.4 核实：Supabase Storage 公开桶 ai-meme）。 */
export const MEME_CDN_BASE =
  'https://bjumymxtfpfswthiusfr.storage.supabase.co/storage/v1/object/public/ai-meme'

/** 编号上限（001–474）。 */
export const MEME_CDN_COUNT = 474

/** 探测节流窗口：10 分钟内不重复探测（成功/失败一视同仁，过期重探）。 */
export const MEME_CDN_PROBE_TTL_MS = 10 * 60_000

/** 单次探测超时（计划口径 3s；测试/宿主可经 probeTimeoutMs 覆写）。 */
const PROBE_TIMEOUT_MS = 3000

/** 表情包编号 → 三位补零（001–474）。 */
const pad3 = (n) => String(n).padStart(3, '0')

/** 编号校验：非整数/越界抛 RangeError（pick/probe 内部生成的编号经 sanitize 永不越界）。 */
function assertMemeNo(n) {
  if (!Number.isInteger(n) || n < 1 || n > MEME_CDN_COUNT) {
    throw new RangeError(`表情包编号越界：${n}（合法范围 1–${MEME_CDN_COUNT} 的整数）`)
  }
  return n
}

/**
 * 随机源 → [0, len) 下标。非有限值（NaN/Infinity/非函数）按 0 处理、负值回卷——
 * 注入脏随机源时取号仍落在合法区间，pick 永不 throw。
 */
function pickIndex(rnd, len) {
  const r = typeof rnd === 'function' ? rnd() : 0
  const x = Number.isFinite(r) ? r : 0
  let idx = Math.floor(x * len) % len
  if (idx < 0) idx += len
  return idx
}

/** 预览图 URL（气泡 <img> 展示面：体积小加载快，bubble.mjs img 上限 180px）。 */
export function cdnPreviewUrl(n) {
  return `${MEME_CDN_BASE}/0_preview/meme/${pad3(assertMemeNo(n))}.webp`
}

/** 原图 URL（高清场景备用；本期气泡只用预览）。 */
export function cdnRawUrl(n) {
  return `${MEME_CDN_BASE}/meme/${pad3(assertMemeNo(n))}.webp`
}

/** 探测响应是否「成功」：真 fetch 的 Response（ok:true）或测试伪响应（无 ok 字段按 status 2xx）。 */
function isProbeOk(res) {
  if (res === null || typeof res !== 'object') return false
  if (res.ok === true) return true
  return res.ok === undefined && typeof res.status === 'number' && res.status >= 200 && res.status < 300
}

/**
 * 创建表情包目录（唯一带副作用的导出：在途探测持有一个 setTimeout 超时守卫，挂 dispose）。
 * @param {{ fetchImpl?: typeof fetch|null, random?: () => number, now?: () => number,
 *           enabled?: boolean, probeTimeoutMs?: number }} [opts]
 *   - fetchImpl：探测用（注入；默认 globalThis.fetch，缺席/非函数视为探测失败恒本地）
 *   - random/now：注入（默认 Math.random / Date.now，仓库同款注入约定）
 *   - enabled：CDN 总开关（main.mjs 接 settings.memeCdn.enabled；false = 恒本地、refresh 空转）
 *   - probeTimeoutMs：单次探测超时毫秒（默认 3000）
 * @returns {{
 *   pick: (random?: () => number) => { url: string, source: 'cdn'|'local' },
 *   source: () => 'cdn'|'local',
 *   refresh: () => Promise<'cdn'|'local'>,
 *   dispose: () => void,
 * }}
 */
export function createMemeCatalog({
  fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
  random = Math.random,
  now = () => Date.now(),
  enabled = true,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  let curSource = 'local' // 最近已知来源；初始保守走本地池（首探未决前 CDN 未验证）
  let lastProbeAt = null // 上次实际探测的完成时刻（TTL 节流基准；null = 从未探测）
  let probing = null // 在途探测 promise（并发 refresh 去重）
  let pendingTimer = null // 在途探测的超时守卫（探测串行化，同时至多一个；dispose 清理）
  let disposed = false

  // 同步取号（调用点 bubble.say(text, { memeUrl: pick().url })，替换 main.mjs:120,208 的 pickMeme()）：
  // 用最近已知 source 选池——CDN 抖动只影响来源切换，绝不阻塞/throw 气泡面。
  function pick(rnd = random) {
    if (curSource === 'cdn') {
      return { url: cdnPreviewUrl(pickIndex(rnd, MEME_CDN_COUNT) + 1), source: 'cdn' }
    }
    return { url: MEME_POOL[pickIndex(rnd, MEME_POOL.length)], source: 'local' }
  }

  // 单次探测：随机抽号探 preview（超时守卫 + AbortController 尽力中断真实连接）。
  // 任何失败（网络错/非 2xx/超时/fetch 缺席）→ source 回 'local'；结果静默、永不 reject。
  async function probeOnce() {
    const url = cdnPreviewUrl(pickIndex(random, MEME_CDN_COUNT) + 1)
    let ok = false
    try {
      if (typeof fetchImpl === 'function') {
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null
        ok = (await Promise.race([
          Promise.resolve()
            .then(() => fetchImpl(url, { signal: ctrl ? ctrl.signal : undefined }))
            .then((res) => isProbeOk(res)),
          new Promise((resolve) => {
            pendingTimer = setTimeout(() => {
              pendingTimer = null
              if (ctrl) ctrl.abort()
              resolve(false)
            }, probeTimeoutMs)
          }),
        ])) === true
      }
    } catch {
      ok = false
    } finally {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer)
        pendingTimer = null
      }
    }
    if (disposed) return // dispose 后在途探测结果不再落地
    curSource = ok ? 'cdn' : 'local'
    lastProbeAt = now()
  }

  // 后台探测入口（宿主定时器/设置热应用/启动时调用）：TTL 内节流、在途去重；不阻塞、不 reject、失败静默。
  function refresh() {
    if (disposed || !enabled) return Promise.resolve(curSource)
    if (probing) return probing
    if (lastProbeAt !== null && now() - lastProbeAt < MEME_CDN_PROBE_TTL_MS) {
      return Promise.resolve(curSource)
    }
    probing = probeOnce()
      .catch(() => {}) // probeOnce 已内部兜底；此处再防意外外泄（失败静默红线）
      .then(() => {
        probing = null
        return curSource
      })
    return probing
  }

  /** 最近已知来源（'cdn' | 'local'）。 */
  function source() {
    return curSource
  }

  // dispose（红线：定时器挂 dispose）：清超时守卫、在途结果不落地；pick 同步面不受影响。
  function dispose() {
    disposed = true
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    probing = null
  }

  return { pick, source, refresh, dispose }
}
