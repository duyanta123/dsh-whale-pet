// dsh-whale-chan Node half：事实窗口（Node 唯一输出面）+ agent 事件接线 + SSE + 静态资源路由。
// 契约（0.1.7-rc.2 实测基线，详见开发计划附录 B）：
// - 只监听 agent/created（异步串行），全仓库禁用 agent/session-start；
// - 任务终态经 ctx.jobs 事件流（0.1.7 删除 jobs.onJobDone；双轨守卫：事件流优先，旧 API 兜底）；
// - 会话思考/等待审批经 session/event 的 turn/start·turn/end 边沿聚合；
// - 零 @deepseek-ai 包导入：ctx.* 全部守卫式使用（可选插件失败隔离，缺席即降级）；
// - 事实窗口 { name, until }（绝对截止时间，非消费式快照），经 /state（轮询兜底）与
//   /events（SSE 即时）下发；级联顺序 = 负面优先（error > disappointed > welcome）。
// - M1-6 探针：原始载荷环形缓冲在 /probe 端点（GUI 实测用，结论记开发计划附录 B）。
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { stat, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WELCOME_MS, CELEBRATE_MS, ERROR_MS, DISAPPOINTED_MS } from './client/logic.mjs'
import { isNightMute } from './client/care.mjs'
import { normalizeSettings, resolveIncomingApiKey, redactSettings } from './client/settings.mjs'
import { buildGeocodingUrl, buildForecastUrl } from './client/weather.mjs'
import {
  STRUGGLE_WINDOW_MS, struggleKindOf, foldTelemetryDay, telemetryCost, insightLines,
} from './client/fusion.mjs'
import {
  INITIAL_STATE, recordTaskCompleted, recordFailure, recordSession,
  recordSessionResume, recordActive, taskOutcomeOfEndReason,
} from './pet-state.mjs'
import { normalizeState, serializeState } from './persistence.mjs'
import { createUsageLedger } from './usage-ledger.mjs'
import { projectSessionCost } from './cost-projection.mjs'
import { taskSummaryLines, fmtDuration } from './usage.mjs'
import { parseByteRange } from './range.mjs'

/** 包根（源码与安装后都成立：import.meta.url 指向 lib/，上一级即包根）。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const name = 'whale-pet'
export const inject = ['webServer']

/** 路由端点单一来源（改动前缀只改这里）。 */
export const ROUTE_PREFIX = '/api/whale-pet'
export const ASSETS_PATH = `${ROUTE_PREFIX}/assets`
export const CLIENT_PATH = `${ROUTE_PREFIX}/client`
export const STATE_PATH = `${ROUTE_PREFIX}/state`
export const EVENTS_PATH = `${ROUTE_PREFIX}/events`
export const PROBE_PATH = `${ROUTE_PREFIX}/probe`
export const USAGE_PATH = `${ROUTE_PREFIX}/usage`
export const BALANCE_PATH = `${ROUTE_PREFIX}/balance`
export const WEATHER_PATH = `${ROUTE_PREFIX}/weather`
export const SETTINGS_PATH = `${ROUTE_PREFIX}/settings`
export const ANNOUNCE_PATH = `${ROUTE_PREFIX}/announce`

/** telemetry JSONL 产物目录（M6-4 松耦合对接：只读产物，不导入包）。 */
const TELEMETRY_DIR = join(resolveDshHome(), 'telemetry')

const ASSETS_ROOT = join(PACKAGE_ROOT, 'assets')
const CLIENT_ROOT = join(PACKAGE_ROOT, 'lib', 'client')

/** DSH 主目录（$DSH_HOME，默认 ~/.dsh）；不导入宿主包，env 优先。 */
function resolveDshHome() {
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME)
  const home = process.env.USERPROFILE || process.env.HOME || PACKAGE_ROOT
  return join(home, '.dsh')
}

/** 账本文件：<dshHome>/whale-pet/state.json（不放插件目录——uninstall 会删）。 */
const STATE_FILE = join(resolveDshHome(), 'whale-pet', 'state.json')

/** 设置文件：<dshHome>/whale-pet/settings.json（M5-6；校验单源 client/settings.mjs）。 */
const SETTINGS_FILE = join(resolveDshHome(), 'whale-pet', 'settings.json')

const MIME = {
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra })
  res.end(JSON.stringify(body))
}

/** 路径净化：rel 归一化后必须仍在 root 内（拒绝 `\` 段与 .. 穿越，Windows 强约束）。 */
function resolveIn(root, rel) {
  if (rel.includes('\\')) return undefined
  const candidate = resolve(join(root, rel))
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return undefined
  return candidate
}

/** 读取并归一化已保存账本；缺失/损坏返回 null（宿主回退初始态）。 */
function loadState() {
  try {
    return normalizeState(JSON.parse(readFileSync(STATE_FILE, 'utf8')))
  } catch {
    return null
  }
}

