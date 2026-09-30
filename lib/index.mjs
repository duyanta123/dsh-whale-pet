// dsh-whale-pet Node half：事实窗口（Node 唯一输出面）+ agent 事件接线 + SSE + 静态资源路由。
// 契约（0.1.7-rc.2 实测基线，详见开发计划附录 B）：
// - 只监听 agent/created（异步串行），全仓库禁用 agent/session-start；
// - 任务终态经 ctx.jobs 事件流（0.1.7 删除 jobs.onJobDone；双轨守卫：事件流优先，旧 API 兜底）；
// - 会话思考/等待审批经 session/event 的 turn/start·turn/end 边沿聚合；
// - 零 @deepseek-ai 包导入：ctx.* 全部守卫式使用（可选插件失败隔离，缺席即降级）；
// - 事实窗口 { name, until }（绝对截止时间，非消费式快照），经 /state（轮询兜底）与
//   /events（SSE 即时）下发；级联顺序 = 负面优先（error > disappointed > welcome）。
// - M1-6 探针：原始载荷环形缓冲在 /probe 端点（GUI 实测用，结论记开发计划附录 B）。
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WELCOME_MS, CELEBRATE_MS, ERROR_MS, DISAPPOINTED_MS } from './client/logic.mjs'
import { isNightMute } from './client/care.mjs'
import { normalizeSettings } from './client/settings.mjs'
import {
  INITIAL_STATE, recordTaskCompleted, recordFailure, recordSession,
  recordSessionResume, recordActive,
} from './pet-state.mjs'
import { normalizeState, serializeState } from './persistence.mjs'
import { createUsageLedger } from './usage-ledger.mjs'
import { projectSessionCost } from './cost-projection.mjs'
import { taskSummaryLines, fmtDuration } from './usage.mjs'

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
export const SETTINGS_PATH = `${ROUTE_PREFIX}/settings`

