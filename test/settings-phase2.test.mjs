// 二期设置体系与宿主路由单测（第 9 个测试文件，归集成工程师所有——phase2-plan §0/§9/§10/§11-步骤1/§14）：
// ① 六新分区（game/festival/weather/balanceLow/memeCdn/character）normalizeSettings 逐字段
//    纠正/钳制/默认值红线（balanceLow.enabled 默认 false）；
// ② resolveIncomingApiKey 三态（''/undefined→保留、null→清除、非空→覆盖 trim）；
// ③ 脱敏出口 redactSettings（GET/POST 响应同规则：apiKey 恒 '' + apiKeySet）；
// ④ 宿主路由接线（lib/index.mjs apply + 伪 ctx + 注入 fetch + DSH_HOME 临时目录）：
//    weather 休眠不外联 / 两跳代理 200 透传 code·tempC / 内存缓存 / 上游失败 502 / query 优先·settings 回落；
//    balance 未配置保持一期 stub 原样 / 配置后 Bearer 代理 / 上游失败 502；
//    settings GET 脱敏 + POST 三态合并 + POST 响应脱敏；client 路由 .json 放宽与 MIME（§10-4）。
// ⑤ 设置卡每日任务领取门闩（createSettingsCard + 最小 fake React 渲染成长区）：
//    claimable 按 QUEST_POOL 定义的 def.target 判定（回归：槽对象仅 {id,progress,claimed}，
//    曾误读 slot.target → 恒 false、按钮永久灰、进度恒 0/0、好感奖励不可领取）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import {
  normalizeSettings, DEFAULT_SETTINGS, LIMITS,
  resolveIncomingApiKey, redactSettings, createSettingsCard,
} from '../lib/client/settings.mjs'
import { QUEST_POOL } from '../lib/client/growth.mjs'

// ==================== ① 六新分区 normalizeSettings ====================

test('六新分区默认值（phase2-plan §9：balanceLow.enabled 默认 false 红线）', () => {
  const d = normalizeSettings(null)
  assert.equal(d.game.enabled, true) // 用户主动游玩项
  assert.equal(d.festival.enabled, true) // 纯视觉面
  assert.equal(d.weather.enabled, true)
  assert.equal(d.weather.city, '') // 空 = 不查询不换装（dormant）
  assert.equal(d.balanceLow.enabled, false) // 隐私/强主动项默认关
  assert.equal(d.balanceLow.thresholdCNY, 5)
  assert.equal(d.balanceLow.apiKey, '')
  assert.equal(d.memeCdn.enabled, true) // 详案 §2.4 client 直链例外
  assert.equal(d.character, 'musume')
  assert.deepEqual([...LIMITS.balanceThresholdCNY], [1, 100])
  // 默认表冻结且不含明文 key
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS))
})

test('game/festival 分区：enabled 逐字段纠正', () => {
  const out = normalizeSettings({ game: { enabled: 'true' }, festival: { enabled: 0 } })
  assert.equal(out.game.enabled, true)
  assert.equal(out.festival.enabled, false)
  assert.equal(normalizeSettings({ game: { enabled: 'yes' } }).game.enabled, false) // 字符串强制转换
  assert.equal(normalizeSettings({ game: { enabled: 1 } }).game.enabled, true)
  assert.equal(normalizeSettings({ festival: {} }).festival.enabled, true) // 缺省回默认
})

test('weather 分区：enabled 纠正 + city 字符串保留/回默认', () => {
  const out = normalizeSettings({ weather: { enabled: 'true', city: '上海' } })
  assert.equal(out.weather.enabled, true)
  assert.equal(out.weather.city, '上海')
  const bad = normalizeSettings({ weather: { enabled: 'yes', city: 123 } })
  assert.equal(bad.weather.enabled, false)
  assert.equal(bad.weather.city, '') // 非字符串回默认（dormant）
})

