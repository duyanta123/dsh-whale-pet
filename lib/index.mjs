// dsh-whale-pet Node half：事实窗口（Node 唯一输出面）+ agent 事件接线 + SSE + 静态资源路由。
// 契约（0.1.7-rc.2 实测基线，详见开发计划附录 B）：
// - 只监听 agent/created（异步串行），全仓库禁用 agent/session-start；
// - 任务终态经 ctx.jobs 事件流（0.1.7 删除 jobs.onJobDone；双轨守卫：事件流优先，旧 API 兜底）；
// - 会话思考/等待审批经 session/event 的 turn/start·turn/end 边沿聚合；
// - 零 @deepseek-ai 包导入：ctx.* 全部守卫式使用（可选插件失败隔离，缺席即降级）；
// - 事实窗口 { name, until }（绝对截止时间，非消费式快照），经 /state（轮询兜底）与
//   /events（SSE 即时）下发；级联顺序 = 负面优先（error > disappointed > welcome）。
// - M1-6 探针：原始载荷环形缓冲在 /probe 端点（GUI 实测用，结论记开发计划附录 B）。
import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WELCOME_MS, CELEBRATE_MS, ERROR_MS, DISAPPOINTED_MS } from './client/logic.mjs'

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

const ASSETS_ROOT = join(PACKAGE_ROOT, 'assets')
const CLIENT_ROOT = join(PACKAGE_ROOT, 'lib', 'client')
const LIB_ROOT = join(PACKAGE_ROOT, 'lib')

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
    if (celebrateUntil > t) windows.push({ name: 'celebrate', until: celebrateUntil })
    return { windows, wait: waiting, thinking, ts: t }
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
    }
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
      } else if (status === 'failed') {
        // 失败与请求错误同一负面窗口（error 4s → disappointed 6s）。
        const t = now()
        errorUntil = Math.max(errorUntil, t + ERROR_MS)
        disappointedUntil = Math.max(disappointedUntil, t + ERROR_MS + DISAPPOINTED_MS)
      }
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
    if (event.type === 'turn/start') {
      activeTurns.set(id, (activeTurns.get(id) ?? 0) + 1)
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
      // dispose 幂等可重入：事件退订、路由注销、SSE 连接清理。
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