/** 静态文件发送：webm/大文件支持 Range（206 分段），其余 200 全量流式。 */
async function sendFile(res, fp, req) {
  let st
  try {
    st = await stat(fp)
  } catch {
    res.writeHead(404)
    res.end('not found')
    return
  }
  if (!st.isFile()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const type = MIME[extname(fp).toLowerCase()] ?? 'application/octet-stream'
  const range = parseByteRange(req.headers.range, st.size)
  if (range !== null) {
    const { start, end } = range
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      'content-type': type,
      'content-range': `bytes ${start}-${end}/${st.size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    })
    createReadStream(fp, { start, end }).on('error', () => res.destroy()).pipe(res)
    return
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': st.size,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=3600',
  })
  createReadStream(fp).on('error', () => res.destroy()).pipe(res)
}

export function apply(ctx) {
  // 安全兜底：装配意外抛错只降级本插件，不拖垮 Profile（可选插件失败隔离）。
  try {
    applyInner(ctx)
  } catch (error) {
    try {
      ctx?.logger?.warn?.('whale-pet: 装配失败，本插件已降级：' + (error?.message ?? String(error)))
    } catch {}
  }
}

function applyInner(ctx) {
  // ---- M1-6 探针：原始事件载荷环形缓冲（/probe 端点；GUI 实测后结论记附录 B）----
  const probeLog = []
  const probe = (event, payload) => {
    probeLog.push({ at: Date.now(), event, payload: summarize(payload) })
    if (probeLog.length > 50) probeLog.shift()
    try {
      ctx.logger?.info?.(`whale-pet: ${event} ${JSON.stringify(summarize(payload)).slice(0, 400)}`)
    } catch {}
  }
  /** 载荷摘要：类型面 + 浅层字段名（避免超大对象撑爆日志）。 */
  const summarize = (payload) => {
    if (payload === null || payload === undefined) return String(payload)
    if (Array.isArray(payload)) return { array: payload.length }
    if (typeof payload !== 'object') return { scalar: String(payload).slice(0, 120) }
    const out = {}
    for (const key of Object.keys(payload).slice(0, 12)) {
      const value = payload[key]
      out[key] = value === null || value === undefined
        ? String(value)
        : typeof value === 'object'
          ? (Array.isArray(value) ? `array(${value.length})` : `object{${Object.keys(value).slice(0, 8).join(',')}}`)
          : String(value).slice(0, 80)
    }
    return out
  }

  // ---- M4 养成账本（零负反馈：错误不计数、失败只计 failures；flush 挂 dispose 幂等）----
  let petState = loadState() ?? { ...INITIAL_STATE, updatedAt: Date.now() }
  let saveTimer = null
  /**
   * 原子写：同目录唯一后缀 .tmp（pid+时间戳）+ rename。固定 .tmp 在双宿主并发保存时会
   * 互相截断/半写后被 rename 成正式文件（Windows 上 rename 不因对方持有句柄而失败），
   * 账本静默损坏 → 下次加载回退初始态清零；失败不阻塞插件并尽力清理残留临时文件。
   */
  const saveState = () => {
    let tmp = null
    try {
      mkdirSync(join(STATE_FILE, '..'), { recursive: true })
      tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmp, serializeState(petState))
      renameSync(tmp, STATE_FILE)
      tmp = null
    } catch {
      if (tmp !== null) { try { unlinkSync(tmp) } catch { /* 已被并发侧 rename 走即忽略 */ } }
      // 持久化失败不阻塞插件
    }
  }
  const scheduleSave = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveState, 1000)
  }
  /** 活跃陪伴时长：会话思考期间按事件差分累加（单次封顶 5min，防挂机过夜刷满）。 */
  let lastActiveCheck = Date.now()

  // ---- M5 设置体系（~/.dsh/whale-pet/settings.json；normalizeSettings 逐字段纠正坏数据）----
  const loadSettings = () => {
    try {
      return normalizeSettings(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')))
    } catch {
      return normalizeSettings(null)
    }
  }
  let settings = loadSettings()
  /** 原子写同 saveState：唯一后缀 .tmp 防双宿主互踩半写（写失败尽力清理残留）。 */
  const saveSettings = () => {
    let tmp = null
    try {
      mkdirSync(join(SETTINGS_FILE, '..'), { recursive: true })
      tmp = `${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tmp, JSON.stringify(settings, null, 2))
      renameSync(tmp, SETTINGS_FILE)
      tmp = null
    } catch {
      if (tmp !== null) { try { unlinkSync(tmp) } catch { /* 已被并发侧 rename 走即忽略 */ } }
      /* 设置持久化失败不阻塞插件 */
    }
  }

  // ---- 二期 weather 代理（phase2-plan §10-1）：Open-Meteo geocoding+forecast 两跳，无密钥。
  // 内存缓存 10min（仅成功结果）；上游失败 → { ok:false, reason }（路由映射 502）；
  // fetch 挂 5s AbortController 超时（每次请求独立控制器，无长驻定时器；缓存在 dispose 清空）。
  const WEATHER_CACHE_MS = 10 * 60_000
  const WEATHER_FETCH_TIMEOUT_MS = 5000
  const WEATHER_CACHE_MAX = 8 // 键=trim 后城市名；超出删最早，防任意 query 串撑爆内存
  const weatherCache = new Map()
  const fetchJsonWithTimeout = async (url) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => { try { ctrl.abort() } catch {} }, WEATHER_FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, { signal: ctrl.signal })
      if (!res.ok) throw new Error(`upstream-http-${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }
  /** 两跳代理：geocoding（language=zh，中文城市）首条 lat/lon → forecast current。永不抛错。 */
  const fetchWeather = async (city) => {
    try {
      const geo = await fetchJsonWithTimeout(buildGeocodingUrl(city))
      const hit = Array.isArray(geo?.results) && geo.results[0] !== null && typeof geo.results[0] === 'object'
        ? geo.results[0]
        : null
      if (hit === null) return { ok: false, reason: 'city-not-found' }
      // buildForecastUrl 对非法坐标抛 TypeError → 下方 catch 收进 502（weather.mjs 契约）
      const fc = await fetchJsonWithTimeout(buildForecastUrl(hit.latitude, hit.longitude))
      const current = fc?.current ?? null
      if (current === null || typeof current !== 'object') return { ok: false, reason: 'bad-forecast' }
      // 契约形状 { ok, code, tempC, city }：weather_code 原始 number 透传（client 侧 resolveWeatherId 消费）
      return { ok: true, code: current.weather_code, tempC: current.temperature_2m, city }
    } catch (error) {
      return { ok: false, reason: error instanceof Error && error.message ? error.message.slice(0, 120) : 'weather-upstream-error' }
    }
  }

  // ---- 二期 balance 代理升级（phase2-plan §10-2）：balanceLow.apiKey 配置后代理
  // DeepSeek /user/balance（Bearer）；未配置保持一期 stub。明文 key 不写日志、不出宿主。
  const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
  const BALANCE_FETCH_TIMEOUT_MS = 5000
  const fetchBalance = async (apiKey) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => { try { ctrl.abort() } catch {} }, BALANCE_FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(DEEPSEEK_BALANCE_URL, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      })
      if (!res.ok) return { ok: false, reason: `upstream-http-${res.status}` }
      const payload = await res.json()
      if (payload === null || typeof payload !== 'object') return { ok: false, reason: 'bad-payload' }
      // 透传 { is_available, balance_infos }（+ok:true）——client 侧 parseBalancePayload 消费
      return { ok: true, is_available: payload.is_available, balance_infos: payload.balance_infos }
    } catch (error) {
      return { ok: false, reason: error instanceof Error && error.message ? error.message.slice(0, 120) : 'balance-upstream-error' }
    } finally {
      clearTimeout(timer)
    }
  }

  // ---- M5-5 完成音效（宿主进程系统命令播放，绕过浏览器静音；默认关；深夜静音段红线）----
  let soundChild = null // 播放中的子进程（防叠加；dispose 击杀）
  const playSound = () => {
    if (soundChild !== null) return // 上一声未完不叠加
    const file = (typeof settings.sound.file === 'string' && settings.sound.file.trim() !== '')
      ? settings.sound.file.trim()
      : 'C:\\Windows\\Media\\tada.wav' // Windows 自带提示音（kun-like-pet playCommand 模式）
    if (!/\.wav$/i.test(file) || /['"`]/.test(file)) return // 仅 wav + 拒绝引号（注入防护）
    try {
      soundChild = spawn('powershell', [
        '-NoProfile', '-Command',
        `(New-Object Media.SoundPlayer '${file}').PlaySync()`,
      ], { stdio: 'ignore', windowsHide: true })
      soundChild.on('close', () => { soundChild = null })
      soundChild.on('error', () => { soundChild = null })
    } catch { soundChild = null }
  }
  /** 音效放行判定：开关开 且 不在深夜静音段（M5-5 红线）。 */
  const soundAllowed = (at = Date.now()) => settings.sound.enabled === true && !isNightMute(at, {
    enabled: settings.night.muteEnabled,
    startMin: settings.night.startMin,
    endMin: settings.night.endMin,
  })

  // ---- M6-4 telemetry 融合（零导入松耦合：读 JSONL 产物 + 复用 adapter 映射语义）----
  let strugglingUntil = 0 // 遇挫窗口（工具失败/模型重试/错误收尾后 15s）
  let announce = null // 外部投递气泡 { until, text, ms }（周报递送入口用）
  let lastAnnounceAt = 0 // announce 限流水位
  let insights = [] // 洞察台词（cap 4，随 snapshot 下发）
  let insightsTimer = null
  let initialInsights = null // 首刷定时器（在 webServer 块内赋值；dispose 在块外，必须外提声明）
  /** telemetry 当日 + 前一日 JSONL 行（坏文件静默跳过；每文件行数截尾防爆内存）。 */
  const readTelemetryLines = async () => {
    const lines = []
    for (const offsetDays of [0, 1]) {
      const day = new Date(Date.now() - offsetDays * 86400_000)
      const name = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}.jsonl`
      try {
        const raw = await readFile(join(TELEMETRY_DIR, name), 'utf8')
        const dayLines = raw.split('\n')
        lines.push(...(dayLines.length > 20000 ? dayLines.slice(-20000) : dayLines))
      } catch { /* 文件缺失/不可读 = 无数据，如实跳过 */ }
    }
    return lines
  }
  let insightsBusy = false
  const refreshInsights = async () => {
    if (insightsBusy) return
    insightsBusy = true
    try {
      if (settings.fusion.enabled === false) {
        insights = []
        return
      }
      const lines = await readTelemetryLines()
      insights = lines.length === 0 ? [] : insightLines(foldTelemetryDay(lines)).slice(0, 4)
    } catch { insights = [] } finally {
      insightsBusy = false
    }
  }
  /**
   * 任务完成后异步用 telemetry 实测 usage/费用替换估算气泡（M6-4：估算退为兜底）。
   * 按自增 id 定位替换条目——毫秒 at 在同毫秒多条 celebrate（升级/称号解锁与完成并列）
   * 时无法区分，按 at 匹配会把实测汇总盖到别人的条目上丢一条气泡。
   */
  const enrichCelebrateWithTelemetry = async (startedAt, estimateId) => {
    try {
      if (settings.fusion.enabled === false) return
      const lines = await readTelemetryLines()
      if (lines.length === 0) return
      const fold = foldTelemetryDay(lines)
      const measured = telemetryCost(fold, startedAt)
      if (!measured.ok) return
      const index = celebrateMessages.findIndex((m) => m.id === estimateId)
      if (index === -1) return
      celebrateMessages[index] = {
        at: celebrateMessages[index].at,
        id: estimateId,
        lines: taskSummaryLines(fmtDuration(Date.now() - startedAt), measured),
        source: 'telemetry', // M6-4 契约字段：实测口径（估算为兜底）
      }
      factsChanged()
    } catch { /* 融合失败保持估算 */ }
  }

  // ---- M3 用量账本 + 会话事件缓冲 + 任务起点跟踪 ----
  const ledger = createUsageLedger({ windowDays: 7 })
  const SESSION_BUFFERS_MAX = 200 // 会话缓冲条目上限（超出淘汰最旧，防长驻宿主随会话数无界增长）
  const TASK_STARTS_MAX = 200 // 任务起点条目上限（对齐 turnAccountedAt 的 200 条防护）
  const SEEN_SESSIONS_MAX = 500 // 已见会话去重上限（放宽：降低旧会话 id 复现时重复记账的概率）
  const sessionBuffers = new Map() // sessionId → 事件数组（单会话 cap 600，M3-3 任务用量数据源）
  const taskStarts = new Map() // sessionId → 任务起点 ms（首个 turn/start 记账）
  const celebrateMessages = [] // 任务完成信息（最新在前，cap 3；facts 携带给气泡）
  let celebrateSeq = 0 // celebrate 自增 id（telemetry 替换按 id 定位——毫秒 at 同毫秒多条会互吞）

  const bufferSessionEvent = (sessionId, ev) => {
    let buffer = sessionBuffers.get(sessionId)
    if (buffer === undefined) {
      buffer = []
      sessionBuffers.set(sessionId, buffer)
      if (sessionBuffers.size > SESSION_BUFFERS_MAX) {
        sessionBuffers.delete(sessionBuffers.keys().next().value)
      }
    }
    buffer.push(ev)
    if (buffer.length > 600) buffer.splice(0, buffer.length - 600)
  }

  // ---- 事实窗口状态（Node 持有，绝对截止时间；并发取 max 不叠加缩短）----
  let welcomeUntil = 0
  let celebrateUntil = 0
  let errorUntil = 0
  let disappointedUntil = 0
  // 会话感知（多实例快照语义：聚合全部会话，不做跨会话单例缓存）。
  const waitingSessions = new Set() // 当前阻塞于审批的 sessionId 集合（§5.8：wait 以待审批集合非空为准）
  const activeTurns = new Map() // sessionId → { count, at }（未闭合 turn 计数 + 最近活动时刻）
  const ACTIVE_TURN_TTL_MS = 30 * 60_000 // turn/end 丢失防护：超 30min 未闭合且无事件的条目不再计入事实
  /** 淘汰超时未闭合的 turn 条目（每个 session/event 处理时调用；防 thinking 永久卡 true / 活跃虚增）。 */
  const pruneActiveTurns = (t) => {
    for (const [sid, entry] of activeTurns) {
      if (t - entry.at > ACTIVE_TURN_TTL_MS) activeTurns.delete(sid)
    }
  }
  /** thinking 重算：只统计未超时的未闭合 turn（超时条目视为宿主已丢 turn/end，事实自愈）。 */
  const computeThinking = (t) => {
    for (const entry of activeTurns.values()) {
      if (entry.count > 0 && t - entry.at <= ACTIVE_TURN_TTL_MS) return true
    }
    return false
  }

  const now = () => Date.now()

  /**
   * 事实快照（docs/state-machine.md §4 级联）：windows 按负面优先级排序，
   * welcome 不打断 error/disappointed 尾段；wait/thinking 为持续事实。
   */
  const snapshot = () => {
    const t = now()
    const windows = []
    if (errorUntil > t) windows.push({ name: 'error', until: errorUntil })
    if (disappointedUntil > t) windows.push({ name: 'disappointed', until: disappointedUntil })
    if (welcomeUntil > t && errorUntil <= t && disappointedUntil <= t) {
      windows.push({ name: 'welcome', until: welcomeUntil })
    }
    if (celebrateUntil > t) windows.push({
      name: 'celebrate',
      until: celebrateUntil,
      // M3-3：最新一条任务完成信息（耗时/Token/费用多行）随窗口下发。
      message: celebrateMessages.length > 0 ? celebrateMessages[0].lines.join('\n') : undefined,
    })
    // M6-4：遇挫事实 + 洞察台词 + 外部投递气泡（announce 是气泡面，不进 windows 状态机）。
    return {
      windows,
      wait: waitingSessions.size > 0, // §5.8：待审批集合非空即 wait（跨会话聚合，不随最后一条边沿翻转）
      thinking: computeThinking(t),
      struggling: strugglingUntil > t,
      insights,
      announce: announce !== null && announce.until > t ? announce : null,
      ts: t,
      pet: petState,
    }
  }

  // ---- SSE 连接面：事实变化即时下发；25s 心跳防代理空闲断开 ----
  const sseClients = new Set()
  const broadcast = (payload) => {
    const line = `data: ${JSON.stringify(payload)}\n\n`
    for (const res of sseClients) {
      try { res.write(line) } catch { sseClients.delete(res) }
    }
  }
  const factsChanged = () => broadcast({ type: 'facts', facts: snapshot() })

  // ---- 事件接线（全部守卫式；disposer 收集进 effect 统一清理）----
  const disposers = []
  const subscribe = (label, fn) => {
    try {
      const off = fn()
      if (typeof off === 'function') disposers.push(off)
    } catch (error) {
      try { ctx.logger?.warn?.(`whale-pet: ${label} 订阅失败（该事实源缺席，降级运行）：${error?.message ?? error}`) } catch {}
    }
  }

  // ---- 任务记账共用路径（M6-3 桌面端实测修正：普通聊天轮次不产生 jobs.settled——
  // jobs 仅覆盖后台任务系统；chat 轮次的完成/失败改由 session/event 的 turn/end 边沿承担，
  // jobs.settled 路径保留作后台任务兜底，带 8s 时间窗防双宿主同时投递时重复记账）。----
  const turnAccountedAt = new Map() // sessionId → 最近一次 turn/end completed 记账时刻
  const TASK_DEDUPE_MS = 8000
  /** 任务完成记账：XP/统计/回忆 + celebrate 窗口 + 完成音效 + 用量气泡（估算→telemetry 实测替换）。 */
  const onTaskCompleted = (label, sessionId, startedAtOverride) => {
    const t = now()
    if (sessionId !== null && sessionId !== undefined) {
      const last = turnAccountedAt.get(sessionId)
      if (typeof last === 'number' && t - last < TASK_DEDUPE_MS) return // 同一轮次双通道投递防重
      turnAccountedAt.set(sessionId, t)
      if (turnAccountedAt.size > 200) turnAccountedAt.delete(turnAccountedAt.keys().next().value)
    }
    celebrateUntil = Math.max(celebrateUntil, t + CELEBRATE_MS)
    // M5-5 完成音效：默认关；深夜静音段红线内不响。
    try { if (soundAllowed()) playSound() } catch { /* 音效失败不阻塞庆祝 */ }
    // M4-3 养成记账：任务完成 +TASK_XP；升级/称号解锁 → 气泡行。
    try {
      const grown = recordTaskCompleted(petState, label ?? '未命名任务', t)
      petState = grown.state
      if (grown.leveledUp) {
        celebrateMessages.unshift({ at: t, lines: [`升级到 Lv.${petState.level} 🎉`] })
      }
      for (const name of grown.unlocked) {
        celebrateMessages.unshift({ at: t, lines: [`解锁称号「${name}」✨`] })
      }
      if (celebrateMessages.length > 3) celebrateMessages.length = 3
    } catch { /* 账本记账失败不阻塞庆祝 */ }
    // M3-3 完成气泡：任务起点以来的会话事件折叠出 耗时+Token+估算费用。
    try {
      const startedAt = startedAtOverride ?? ((sessionId !== null && sessionId !== undefined && taskStarts.get(sessionId)) || t - 60_000)
      const events = sessionId !== null && sessionId !== undefined ? sessionBuffers.get(sessionId) ?? [] : []
      const usage = projectSessionCost(events, startedAt)
      const lines = taskSummaryLines(fmtDuration(t - startedAt), usage)
      const estimateId = ++celebrateSeq // 自增 id：telemetry 替换按 id 定位（同毫秒多条 celebrate 不互吞）
      celebrateMessages.unshift({ at: t, id: estimateId, lines, source: 'estimated' })
      if (celebrateMessages.length > 3) celebrateMessages.length = 3
      // M6-4：telemetry 实测 usage/费用异步替换估算（估算退为兜底；无数据保持估算）。
      try { enrichCelebrateWithTelemetry(startedAt, estimateId) } catch { /* 融合失败保持估算 */ }
    } catch { /* 用量汇总失败不阻塞庆祝 */ }
    scheduleSave()
    factsChanged()
  }
  /** 任务失败记账：零负反馈（只计 failures）+ error→disappointed 负面窗口。 */
  const onTaskFailed = () => {
    const t = now()
    errorUntil = Math.max(errorUntil, t + ERROR_MS)
    disappointedUntil = Math.max(disappointedUntil, t + ERROR_MS + DISAPPOINTED_MS)
    try {
      petState = recordFailure(petState, t).state
      scheduleSave()
    } catch { /* 账本失败不阻塞情绪窗口 */ }
    factsChanged()
  }

  // 1) 会话创建（0.1.7 异步串行 agent/created；载荷形态探针先行——M1-6）。
  // M6-3：同一 session id 的重复投递只记一次账（桌面端实测出现偶发双发 → sessions/XP 双计）。
  const seenSessions = new Set()
  subscribe('agent/created', () => ctx.on('agent/created', (payload) => {
    probe('agent/created', payload)
    const source = payload && typeof payload === 'object' ? payload.source ?? payload.kind : undefined
    const agent = payload && typeof payload === 'object' ? payload.agent : undefined
    const sid = typeof agent?.session?.id === 'string' ? agent.session.id : null
    const first = sid === null || !seenSessions.has(sid)
    if (sid !== null) {
      seenSessions.add(sid)
      if (seenSessions.size > SEEN_SESSIONS_MAX) seenSessions.delete(seenSessions.values().next().value)
    }
    if (!first) { return } // 重复投递：welcome 窗口与账本都维持首次语义
    // source 语义对齐上游（refs/whale-girl/lib/index.mjs）与 pet-state.mjs 契约：仅明确的
    // 'startup' 算新会话（welcome +SESSION_XP + 计数 + 记首见）；'resume'/'compact'/'clear'
    // 及未识别值默认归续接（+RESUME_XP，不计会话数、不记首见、不欢迎）。
    if (source === 'startup') {
      welcomeUntil = Math.max(welcomeUntil, now() + WELCOME_MS)
      petState = recordSession(petState, now()).state
    } else {
      petState = recordSessionResume(petState, now()).state
    }
    scheduleSave()
    factsChanged()
  }))

  // 2) 任务终态：0.1.7 事件流（jobs.events → 'settled'）；旧 onJobDone 兜底；都没有则跳过。
  // M6-3 实测：jobs 仅覆盖后台任务系统，chat 轮次终态由上方 session/event turn/end 承担。
  subscribe('jobs.events', () => {
    const jobs = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
    if (jobs === undefined || jobs === null) return undefined
    const onSettled = (payload) => {
      probe('jobs.settled', payload)
      const job = payload && typeof payload === 'object' ? payload.job ?? payload : undefined
      const status = job?.status
      const sessionId = job?.sessionId ?? job?.session?.id ?? null
      if (status === 'completed') {
        onTaskCompleted(job?.label, sessionId)
      } else if (status === 'failed') {
        // 失败与请求错误同一负面窗口（error 4s → disappointed 6s）；零负反馈：只计 failures。
        onTaskFailed()
      } else {
        // killed（用户取消）/teardown 中性：不计入任何情绪。
        scheduleSave()
        factsChanged()
      }
    }
    if (jobs.events && typeof jobs.events.subscribe === 'function') {
      return jobs.events.subscribe({ owners: 'all' }, (event) => {
        if (!event || event.type !== 'settled') return
        onSettled(event)
      })
    }
    if (typeof jobs.onJobDone === 'function') {
      return jobs.onJobDone((snapshot) => onSettled({ job: snapshot }))
    }
    return undefined
  })

  // 3) 请求错误：只触发情绪（零负反馈——不计失败不写回忆，账本语义在 M4）。
  subscribe('agent/request-error', () => ctx.on('agent/request-error', (payload) => {
    probe('agent/request-error', payload)
    const t = now()
    errorUntil = Math.max(errorUntil, t + ERROR_MS)
    disappointedUntil = Math.max(disappointedUntil, t + ERROR_MS + DISAPPOINTED_MS)
    factsChanged()
  }))

  // 4) 会话事件：turn/start·turn/end 边沿 → thinking（陪伴）/wait（等审批，blocked reason）。
  subscribe('session/event', () => ctx.on('session/event', (session, event) => {
    probe('session/event', { session, event })
    const id = typeof session?.id === 'string' ? session.id : null
    if (id === null || !event || typeof event.type !== 'string') return
    bufferSessionEvent(id, { ...event, time: typeof event.time === 'number' ? event.time : Date.now() })
    try { ledger.fold(event) } catch { /* 账本折叠失败不影响事实窗口 */ }
    const t = Date.now()
    // turn/end 丢失防护：每个事件处理时淘汰超时未闭合条目；该会话仍有事件流动则续期
    // （真长回合不误杀，死会话条目在最后一次事件 30min 后自愈出列）。
    pruneActiveTurns(t)
    const openTurn = activeTurns.get(id)
    if (openTurn !== undefined) openTurn.at = t
    // M6-4 状态机增强：遇挫窗口（telemetry adapter-dsh 映射语义：工具失败/llm 重试/错误收尾）。
    try {
      const kind = struggleKindOf(event)
      if (kind !== null && settings.fusion.enabled !== false) {
        strugglingUntil = Math.max(strugglingUntil, Date.now() + STRUGGLE_WINDOW_MS)
      }
    } catch { /* 遇挫折叠失败不影响事实 */ }
    // M4 活跃陪伴：上一事件到现在的差分在思考态下累加（单次封顶 ACTIVE_CAP_MS）。
    try {
      const hadActive = [...activeTurns.values()].some((entry) => entry.count > 0)
      if (hadActive) {
        const grown = recordActive(petState, t - lastActiveCheck, t)
        petState = grown.state
        // 「常驻伙伴」等活跃派生称号解锁也要走 celebrate + 气泡（与任务完成路径同待遇）。
        if (grown.unlocked.length > 0) {
          celebrateUntil = Math.max(celebrateUntil, t + CELEBRATE_MS)
          for (const title of grown.unlocked) {
            celebrateMessages.unshift({ at: t, lines: [`解锁称号「${title}」✨`] })
          }
          if (celebrateMessages.length > 3) celebrateMessages.length = 3
        }
        scheduleSave()
      }
      lastActiveCheck = t
    } catch { /* 活跃记账失败不阻塞事实 */ }
    if (event.type === 'turn/start') {
      const entry = activeTurns.get(id) ?? { count: 0, at: t }
      entry.count += 1
      entry.at = t
      activeTurns.set(id, entry)
      taskStarts.set(id, t) // M3-3：任务起点（M6-3 起每轮独立计时）
      if (taskStarts.size > TASK_STARTS_MAX) taskStarts.delete(taskStarts.keys().next().value)
      waitingSessions.delete(id) // 新回合开始，该会话不再处于等待审批
    } else if (event.type === 'turn/end') {
      const entry = activeTurns.get(id)
      if (entry !== undefined) {
        entry.count -= 1
        if (entry.count <= 0) activeTurns.delete(id)
      }
      // 载荷形态（0.2.0 实测 probe）：event={type,seq,time,data}——reason 在 event.data 内，
      // 旧代码读 event.reason 顶层恒 undefined（blocked 等审批判定因此从未真实生效）。
      const reason = event.data?.reason ?? event.reason
      const kind = reason && typeof reason === 'object' ? reason.kind : (typeof reason === 'string' ? reason : undefined)
      // wait 按会话聚合（§5.8 待审批集合）：blocked 入集合，其余边沿出集合。
      if (kind === 'blocked') waitingSessions.add(id)
      else waitingSessions.delete(id)
      // M6-3 桌面端实测修正：普通聊天轮次不产生 jobs.settled（jobs 仅后台任务系统）——
      // 轮次终态记账在此承担；completed → 完成/气泡/音效，error → 负面窗口/失败计数，
      // aborted·interrupted·max-tokens·forked·blocked 中性（用户取消/等待语义不入账）。
      const outcome = taskOutcomeOfEndReason(kind)
      if (outcome === 'completed') {
        onTaskCompleted('对话轮次', id, taskStarts.get(id))
      } else if (outcome === 'failed') {
        onTaskFailed()
      }
      taskStarts.delete(id) // 全部终态都清理起点（仅 completed 清理会让 error/aborted 等残留）
    }
    // thinking 在 snapshot 时经 computeThinking 按未超时的未闭合 turn 重算（此处无需暂存）。
    factsChanged()
  }))

  const webServer = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined
  ctx.effect(() => {
    const routes = []
    const register = (def, label) => {
      try {
        routes.push(webServer.register(def))
      } catch (error) {
        try { ctx.logger?.warn?.(`whale-pet: 路由 ${label} 注册失败：${error?.message ?? error}`) } catch {}
      }
    }

    if (webServer !== undefined) {
      // ---- 素材静态服务（bundle 不自动服务包内静态资源——实测结论见附录 B）----
      register({
        kind: 'prefix',
        path: ASSETS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405)
            res.end()
            return
          }
          let pathname
          try {
            pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://dsh.internal').pathname)
          } catch {
            res.writeHead(400)
            res.end()
            return
          }
          const rel = pathname.slice(ASSETS_PATH.length + 1)
          const fp = resolveIn(ASSETS_ROOT, rel)
          if (fp === undefined) {
            res.writeHead(403)
            res.end()
            return
          }
          if (!existsSync(fp)) {
            res.writeHead(404)
            res.end()
            return
          }
          await sendFile(res, fp, req)
        },
      }, 'assets')

      // ---- client ESM 模块服务：combo script 入口经动态 import 装载的实现模块 ----
      register({
        kind: 'prefix',
        path: CLIENT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405)
            res.end()
            return
          }
          let pathname
          try {
            pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://dsh.internal').pathname)
          } catch {
            res.writeHead(400)
            res.end()
            return
          }
          const rel = pathname.slice(CLIENT_PATH.length + 1)
          // 仅服务 lib/client/（client-graph 门禁保证 client 模块无 ../ 越界导入；
          // 旧 LIB_ROOT 兜底会把 Node half 源码同源下发浏览器，已移除）。
          // 二期放宽 .json（phase2-plan §10-4）：bbox.mjs 静态 import bbox-table.json
          // with { type:'json' }——MIME 必须按扩展名取（application/json），否则浏览器
          // 模块校验失败、整条 client 链挂死（M6-2 同类前科）。
          const fp = resolveIn(CLIENT_ROOT, rel)
          if (fp === undefined || (!fp.endsWith('.mjs') && !fp.endsWith('.json'))) {
            res.writeHead(403)
            res.end()
            return
          }
          if (!existsSync(fp)) {
            res.writeHead(404)
            res.end()
            return
          }
          res.writeHead(200, {
            'content-type': MIME[extname(fp).toLowerCase()] ?? 'text/javascript; charset=utf-8',
            'cache-control': 'no-cache',
          })
          createReadStream(fp).on('error', () => res.destroy()).pipe(res)
        },
      }, 'client modules')

      // ---- 事实快照（轮询兜底 + SSE 断线重连后的首拉）----
      register({
        kind: 'exact',
        path: STATE_PATH,
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              json(res, 405, { error: 'method not allowed; use GET' }, { allow: 'GET' })
              return
            }
            json(res, 200, snapshot(), { 'cache-control': 'no-store' })
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }, 'state')

      // ---- M1-6 探针端点：最近 50 条原始事件载荷（GUI 实测用）----
      register({
        kind: 'exact',
        path: PROBE_PATH,
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              json(res, 405, { error: 'method not allowed; use GET' }, { allow: 'GET' })
              return
            }
            json(res, 200, { events: probeLog }, { 'cache-control': 'no-store' })
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }, 'probe')

      // ---- M3-5 数据路由：用量账本快照（仪表板数据源）----
      register({
        kind: 'exact',
        path: USAGE_PATH,
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              json(res, 405, { error: 'method not allowed; use GET' }, { allow: 'GET' })
              return
            }
            json(res, 200, ledger.snapshot(), { 'cache-control': 'no-store' })
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }, 'usage')

      // ---- 余额代理（M5 stub → 二期升级，phase2-plan §10-2）：apiKey 配置后代理
      // DeepSeek /user/balance（Bearer），透传 {is_available, balance_infos}（+ok:true）；
      // 未配置/空白 key → 保持一期 stub 原样。明文 key 不写日志、不回显。
      register({
        kind: 'exact',
        path: BALANCE_PATH,
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              json(res, 405, { error: 'method not allowed; use GET' }, { allow: 'GET' })
              return
            }
            const apiKey = typeof settings.balanceLow?.apiKey === 'string' ? settings.balanceLow.apiKey.trim() : ''
            if (apiKey === '') {
              json(res, 200, { ok: false, reason: 'balance-not-configured' }, { 'cache-control': 'no-store' })
              return
            }
            const payload = await fetchBalance(apiKey)
            // 上游失败映射 502（reason 为短码/上游状态，不含 key）
            json(res, payload.ok === true ? 200 : 502, payload, { 'cache-control': 'no-store' })
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }, 'balance')

      // ---- 二期天气代理（phase2-plan §10-1）：GET ?city=<中文城市> → Open-Meteo
      // geocoding+forecast 两跳，无密钥；query 缺省回落 settings.weather.city；
      // 两者皆空 = 休眠（不外联，空 city 会令 buildGeocodingUrl 抛 TypeError）；
      // 上游失败 → 502 { ok:false, reason }；成功内存缓存 10min。
      register({
        kind: 'exact',
        path: WEATHER_PATH,
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              json(res, 405, { error: 'method not allowed; use GET' }, { allow: 'GET' })
              return
            }
            let city = ''
            try {
              const q = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('city')
              if (typeof q === 'string') city = q.trim()
            } catch { city = '' }
            if (city === '') {
              const configured = settings.weather?.city
              city = typeof configured === 'string' ? configured.trim() : ''
            }
            if (city === '') {
              json(res, 200, { ok: false, reason: 'weather-not-configured' }, { 'cache-control': 'no-store' })
              return
            }
            const cached = weatherCache.get(city)
            if (cached !== undefined && Date.now() - cached.at < WEATHER_CACHE_MS) {
              json(res, 200, cached.payload, { 'cache-control': 'no-store' })
              return
            }
            const payload = await fetchWeather(city)
            if (payload.ok === true) {
              weatherCache.set(city, { at: Date.now(), payload })
              if (weatherCache.size > WEATHER_CACHE_MAX) {
                weatherCache.delete(weatherCache.keys().next().value)
              }
              json(res, 200, payload, { 'cache-control': 'no-store' })
              return
            }
            json(res, 502, payload, { 'cache-control': 'no-store' })
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }, 'weather')

      // ---- M5-6 设置路由（二期 r2 修订，phase2-plan §10-3）：GET/POST 响应一律经脱敏出口
      // （apiKey 恒 '' + apiKeySet）；POST 先做 apiKey 三态合并再 normalizeSettings 落盘。
      register({
        kind: 'exact',
        path: SETTINGS_PATH,
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              json(res, 200, redactSettings(settings), { 'cache-control': 'no-store' })
              return
            }
            if (req.method !== 'POST') {
              json(res, 405, { error: 'method not allowed; use GET/POST' }, { allow: 'GET, POST' })
              return
            }
            let raw = ''
            for await (const chunk of req) raw += chunk
            let body
            try { body = JSON.parse(raw) } catch { body = null }
            // 坏 body 视为整体无效：保留现配置（不因脏请求清空用户设置）。
            if (body !== null && typeof body === 'object') {
              // apiKey 三态合并（r2）：undefined/''→保留现值、null→清除、非空字符串→覆盖（trim）。
              // 必须先解析回 body 再 normalizeSettings——设置卡每次改任意开关都全量 POST 其持有的
              // 脱敏值 ''，若按字面落盘会把已存 key 清空（余额提醒静默失效）。key 不写任何日志。
              const bl = body.balanceLow !== null && typeof body.balanceLow === 'object' ? body.balanceLow : (body.balanceLow = {})
              bl.apiKey = resolveIncomingApiKey(
                typeof settings.balanceLow?.apiKey === 'string' ? settings.balanceLow.apiKey : '',
                bl.apiKey,
              )
              settings = normalizeSettings(body)
              saveSettings()
            }
            // POST 响应与 GET 同规则脱敏：刚写入的明文 key 不得泄回任意同源页面。
            json(res, 200, redactSettings(settings), { 'cache-control': 'no-store' })
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }, 'settings')

      // ---- M6-4 周报/外部投递递送入口：POST {text, ms?} → 气泡（状态机不参与）----
      register({
        kind: 'exact',
        path: ANNOUNCE_PATH,
        handler: async (req, res) => {
          try {
            if (req.method !== 'POST') {
              json(res, 405, { error: 'method not allowed; use POST' }, { allow: 'POST' })
              return
            }
            let raw = ''
            for await (const chunk of req) raw += chunk
            let body
            try { body = JSON.parse(raw) } catch { body = null }
            const text = body !== null && typeof body === 'object' ? body.text : null
            if (typeof text !== 'string' || text.length === 0 || text.length > 500) {
              json(res, 400, { error: 'text (1-500 chars) required' })
              return
            }
            const t = now()
            if (t - lastAnnounceAt < 2000) {
              json(res, 429, { error: 'rate limited (2s)' })
              return
            }
            lastAnnounceAt = t
            const ms = Math.min(60000, Math.max(3000, Number(body?.ms) || 8000))
            announce = { until: t + ms, text, ms }
            factsChanged()
            json(res, 200, { ok: true, until: announce.until }, { 'cache-control': 'no-store' })
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }, 'announce')

      // ---- M6-4 洞察台词刷新（5min 周期 + 启动后 5s 首刷；挂 dispose）----
      insightsTimer = setInterval(() => { void refreshInsights() }, 300000)
      initialInsights = setTimeout(() => { void refreshInsights() }, 5000)

      // ---- SSE 事件流：事实窗口即时下发 ----
      register({
        kind: 'exact',
        path: EVENTS_PATH,
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405)
            res.end()
            return
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
          if (typeof res.flushHeaders === 'function') res.flushHeaders()
          res.write('retry: 3000\n\n')
          res.write(`data: ${JSON.stringify({ type: 'facts', facts: snapshot() })}\n\n`)
          sseClients.add(res)
          let heartbeat = null
          if (typeof res.on === 'function') {
            res.on('close', () => {
              clearInterval(heartbeat)
              sseClients.delete(res)
            })
          }
          heartbeat = setInterval(() => {
            try { res.write(': ping\n\n') } catch { /* 断连由 close 清理 */ }
          }, 25000)
        },
      }, 'events')
    }

    return () => {
      // dispose 幂等可重入：事件退订、路由注销、SSE 连接清理、账本/缓冲释放。
      ledger.dispose()
      sessionBuffers.clear()
      taskStarts.clear()
      seenSessions.clear()
      activeTurns.clear()
      waitingSessions.clear()
      weatherCache.clear() // 二期天气代理缓存（fetch 为请求级超时，无长驻定时器可清）
      celebrateMessages.length = 0
      clearTimeout(saveTimer)
      clearInterval(insightsTimer)
      if (initialInsights !== null) clearTimeout(initialInsights)
      insights = []
      announce = null
      strugglingUntil = 0
      saveState() // 末次落盘：disable/卸载前保留最终账本
      if (soundChild !== null) { try { soundChild.kill() } catch {} soundChild = null }
      for (const off of disposers.splice(0)) {
        try { off?.() } catch {}
      }
      for (const res of sseClients) {
        try { res.end() } catch {}
      }
      sseClients.clear()
      for (const off of routes.splice(0)) {
        try { off?.() } catch {}
      }
    }
  }, 'whale-pet: facts/sse/routes')
}