test('balanceLow 分区：纠正 + 阈值钳制 [1,100]（两端共用同一校验）', () => {
  const out = normalizeSettings({ balanceLow: { enabled: 'true', thresholdCNY: 999, apiKey: 'sk-x' } })
  assert.equal(out.balanceLow.enabled, true)
  assert.equal(out.balanceLow.thresholdCNY, 100) // 钳上限
  assert.equal(out.balanceLow.apiKey, 'sk-x') // asStr 保留（明文只落服务端 settings.json）
  assert.equal(normalizeSettings({ balanceLow: { thresholdCNY: 0 } }).balanceLow.thresholdCNY, 1) // 钳下限
  assert.equal(normalizeSettings({ balanceLow: { thresholdCNY: '3.6' } }).balanceLow.thresholdCNY, 4) // 取整
  const bad = normalizeSettings({ balanceLow: { thresholdCNY: 'abc', apiKey: 42 } })
  assert.equal(bad.balanceLow.thresholdCNY, 5) // 非法回默认
  assert.equal(bad.balanceLow.apiKey, '') // 非字符串回默认
  assert.equal(normalizeSettings({ balanceLow: { enabled: 1 } }).balanceLow.enabled, true)
})

test('memeCdn 分区：布尔纠正', () => {
  assert.equal(normalizeSettings({ memeCdn: { enabled: '1' } }).memeCdn.enabled, true)
  assert.equal(normalizeSettings({ memeCdn: { enabled: 0 } }).memeCdn.enabled, false)
  assert.equal(normalizeSettings({ memeCdn: { enabled: 'yes' } }).memeCdn.enabled, false)
  assert.equal(normalizeSettings({}).memeCdn.enabled, true) // 缺省回默认
})

test('character 顶层标量：仅 classic 通过，未知/脏数据一律回 musume', () => {
  assert.equal(normalizeSettings({ character: 'classic' }).character, 'classic')
  for (const bad of ['CLASSIC', 'classic ', 'musume2', 'giraffe', 123, true, null, {}, []]) {
    assert.equal(normalizeSettings({ character: bad }).character, 'musume', `character=${String(bad)}`)
  }
  assert.equal(normalizeSettings({}).character, 'musume')
})

test('六分区坏分区形状（null/标量）不拖垮其他字段', () => {
  const out = normalizeSettings({
    game: null, festival: 'x', weather: 7, balanceLow: true, memeCdn: [], character: 'classic',
  })
  assert.equal(out.game.enabled, true)
  assert.equal(out.festival.enabled, true)
  assert.equal(out.weather.enabled, true)
  assert.equal(out.weather.city, '')
  assert.equal(out.balanceLow.enabled, false)
  assert.equal(out.memeCdn.enabled, true)
  assert.equal(out.character, 'classic')
})

// ==================== ② resolveIncomingApiKey 三态 ====================

test('resolveIncomingApiKey：三态（\'\'/undefined→保留、null→清除、非空→覆盖 trim）', () => {
  assert.equal(resolveIncomingApiKey('sk-old', ''), 'sk-old') // 设置卡全量回传脱敏值 → 保留
  assert.equal(resolveIncomingApiKey('sk-old', undefined), 'sk-old') // body 未携带 → 保留
  assert.equal(resolveIncomingApiKey('sk-old', '   '), 'sk-old') // 纯空白按 '' 语义保留（显式清除只能发 null）
  assert.equal(resolveIncomingApiKey('sk-old', null), '') // 显式清除
  assert.equal(resolveIncomingApiKey('sk-old', ' sk-new '), 'sk-new') // 覆盖 + trim
  assert.equal(resolveIncomingApiKey('', 'sk-new'), 'sk-new')
  assert.equal(resolveIncomingApiKey('sk-old', 123), 'sk-old') // 非字符串垃圾 → 保留（不误清）
  assert.equal(resolveIncomingApiKey(undefined, undefined), '')
  assert.equal(resolveIncomingApiKey(undefined, null), '')
})

