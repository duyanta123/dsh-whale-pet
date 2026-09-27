// dsh-whale-pet Node half：宿主路由（素材/客户端模块/事实快照/SSE）+ agent 事件接线 + 持久化。
// 契约（0.1.7-rc.2 基线）：
// - 只监听 agent/created（异步串行），全仓库禁用 agent/session-start；
//   任务完成经 ctx.jobs.events.subscribe 事件流（0.1.7 删除了 jobs.onJobDone，双轨守卫）；
// - 零 @deepseek-ai 包导入：ctx.* 全部守卫式使用（可选插件失败隔离，缺席即降级）；
// - 事实窗口 { name, until } 是 Node half 的唯一输出面，client 经同源 SSE + 轮询快照消费；
// - 持久化写 <dshHome>/whale-pet/state.json（.tmp + rename 原子写，防抖，dispose 幂等落盘）。
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
export const INTERACT_PATH = `${ROUTE_PREFIX}/interact`

/** 素材目录与 client ESM 模块目录（都在包内）。 */
const ASSETS_ROOT = join(PACKAGE_ROOT, 'assets')
const CLIENT_ROOT = join(PACKAGE_ROOT, 'lib', 'client')

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

/** DSH 主目录（$DSH_HOME，默认 ~/.dsh）；不导入 @deepseek-ai/dsh-home-paths，env 优先、existsSync 兜底。 */
function resolveDshHome() {
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME)
  const home = process.env.USERPROFILE || process.env.HOME || PACKAGE_ROOT
  return join(home, '.dsh')
}

const STATE_FILE = join(resolveDshHome(), 'whale-pet', 'state.json')

/** 事实窗口：Node half 输出面（M1-7 正式接线；M0 输出恒定空闲快照）。 */
function snapshot(now = Date.now()) {
  return { facts: [], ts: now }
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
  // ---- SSE 连接面（M1-7 正式使用；M0 先立端点）----
  const sseClients = new Set()
  const broadcast = (payload) => {
    const line = `data: ${JSON.stringify(payload)}\n\n`
    for (const res of sseClients) {
      try { res.write(line) } catch { sseClients.delete(res) }
    }
  }

  // ---- 素材/账本持久化（M4-2 正式使用；M0 先立读写函数）----
  let saveTimer = null
  const scheduleSave = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveState, 1000)
  }

  function saveState() {
    try {
      mkdirSync(join(STATE_FILE, '..'), { recursive: true })
      const tmp = `${STATE_FILE}.tmp`
      writeFileSync(tmp, JSON.stringify({}))
      renameSync(tmp, STATE_FILE)
    } catch {}
  }

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
          const fp = resolveIn(CLIENT_ROOT, rel)
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

      // ---- SSE 事件流：事实窗口即时下发；25s 心跳防代理空闲断开 ----
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
          res.write(`data: ${JSON.stringify({ type: 'snapshot', facts: [] })}\n\n`)
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
      // dispose 幂等可重入：路由注销、SSE 连接清理、落盘计时器、末次落盘。
      clearTimeout(saveTimer)
      for (const res of sseClients) {
        try { res.end() } catch {}
      }
      sseClients.clear()
      for (const off of routes.splice(0)) {
        try { off?.() } catch {}
      }
    }
  }, 'whale-pet: routes')
}
