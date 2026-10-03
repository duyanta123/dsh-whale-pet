// agent/created source 分支单测：source 语义对齐 pet-state.mjs 契约——仅 'startup' 算新会话
// （welcome +SESSION_XP + 计数 + 记首见）；'resume'/'compact'/'clear' 及未识别值默认归续接
// （+RESUME_XP，不计会话数、不记首见、不欢迎）。另覆盖 §5.8 wait 跨会话聚合回归
// （A 会话 blocked 后，B 会话开新回合不得清除 A 的等待事实）。
// lib/index.mjs 在 import 期解析 STATE_FILE/SETTINGS_FILE，故必须先设 DSH_HOME 临时目录
// 再动态 import（node --test 每文件独立子进程，不影响其他测试文件）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { RESUME_XP, SESSION_XP } from '../lib/pet-state.mjs'

const home = mkdtempSync(join(tmpdir(), 'whale-pet-source-'))
process.env.DSH_HOME = home
const { apply, STATE_PATH } = await import('../lib/index.mjs')

// ---- 伪宿主：on 捕获事件处理器；webServer.register 捕获路由；effect 收集 dispose ----
const handlers = new Map()
const routes = new Map()
const effects = []
apply({
  logger: { info() {}, warn() {} },
  on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event) },
  get: (key) => key === 'webServer'
    ? { register: (def) => { routes.set(def.path, def.handler); return () => routes.delete(def.path) } }
    : undefined,
  effect: (fn) => effects.push(fn),
})
let disposePlugin = null
for (const fn of effects) disposePlugin = fn() ?? disposePlugin

after(() => {
  try { disposePlugin?.() } catch {}
  try { rmSync(home, { recursive: true, force: true }) } catch {}
})

/** 触发 agent/created（唯一接线入口；账本与事实窗口经 /state 断言）。 */
const emitCreated = (source, sid) => {
  handlers.get('agent/created')({ source, agent: { session: { id: sid } } })
}

/** 触发 session/event（turn 边沿形态：0.2.0 probe 实测 reason 在 event.data 内）。 */
const emitSessionEvent = (sid, event) => {
  handlers.get('session/event')({ id: sid }, event)
}

/** 假响应：满足 json()（writeHead+end(body)）写法。 */
class FakeRes extends Writable {
  constructor() {
    super()
    this.statusCode = 0
    this.headers = null
    this.chunks = []
  }

  writeHead(code, headers) {
    this.statusCode = code
    this.headers = headers ?? null
  }

  _write(chunk, _enc, cb) {
    this.chunks.push(Buffer.from(chunk))
    cb()
  }
}

const getState = async () => {
  const handler = routes.get(STATE_PATH)
  assert.ok(typeof handler === 'function', 'state 路由未注册')
  const res = new FakeRes()
  const finished = new Promise((resolve) => res.on('finish', resolve))
  await handler({ method: 'GET', url: STATE_PATH, headers: {} }, res)
  await finished
  return JSON.parse(Buffer.concat(res.chunks).toString('utf8'))
}

let sidSeq = 0
const nextSid = () => `test-session-${++sidSeq}`

// ---- 续接分支在前（firstSeenAt 尚未置位、无 welcome 残留，断言才干净）----

test('source=resume/compact/clear/未识别 → 续接：+RESUME_XP、不计会话数、不记首见、无 welcome', async () => {
  for (const source of ['resume', 'compact', 'clear', 'unknown-kind', undefined]) {
    const before = await getState()
    emitCreated(source, nextSid())
    const state = await getState()
    assert.equal(state.pet.xp - before.pet.xp, RESUME_XP, `source=${String(source)} 应按续接 +${RESUME_XP}`)
    assert.equal(state.pet.stats.sessions, before.pet.stats.sessions, `source=${String(source)} 不计会话数`)
    assert.equal(state.pet.stats.firstSeenAt, null, `source=${String(source)} 不记首见`)
    assert.equal(
      state.windows.some((w) => w.name === 'welcome'),
      false,
      `source=${String(source)} 不应弹 welcome`,
    )
  }
})

test('source=startup → 新会话：+SESSION_XP、会话数+1、记首见、welcome 窗口', async () => {
  const before = await getState()
  emitCreated('startup', nextSid())
  const state = await getState()
  assert.equal(state.pet.xp - before.pet.xp, SESSION_XP)
  assert.equal(state.pet.stats.sessions, before.pet.stats.sessions + 1)
  assert.notEqual(state.pet.stats.firstSeenAt, null)
  assert.equal(state.windows.some((w) => w.name === 'welcome'), true)
})

test('同一 session id 重复投递只记一次账（seenSessions 去重）', async () => {
  const sid = nextSid()
  const before = await getState()
  emitCreated('startup', sid)
  const once = await getState()
  emitCreated('startup', sid) // 双发：welcome 窗口与账本维持首次语义
  const twice = await getState()
  assert.equal(once.pet.xp - before.pet.xp, SESSION_XP)
  assert.equal(twice.pet.xp - once.pet.xp, 0)
  assert.equal(twice.pet.stats.sessions, once.pet.stats.sessions)
})

// ---- §5.8 wait 跨会话聚合（回归：wait 曾是跟随最后一条 turn 边沿的全局布尔）----

test('wait 跨会话聚合：A blocked 后 B 开新回合不清除 A 的等待事实；A 新回合解除自己的 blocked', async () => {
  const sidA = nextSid()
  const sidB = nextSid()
  emitSessionEvent(sidA, { type: 'turn/start' })
  emitSessionEvent(sidA, { type: 'turn/end', data: { reason: { kind: 'blocked' } } })
  let state = await getState()
  assert.equal(state.wait, true, 'A blocked → wait')
  assert.equal(state.thinking, false)

  emitSessionEvent(sidB, { type: 'turn/start' })
  state = await getState()
  assert.equal(state.thinking, true, 'B 活跃 → thinking')
  assert.equal(state.wait, true, 'B 开新回合不得清除 A 的待审批事实')

  emitSessionEvent(sidB, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  state = await getState()
  assert.equal(state.thinking, false)
  assert.equal(state.wait, true, 'B 正常收尾仍不影响 A 的待审批事实')

  emitSessionEvent(sidA, { type: 'turn/start' }) // 同会话新回合解除自身 blocked（§4）
  state = await getState()
  assert.equal(state.wait, false)
  assert.equal(state.thinking, true)
  emitSessionEvent(sidA, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  state = await getState()
  assert.equal(state.wait, false)
  assert.equal(state.thinking, false)
})