// ==================== ③ 脱敏出口 redactSettings ====================

test('redactSettings：GET/POST 同规则（apiKey 恒 \'\' + apiKeySet 双向）', () => {
  const withKey = normalizeSettings({ balanceLow: { apiKey: 'sk-secret' } })
  const r1 = redactSettings(withKey)
  assert.equal(r1.balanceLow.apiKey, '')
  assert.equal(r1.balanceLow.apiKeySet, true)
  const r2 = redactSettings(normalizeSettings(null))
  assert.equal(r2.balanceLow.apiKey, '')
  assert.equal(r2.balanceLow.apiKeySet, false)
  // 深拷贝：不改动服务端持有的 settings 本体
  assert.equal(withKey.balanceLow.apiKey, 'sk-secret')
  // 脱敏输出整体回灌 normalizeSettings（设置卡全量 POST）安全：apiKeySet 被忽略、'' 按三态保留
  const round = normalizeSettings(r1)
  assert.equal(round.balanceLow.apiKey, '')
  assert.equal('apiKeySet' in round.balanceLow, false) // 未知字段忽略
  assert.equal(normalizeSettings(r2).balanceLow.apiKey, '')
})

// ==================== ④ 宿主路由接线（lib/index.mjs） ====================
// DSH_HOME 指向临时目录：lib/index.mjs 在 import 期解析 STATE/SETTINGS/TELEMETRY 路径，
// 故必须先设 env 再动态 import；node --test 每文件独立子进程，不影响其他测试文件。

const home = mkdtempSync(join(tmpdir(), 'whale-pet-phase2-'))
process.env.DSH_HOME = home
const { apply, WEATHER_PATH, BALANCE_PATH, SETTINGS_PATH, CLIENT_PATH } = await import('../lib/index.mjs')

const routes = new Map()
const effects = []
apply({
  logger: { info() {}, warn() {} },
  on: () => () => {},
  get: (key) => key === 'webServer'
    ? { register: (def) => { routes.set(def.path, def.handler); return () => routes.delete(def.path) } }
    : undefined,
  effect: (fn) => effects.push(fn),
})
let disposePlugin = null
for (const fn of effects) disposePlugin = fn() ?? disposePlugin // 装配路由（insights 定时器随 dispose 清理）

after(() => {
  try { disposePlugin?.() } catch {}
  try { rmSync(home, { recursive: true, force: true }) } catch {}
})

/** 假响应：同时满足 json()（writeHead+end(body)）与 sendFile 管道（Writable）两种写法。 */
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

const callRoute = async (path, req) => {
  // 路由查找与宿主同语义：exact 命中优先，否则最长 prefix（assets/client 为 kind:'prefix'）。
  const handler = routes.get(path) ?? [...routes.entries()]
    .filter(([p]) => path.startsWith(`${p}/`))
    .sort((a, b) => b[0].length - a[0].length)[0]?.[1]
  if (handler === undefined) throw new Error(`route not registered: ${path}`)
  const res = new FakeRes()
  const finished = new Promise((resolve) => res.on('finish', resolve))
  await handler(req, res)
  await finished
  const body = Buffer.concat(res.chunks).toString('utf8')
  let json = null
  try { json = JSON.parse(body) } catch { json = null }
  return { status: res.statusCode, headers: res.headers ?? {}, body, json }
}

const getReq = (path) => ({ method: 'GET', url: path, headers: {} })
const postReq = (path, body) => ({
  method: 'POST',
  url: path,
  headers: {},
  [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)) },
})

/** fetch 注入：记录调用并在结束时还原全局。 */
const withFetch = async (impl, fn) => {
  const real = globalThis.fetch
  globalThis.fetch = impl
  try { return await fn() } finally { globalThis.fetch = real }
}
const jsonRes = (data) => ({ ok: true, status: 200, json: async () => data })

// ---- settings 路由：GET 脱敏 + POST 三态 ----