const ASSETS_ROOT = join(PACKAGE_ROOT, 'assets')
const CLIENT_ROOT = join(PACKAGE_ROOT, 'lib', 'client')
const LIB_ROOT = join(PACKAGE_ROOT, 'lib')

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
  const range = req.headers.range
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [s, e] = range.replace('bytes=', '').split('-').map(Number)
    const start = Number.isFinite(s) ? s : 0
    const end = Number.isFinite(e) ? Math.min(e, st.size - 1) : st.size - 1
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
  /** 原子写：同目录 .tmp + rename；失败不阻塞插件（账本仅本次运行有效）。 */
  const saveState = () => {
    try {
      mkdirSync(join(STATE_FILE, '..'), { recursive: true })
      const tmp = `${STATE_FILE}.tmp`
      writeFileSync(tmp, serializeState(petState))
      renameSync(tmp, STATE_FILE)
    } catch {
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
  const saveSettings = () => {
    try {
      mkdirSync(join(SETTINGS_FILE, '..'), { recursive: true })
      const tmp = `${SETTINGS_FILE}.tmp`
      writeFileSync(tmp, JSON.stringify(settings, null, 2))
      renameSync(tmp, SETTINGS_FILE)
    } catch { /* 设置持久化失败不阻塞插件 */ }
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

  // ---- M3 用量账本 + 会话事件缓冲 + 任务起点跟踪 ----
  const ledger = createUsageLedger({ windowDays: 7 })
  const sessionBuffers = new Map() // sessionId → 事件数组（cap 600，M3-3 任务用量数据源）
  const taskStarts = new Map() // sessionId → 任务起点 ms（首个 turn/start 记账）
  const celebrateMessages = [] // 任务完成信息（最新在前，cap 3；facts 携带给气泡）

  const bufferSessionEvent = (sessionId, ev) => {
    let buffer = sessionBuffers.get(sessionId)
    if (buffer === undefined) {
      buffer = []
      sessionBuffers.set(sessionId, buffer)
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
  let thinking = false
  let waiting = false
  const activeTurns = new Map() // sessionId → 未闭合 turn 计数

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
    return { windows, wait: waiting, thinking, ts: t, pet: petState }
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

  // 1) 会话创建（0.1.7 异步串行 agent/created；载荷形态探针先行——M1-6）。
  subscribe('agent/created', () => ctx.on('agent/created', (payload) => {
    probe('agent/created', payload)
    const source = payload && typeof payload === 'object' ? payload.source ?? payload.kind : undefined
    // source==='resume'/'compact' 视为续接（不欢迎）；其余（含未识别）视为新会话。
    if (source !== 'resume' && source !== 'compact') {
      welcomeUntil = Math.max(welcomeUntil, now() + WELCOME_MS)
      petState = recordSession(petState, now()).state
    } else {
      petState = recordSessionResume(petState, now()).state
    }
    scheduleSave()
    factsChanged()
  }))

  // 2) 任务终态：0.1.7 事件流（jobs.events → 'settled'）；旧 onJobDone 兜底；都没有则跳过。
  subscribe('jobs.events', () => {
    const jobs = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
    if (jobs === undefined || jobs === null) return undefined
    const onSettled = (payload) => {
      probe('jobs.settled', payload)
      const job = payload && typeof payload === 'object' ? payload.job ?? payload : undefined
      const status = job?.status
      if (status === 'completed') {
        celebrateUntil = Math.max(celebrateUntil, now() + CELEBRATE_MS)
        // M5-5 完成音效：默认关；深夜静音段红线内不响。
        try { if (soundAllowed()) playSound() } catch { /* 音效失败不阻塞庆祝 */ }
        // M4-3 养成记账：任务完成 +TASK_XP；升级/称号解锁 → 气泡行。
        try {
          const grown = recordTaskCompleted(petState, job?.label ?? '未命名任务', now())
          petState = grown.state
          if (grown.leveledUp) {
            celebrateMessages.unshift({ at: now(), lines: [`升级到 Lv.${petState.level} 🎉`] })
          }
          for (const name of grown.unlocked) {
            celebrateMessages.unshift({ at: now(), lines: [`解锁称号「${name}」✨`] })
          }
          if (celebrateMessages.length > 3) celebrateMessages.length = 3
        } catch { /* 账本记账失败不阻塞庆祝 */ }
        // M3-3 完成气泡：任务起点以来的会话事件折叠出 耗时+Token+估算费用。
        try {
          const sessionId = job?.sessionId ?? job?.session?.id ?? null
          const startedAt = (sessionId !== null && taskStarts.get(sessionId)) || now() - 60_000
          const events = sessionId !== null ? sessionBuffers.get(sessionId) ?? [] : []
          const usage = projectSessionCost(events, startedAt)
          const lines = taskSummaryLines(fmtDuration(now() - startedAt), usage)
          celebrateMessages.unshift({ at: now(), lines })
          if (celebrateMessages.length > 3) celebrateMessages.pop()
        } catch { /* 用量汇总失败不阻塞庆祝 */ }
      } else if (status === 'failed') {
        // 失败与请求错误同一负面窗口（error 4s → disappointed 6s）；零负反馈：只计 failures。
        const t = now()
        errorUntil = Math.max(errorUntil, t + ERROR_MS)
        disappointedUntil = Math.max(disappointedUntil, t + ERROR_MS + DISAPPOINTED_MS)
        try {
          petState = recordFailure(petState, t).state
          scheduleSave()
        } catch { /* 账本失败不阻塞情绪窗口 */ }
      }
      scheduleSave()
      // killed（用户取消）/teardown 中性：不计入任何情绪。
      factsChanged()
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
    // M4 活跃陪伴：上一事件到现在的差分在思考态下累加（单次封顶 ACTIVE_CAP_MS）。
    try {
      const t = Date.now()
      const hadActive = [...activeTurns.values()].some((count) => count > 0)
      if (hadActive) {
        petState = recordActive(petState, t - lastActiveCheck, t).state
        scheduleSave()
      }
      lastActiveCheck = t
    } catch { /* 活跃记账失败不阻塞事实 */ }
    if (event.type === 'turn/start') {
      activeTurns.set(id, (activeTurns.get(id) ?? 0) + 1)
      if (!taskStarts.has(id)) taskStarts.set(id, Date.now()) // M3-3：任务起点
      waiting = false // 新回合开始，不再处于等待审批
    } else if (event.type === 'turn/end') {
      const count = (activeTurns.get(id) ?? 0) - 1
      if (count <= 0) activeTurns.delete(id)
      else activeTurns.set(id, count)
      const blocked = event.reason?.kind === 'blocked' || event.reason === 'blocked'
      waiting = blocked
    }
    thinking = false
    for (const count of activeTurns.values()) {
      if (count > 0) { thinking = true; break }
    }
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
          // lib/client 优先；父级 lib/ 兜底（renderer.mjs 的 ../assets-manifest.mjs 等契约模块）。
          let fp = resolveIn(CLIENT_ROOT, rel)
          if (fp === undefined) fp = resolveIn(LIB_ROOT, rel)
          if (fp === undefined || !fp.endsWith('.mjs')) {
            res.writeHead(403)
            res.end()
            return
          }
          if (!existsSync(fp)) {
            res.writeHead(404)
            res.end()
            return
          }
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
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

      // ---- 余额代理 stub（M5 余额提醒与 💰 预留；client 不直接外联）----
      register({
        kind: 'exact',
        path: BALANCE_PATH,
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              json(res, 405, { error: 'method not allowed; use GET' }, { allow: 'GET' })
              return
            }
            json(res, 200, { ok: false, reason: 'balance-not-configured' }, { 'cache-control': 'no-store' })
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }, 'balance')

      // ---- M5-6 设置路由：GET 读归一化配置；POST 校验落盘（原子写）并即时生效 ----
      register({
        kind: 'exact',
        path: SETTINGS_PATH,
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              json(res, 200, settings, { 'cache-control': 'no-store' })
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
              settings = normalizeSettings(body)
              saveSettings()
            }
            json(res, 200, settings, { 'cache-control': 'no-store' })
          } catch (error) {
            json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }, 'settings')

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
      celebrateMessages.length = 0
      clearTimeout(saveTimer)
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