test('settings 路由：GET 脱敏（apiKey 恒 \'\' + apiKeySet）且六分区齐全', async () => {
  await callRoute(SETTINGS_PATH, postReq(SETTINGS_PATH, {})) // 复位为默认
  const out = await callRoute(SETTINGS_PATH, getReq(SETTINGS_PATH))
  assert.equal(out.status, 200)
  assert.equal(out.json.balanceLow.apiKey, '')
  assert.equal(out.json.balanceLow.apiKeySet, false)
  assert.equal(out.json.balanceLow.enabled, false) // §9 红线经路由出口仍成立
  assert.equal(out.json.game.enabled, true)
  assert.equal(out.json.festival.enabled, true)
  assert.equal(out.json.weather.enabled, true)
  assert.equal(out.json.weather.city, '')
  assert.equal(out.json.memeCdn.enabled, true)
  assert.equal(out.json.character, 'musume')
})

test('settings 路由：POST 非空 apiKey 覆盖 + 响应脱敏 + 阈值钳制', async () => {
  const out = await callRoute(SETTINGS_PATH, postReq(SETTINGS_PATH, {
    balanceLow: { apiKey: ' sk-test-abc ', thresholdCNY: 999, enabled: true },
  }))
  assert.equal(out.status, 200)
  assert.equal(out.json.balanceLow.apiKey, '') // 响应脱敏：明文不泄回
  assert.equal(out.json.balanceLow.apiKeySet, true)
  assert.equal(out.json.balanceLow.thresholdCNY, 100) // LIMITS 钳制经路由生效
  assert.equal(out.json.balanceLow.enabled, true)
  assert.ok(!out.body.includes('sk-test-abc'), 'POST 响应体不得含明文 key')
})

test('settings 路由：POST 三态①保留（全量回传 \'\' / 不带 balanceLow / 分区形状坏）', async () => {
  // 前置：确保已存 key
  await callRoute(SETTINGS_PATH, postReq(SETTINGS_PATH, { balanceLow: { apiKey: ' sk-keep-me ' } }))
  // 全量回传脱敏值 ''：不得清空已存 key（r2 修订的核心场景）
  const keep1 = await callRoute(SETTINGS_PATH, postReq(SETTINGS_PATH, { balanceLow: { enabled: true, apiKey: '' } }))
  assert.equal(keep1.json.balanceLow.apiKeySet, true)
  // body 完全不带 balanceLow 分区
  const keep2 = await callRoute(SETTINGS_PATH, postReq(SETTINGS_PATH, { care: { sedentaryMin: 30 } }))
  assert.equal(keep2.json.balanceLow.apiKeySet, true)
  // 分区形状坏（标量）
  const keep3 = await callRoute(SETTINGS_PATH, postReq(SETTINGS_PATH, { balanceLow: 'garbage' }))
  assert.equal(keep3.json.balanceLow.apiKeySet, true)
  assert.ok(!keep3.body.includes('sk-keep-me'))
})

test('settings 路由：POST 三态②清除（null）→ balance 回一期 stub', async () => {
  await callRoute(SETTINGS_PATH, postReq(SETTINGS_PATH, { balanceLow: { apiKey: ' sk-tmp ' } }))
  const out = await callRoute(SETTINGS_PATH, postReq(SETTINGS_PATH, { balanceLow: { apiKey: null } }))
  assert.equal(out.json.balanceLow.apiKeySet, false)
  const bal = await callRoute(BALANCE_PATH, getReq(BALANCE_PATH))
  assert.equal(bal.status, 200)
  assert.deepEqual(bal.json, { ok: false, reason: 'balance-not-configured' }) // 一期 stub 原样
})

// ---- balance 路由：stub / Bearer 代理 / 失败 502 ----

test('balance 路由：配置 apiKey 后代理 DeepSeek（Bearer）并透传响应', async () => {
  await callRoute(SETTINGS_PATH, postReq(SETTINGS_PATH, { balanceLow: { apiKey: ' sk-proxy-1 ' } }))
  const seen = []
  await withFetch(async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.authorization })
    return jsonRes({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '3.50' }] })
  }, async () => {
    const out = await callRoute(BALANCE_PATH, getReq(BALANCE_PATH))
    assert.equal(out.status, 200)
    assert.deepEqual(out.json, {
      ok: true,
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '3.50' }],
    })
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(seen[0].auth, 'Bearer sk-proxy-1') // trim 后的 key、Bearer 鉴权
})

test('balance 路由：上游失败 → 502 { ok:false, reason }（连接失败 / 非 2xx / 坏载荷）', async () => {
  const throwOut = await withFetch(async () => { throw new Error('deepseek-down') },
    () => callRoute(BALANCE_PATH, getReq(BALANCE_PATH)))
  assert.equal(throwOut.status, 502)
  assert.equal(throwOut.json.ok, false)
  assert.equal(throwOut.json.reason, 'deepseek-down')
  const httpOut = await withFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }),
    () => callRoute(BALANCE_PATH, getReq(BALANCE_PATH)))
  assert.equal(httpOut.status, 502)
  assert.equal(httpOut.json.reason, 'upstream-http-401') // 短码不含 key
})

// ---- weather 路由：休眠 / 两跳代理 / 缓存 / 失败 502 / query 优先·settings 回落 ----

test('weather 路由：城市未配置 = 休眠（不外联，空 city 不触发 buildGeocodingUrl）', async () => {
  await callRoute(SETTINGS_PATH, postReq(SETTINGS_PATH, {})) // 复位默认（weather.city=''）
  let calls = 0
  await withFetch(async () => { calls += 1; throw new Error('must not be called') }, async () => {
    const out = await callRoute(WEATHER_PATH, getReq(WEATHER_PATH))
    assert.equal(out.status, 200)
    assert.deepEqual(out.json, { ok: false, reason: 'weather-not-configured' })
  })
  assert.equal(calls, 0)
})

test('weather 路由：中文城市两跳代理 200，透传 code/tempC，契约形状恰四键', async () => {
  const urls = []
  const out = await withFetch(async (url) => {
    urls.push(String(url))
    const u = String(url)
    if (u.startsWith('https://geocoding-api.open-meteo.com')) {
      return jsonRes({ results: [{ latitude: 31.23, longitude: 121.47 }] })
    }
    return jsonRes({ current: { weather_code: 61, temperature_2m: 12.3 } })
  }, () => callRoute(WEATHER_PATH, getReq(`${WEATHER_PATH}?city=${encodeURIComponent('上海')}`)))
  assert.equal(out.status, 200)
  assert.deepEqual(out.json, { ok: true, code: 61, tempC: 12.3, city: '上海' })
  assert.equal(urls.length, 2)
  assert.ok(urls[0].includes(`name=${encodeURIComponent('上海')}&count=1&language=zh&format=json`), urls[0])
  assert.ok(urls[0].startsWith('https://geocoding-api.open-meteo.com/v1/search'))
  assert.ok(urls[1].includes('latitude=31.23&longitude=121.47&current=weather_code,temperature_2m&timezone=auto'), urls[1])
  assert.ok(urls[1].startsWith('https://api.open-meteo.com/v1/forecast'))
  // 内存缓存 10min：同城市第二次调用不再外联
  const second = await withFetch(async (url) => { urls.push(String(url)); throw new Error('cache hit must not refetch') },
    () => callRoute(WEATHER_PATH, getReq(`${WEATHER_PATH}?city=${encodeURIComponent('上海')}`)))
  assert.equal(second.status, 200)
  assert.deepEqual(second.json, { ok: true, code: 61, tempC: 12.3, city: '上海' })
  assert.equal(urls.length, 2)
})

test('weather 路由：上游失败 → 502 { ok:false, reason }（连接失败 / 城市未命中 / 坏 forecast）', async () => {
  const net = await withFetch(async () => { throw new Error('network-down') },
    () => callRoute(WEATHER_PATH, getReq(`${WEATHER_PATH}?city=${encodeURIComponent('漠河')}`)))
  assert.equal(net.status, 502)
  assert.equal(net.json.ok, false)
  assert.equal(net.json.reason, 'network-down')
  const noCity = await withFetch(async () => jsonRes({ results: [] }),
    () => callRoute(WEATHER_PATH, getReq(`${WEATHER_PATH}?city=${encodeURIComponent('亚特兰蒂斯')}`)))
  assert.equal(noCity.status, 502)
  assert.deepEqual(noCity.json, { ok: false, reason: 'city-not-found' })
  const badFc = await withFetch(async (url) => {
    if (String(url).startsWith('https://geocoding-api.open-meteo.com')) return jsonRes({ results: [{ latitude: 1, longitude: 2 }] })
    return jsonRes({ missing: true })
  }, () => callRoute(WEATHER_PATH, getReq(`${WEATHER_PATH}?city=${encodeURIComponent('虚境')}`)))
  assert.equal(badFc.status, 502)
  assert.deepEqual(badFc.json, { ok: false, reason: 'bad-forecast' })
})

test('weather 路由：query 优先于 settings.weather.city，缺省回落配置城市', async () => {
  await callRoute(SETTINGS_PATH, postReq(SETTINGS_PATH, { weather: { city: '北京' } }))
  const urls = []
  const impl = async (url) => {
    urls.push(String(url))
    if (String(url).startsWith('https://geocoding-api.open-meteo.com')) {
      return jsonRes({ results: [{ latitude: 30.5, longitude: 114.3 }] })
    }
    return jsonRes({ current: { weather_code: 0, temperature_2m: 20 } })
  }
  await withFetch(impl, async () => {
    // query 显式城市优先
    const q = await callRoute(WEATHER_PATH, getReq(`${WEATHER_PATH}?city=${encodeURIComponent('广州')}`))
    assert.equal(q.status, 200)
    assert.equal(q.json.city, '广州')
    assert.ok(urls.some((u) => u.includes(`name=${encodeURIComponent('广州')}`)))
    // query 缺省 → 回落 settings.weather.city
    const fallback = await callRoute(WEATHER_PATH, getReq(WEATHER_PATH))
    assert.equal(fallback.status, 200)
    assert.equal(fallback.json.city, '北京')
    assert.ok(urls.some((u) => u.includes(`name=${encodeURIComponent('北京')}`)))
  })
  await callRoute(SETTINGS_PATH, postReq(SETTINGS_PATH, {})) // 复位，避免影响后续
})

// ---- client 模块路由：.json 放宽 + MIME 按扩展名（§10-4） ----

test('client 路由：bbox-table.json 可服务且 content-type 为 application/json（import with type:json 前提）', async () => {
  const out = await callRoute(`${CLIENT_PATH}/bbox-table.json`, getReq(`${CLIENT_PATH}/bbox-table.json`))
  assert.equal(out.status, 200)
  assert.equal(out.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(out.json._meta.version, 1)
})

test('client 路由：.mjs 仍以 text/javascript 下发（不回归一期行为）', async () => {
  const out = await callRoute(`${CLIENT_PATH}/settings.mjs`, getReq(`${CLIENT_PATH}/settings.mjs`))
  assert.equal(out.status, 200)
  assert.equal(out.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.ok(out.body.includes('normalizeSettings'))
})

// ==================== ⑤ 设置卡每日任务领取门闩（r2 回归） ====================

/**
 * 最小 fake React：useState 按调用序号注种子（SettingsCard 顺序：0=pet, 1=settings,
 * 2=savedAt, 3=apiKeyDraft, 4=keyConfigured, 5=growthSnap）；useEffect 不执行
 * （挂载期 fetch/interval 不触发），createElement 产出可遍历的 {tag, props, children}。
 */
function fakeReact(seedByIndex) {
  let i = 0
  return {
    createElement: (tag, props, ...children) => ({ tag, props: props ?? {}, children }),
    useState: (init) => {
      const v = Object.prototype.hasOwnProperty.call(seedByIndex, i) ? seedByIndex[i] : init
      i += 1
      return [v, () => {}]
    },
    useEffect: () => {},
    useRef: (init) => ({ current: init }),
  }
}

/** 深度遍历伪元素树按 props.key 找元素（children 展开一层、跳过字符串/null）。 */
const findByKey = (node, key) => {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (node.props?.key === key) return node
  for (const child of [].concat(node.children ?? [])) {
    const hit = findByKey(child, key)
    if (hit !== null) return hit
  }
  return null
}

test('设置卡每日任务：达标槽 claimable 为真且点击触达 claimQuest（回归：target 取 QUEST_POOL 定义）', () => {
  const patDef = QUEST_POOL.find((q) => q.id === 'pat-3')
  assert.equal(patDef.target, 3) // 池定义 pat-3 target=3；槽对象本身只有 {id,progress,claimed}
  const growthSnap = {
    affinity: 4,
    signin: null,
    quests: { date: '2026-10-3', slots: [{ id: 'pat-3', progress: patDef.target, claimed: false }], allClaimed: false },
    achievements: [],
  }
  const claimed = []
  const Card = createSettingsCard(fakeReact({ 1: normalizeSettings(null), 5: growthSnap }), {
    growth: { snapshot: () => growthSnap, claimQuest: (id) => { claimed.push(id) } },
  })
  const row = findByKey(Card(), 'quest:pat-3')
  assert.ok(row, '任务行应渲染')
  const [textSpan, claimBtn] = row.children
  // 进度文案：达标槽显示 3/3（修复前读 slot.target → 恒 '0/0'）
  const text = [].concat(textSpan.children).join('')
  assert.ok(text.includes(`摸头 3 次　${patDef.target}/${patDef.target}`), text)
  assert.ok(text.includes(`（+${patDef.reward.affinity} 好感）`), text)
  // 领取门闩打开：不透明/指针（修复前恒 .45 + default）
  assert.equal(claimBtn.props.style.opacity, '1')
  assert.equal(claimBtn.props.style.cursor, 'pointer')
  assert.equal(claimBtn.children[0], '领取')
  // 点击触达宿主 claimQuest（修复前 onClick 首行 if (!claimable) return 恒拦截）
  claimBtn.props.onClick()
  assert.deepEqual(claimed, ['pat-3'])
})

test('设置卡每日任务：未达标/已领取槽按钮保持禁用态，进度按 def.target 显示', () => {
  const growthSnap = {
    affinity: 0,
    signin: null,
    quests: {
      date: '2026-10-3',
      slots: [{ id: 'pat-3', progress: 1, claimed: false }, { id: 'signin-1', progress: 1, claimed: true }],
      allClaimed: false,
    },
    achievements: [],
  }
  const Card = createSettingsCard(fakeReact({ 1: normalizeSettings(null), 5: growthSnap }), {
    growth: { snapshot: () => growthSnap },
  })
  const tree = Card()
  const pat = findByKey(tree, 'quest:pat-3')
  assert.ok(pat, 'pat-3 行应渲染')
  assert.ok([].concat(pat.children[0].children).join('').includes('摸头 3 次　1/3'))
  assert.equal(pat.children[1].props.style.opacity, '.45')
  assert.equal(pat.children[1].children[0], '领取')
  const signin = findByKey(tree, 'quest:signin-1')
  assert.ok(signin, 'signin-1 行应渲染')
  assert.equal(signin.children[1].children[0], '已领 ✓')
  assert.equal(signin.children[1].props.style.opacity, '.45')
})
