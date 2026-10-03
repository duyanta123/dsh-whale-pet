// 二期 ⑦ meme-catalog 单测（fetch/now/random 全注入、固定时钟/固定随机源；规格 phase2-plan §2.7 + §14 meme 行）。
// 覆盖：URL 模式（001/474 边界、3 位补零、越界抛错）；探测成功走 CDN / 失败静默回退本地 30 张池；
// TTL 节流（内不重探、过期重探、边界、失败同样节流）；3s 超时守卫（mock 定时器）；
// 并发 refresh 去重；pick 同步永不 throw（恒 reject fetch / 脏随机源）；dispose 清理；enabled=false 空转。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MEME_CDN_BASE, MEME_CDN_COUNT, MEME_CDN_PROBE_TTL_MS,
  cdnPreviewUrl, cdnRawUrl, createMemeCatalog,
} from '../lib/client/meme-catalog.mjs'
import { MEME_POOL } from '../lib/client/bubble.mjs'

// ---- 固定时钟 / 固定随机源（确定性） ----
function fakeClock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
      return t
    },
  }
}
function seqRandom(values) {
  let i = 0
  return () => values[i++ % values.length]
}
function countingFetch(counter, res = () => ({ ok: true })) {
  return async (url) => {
    counter.calls += 1
    counter.urls.push(url)
    return res(url)
  }
}
const flush = () => new Promise((resolve) => setImmediate(resolve))

// ---- URL 模式与契约常量 ----
test('契约常量与 URL 模式（详案 §2.4 / 计划 §2.7：001/474 边界、3 位补零）', () => {
  assert.equal(MEME_CDN_BASE, 'https://bjumymxtfpfswthiusfr.storage.supabase.co/storage/v1/object/public/ai-meme')
  assert.equal(MEME_CDN_COUNT, 474)
  assert.equal(MEME_CDN_PROBE_TTL_MS, 600_000)
  // 预览：BASE/0_preview/meme/NNN.webp
  assert.equal(cdnPreviewUrl(1), `${MEME_CDN_BASE}/0_preview/meme/001.webp`)
  assert.equal(cdnPreviewUrl(7), `${MEME_CDN_BASE}/0_preview/meme/007.webp`)
  assert.equal(cdnPreviewUrl(42), `${MEME_CDN_BASE}/0_preview/meme/042.webp`)
  assert.equal(cdnPreviewUrl(474), `${MEME_CDN_BASE}/0_preview/meme/474.webp`)
  // 原图：BASE/meme/NNN.webp（无 0_preview 段）
  assert.equal(cdnRawUrl(1), `${MEME_CDN_BASE}/meme/001.webp`)
  assert.equal(cdnRawUrl(474), `${MEME_CDN_BASE}/meme/474.webp`)
  assert.ok(!cdnRawUrl(1).includes('0_preview'))
  assert.ok(cdnPreviewUrl(1).includes('/0_preview/meme/'))
  // 越界/非整数抛 RangeError（0 / 475 / 小数 / NaN / Infinity / 字符串 / null / undefined）
  for (const bad of [0, -1, 475, 1.5, Number.NaN, Infinity, '1', null, undefined]) {
    assert.throws(() => cdnPreviewUrl(bad), RangeError, `preview 应抛错：${bad}`)
    assert.throws(() => cdnRawUrl(bad), RangeError, `raw 应抛错：${bad}`)
  }
})

// ---- 初始态：保守走本地池 ----
test('初始 source=local：pick 走本地 30 张池（确定性随机、不触发探测）', () => {
  assert.equal(MEME_POOL.length, 30)
  assert.ok(MEME_POOL.every((u) => /^\/api\/whale-pet\/assets\/memes\/meme-\d{3}\.webp$/.test(u)))
  const neverProbe = () => {
    throw new Error('不该发起探测')
  }
  const cat = createMemeCatalog({ fetchImpl: neverProbe, now: fakeClock().now, random: () => 0 })
  assert.equal(cat.source(), 'local')
  assert.deepEqual(cat.pick(() => 0), { url: MEME_POOL[0], source: 'local' })
  assert.deepEqual(cat.pick(() => 0.999), { url: MEME_POOL[29], source: 'local' }) // floor(0.999*30)=29
})

// ---- 探测成功走 CDN ----
test('探测成功走 CDN（伪 fetch 200：ok:true 与 status 形响应；随机抽号 001/474）', async () => {
  const counter = { calls: 0, urls: [] }
  const clock = fakeClock()
  const cat = createMemeCatalog({ fetchImpl: countingFetch(counter), now: clock.now, random: seqRandom([0, 0.999]) })
  assert.equal(await cat.refresh(), 'cdn')
  assert.equal(cat.source(), 'cdn')
  assert.equal(counter.calls, 1)
  assert.equal(counter.urls[0], cdnPreviewUrl(1), 'random=0 → 抽中编号 001')
  // pick 同步走 CDN：下一随机 0.999 → 编号 474
  assert.deepEqual(cat.pick(), { url: cdnPreviewUrl(474), source: 'cdn' })
  // status 形响应（无 ok 字段）按 2xx 判成功
  const cat2 = createMemeCatalog({ fetchImpl: async () => ({ status: 200 }), now: clock.now, random: () => 0 })
  assert.equal(await cat2.refresh(), 'cdn')
  // ok:false / 404 判失败
  const cat3 = createMemeCatalog({ fetchImpl: async () => ({ ok: false, status: 404 }), now: clock.now, random: () => 0 })
  assert.equal(await cat3.refresh(), 'local')
})

// ---- 探测失败静默回退本地 ----
test('探测失败静默回退本地：reject / 同步 throw / fetch 缺席，refresh 恒不 reject、pick 恒本地池', async () => {
  const clock = fakeClock()
  const cat1 = createMemeCatalog({ fetchImpl: () => Promise.reject(new Error('offline')), now: clock.now, random: () => 0 })
  const cat2 = createMemeCatalog({ fetchImpl: () => { throw new Error('sync boom') }, now: clock.now, random: () => 0 })
  const cat3 = createMemeCatalog({ fetchImpl: null, now: clock.now, random: () => 0 })
  for (const cat of [cat1, cat2, cat3]) {
    assert.equal(await cat.refresh(), 'local')
    assert.equal(cat.source(), 'local')
    const p = cat.pick(() => 0.5)
    assert.equal(p.source, 'local')
    assert.ok(MEME_POOL.includes(p.url))
  }
})

// ---- TTL 节流 ----
test('TTL 节流：TTL 内不重复探测、过期重探（恰好 = TTL 判过期）', async () => {
  const counter = { calls: 0, urls: [] }
  const clock = fakeClock()
  const cat = createMemeCatalog({ fetchImpl: countingFetch(counter), now: clock.now, random: () => 0 })
  await cat.refresh()
  assert.equal(counter.calls, 1)
  clock.advance(MEME_CDN_PROBE_TTL_MS - 1)
  assert.equal(await cat.refresh(), 'cdn')
  assert.equal(counter.calls, 1, 'TTL 内不重复探测')
  clock.advance(1) // 距上次探测恰好 = TTL → 过期
  await cat.refresh()
  assert.equal(counter.calls, 2, '过期重探')
})

test('失败探测同样受 TTL 节流（不风暴重试）', async () => {
  const counter = { calls: 0, urls: [] }
  const clock = fakeClock()
  const cat = createMemeCatalog({
    fetchImpl: countingFetch(counter, () => Promise.reject(new Error('down'))),
    now: clock.now,
    random: () => 0,
  })
  assert.equal(await cat.refresh(), 'local')
  assert.equal(counter.calls, 1)
  clock.advance(MEME_CDN_PROBE_TTL_MS - 1)
  await cat.refresh()
  assert.equal(counter.calls, 1, '失败后 TTL 内不重试')
  clock.advance(1)
  assert.equal(await cat.refresh(), 'local')
  assert.equal(counter.calls, 2)
})

test('来源切换：先失败回本地，TTL 过期重探成功翻回 CDN', async () => {
  const clock = fakeClock()
  let fail = true
  const cat = createMemeCatalog({
    fetchImpl: async () => {
      if (fail) throw new Error('down')
      return { ok: true }
    },
    now: clock.now,
    random: () => 0,
  })
  assert.equal(await cat.refresh(), 'local')
  clock.advance(MEME_CDN_PROBE_TTL_MS + 1)
  fail = false
  assert.equal(await cat.refresh(), 'cdn')
  assert.deepEqual(cat.pick(() => 0), { url: cdnPreviewUrl(1), source: 'cdn' })
})

// ---- 3s 超时守卫（mock 定时器，确定性） ----
test('探测超时 3s 守卫：挂起 fetch → 超时回本地，并 abort 真实连接', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let captured = null
  const cat = createMemeCatalog({
    fetchImpl: (url, opts) => {
      captured = opts.signal
      return new Promise(() => {}) // 永不 settle
    },
    now: fakeClock().now,
    random: () => 0,
  })
  const p = cat.refresh()
  t.mock.timers.tick(3000)
  assert.equal(await p, 'local')
  assert.equal(cat.source(), 'local')
  assert.equal(captured.aborted, true, '超时后对真实连接 abort')
})

test('probeTimeoutMs 可注入（非默认 3s 也生效）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const cat = createMemeCatalog({
    fetchImpl: () => new Promise(() => {}),
    now: fakeClock().now,
    random: () => 0,
    probeTimeoutMs: 50,
  })
  const p = cat.refresh()
  t.mock.timers.tick(50)
  assert.equal(await p, 'local')
})

// ---- 并发 refresh 去重 ----
test('并发 refresh 去重：在途探测复用同一次 fetch', async () => {
  let calls = 0
  let resolveFetch = null
  const cat = createMemeCatalog({
    fetchImpl: () => new Promise((resolve) => {
      calls += 1
      resolveFetch = resolve
    }),
    now: fakeClock().now,
    random: () => 0,
  })
  const p1 = cat.refresh()
  const p2 = cat.refresh()
  await flush()
  assert.equal(calls, 1, '在途探测期间不重复发起')
  resolveFetch({ ok: true })
  assert.equal(await p1, 'cdn')
  assert.equal(await p2, 'cdn')
})

// ---- dispose 清理 ----
test('dispose 清理：在途结果不落地、超时 timer 清除、refresh 空转、pick 同步面不受影响', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  let resolveFetch = null
  let signal = null
  const cat = createMemeCatalog({
    fetchImpl: (url, opts) => {
      calls += 1
      signal = opts.signal
      return new Promise((resolve) => {
        resolveFetch = resolve
      })
    },
    now: fakeClock().now,
    random: () => 0,
  })
  cat.refresh()
  await flush()
  assert.equal(calls, 1)
  assert.notEqual(signal, null)
  cat.dispose()
  resolveFetch({ ok: true }) // dispose 之后探测才成功
  await flush()
  assert.equal(cat.source(), 'local', 'dispose 后在途探测成功不落地')
  t.mock.timers.tick(3000)
  assert.equal(signal.aborted, false, 'dispose 已清超时 timer（abort 不再触发）')
  await cat.refresh()
  assert.equal(calls, 1, 'dispose 后 refresh 空转（不再发 fetch）')
  const picked = cat.pick(() => 0)
  assert.equal(picked.source, 'local')
  assert.ok(MEME_POOL.includes(picked.url), 'dispose 后 pick 仍同步可用')
})

// ---- pick 同步永不 throw ----
test('pick 同步永不 throw：恒 reject fetch + 脏随机源（NaN/1/-0.5/Infinity/非函数）均回本地合法 URL', async () => {
  const cat = createMemeCatalog({ fetchImpl: () => Promise.reject(new Error('x')), now: fakeClock().now, random: () => 0 })
  await cat.refresh()
  for (const dirty of [Number.NaN, 1, -0.5, Infinity, 'x', null]) {
    const p = cat.pick(() => dirty)
    assert.equal(p.source, 'local')
    assert.ok(MEME_POOL.includes(p.url), `dirty=${dirty} → ${p.url}`)
  }
  // refresh 也不因脏随机源 throw（探测编号 sanitize：NaN → 编号 001）
  const counter = { calls: 0, urls: [] }
  const cat2 = createMemeCatalog({ fetchImpl: countingFetch(counter), now: fakeClock().now, random: () => Number.NaN })
  assert.equal(await cat2.refresh(), 'cdn')
  assert.equal(counter.urls[0], cdnPreviewUrl(1))
  assert.deepEqual(cat2.pick(() => Number.NaN), { url: cdnPreviewUrl(1), source: 'cdn' })
  // pick 传非函数 → 按 0 处理，不 throw
  assert.equal(cat2.pick('not-a-function').url, cdnPreviewUrl(1))
})

// ---- enabled=false：CDN 关 ----
test('enabled=false：CDN 关 → 恒本地，refresh 空转不发 fetch', async () => {
  const counter = { calls: 0, urls: [] }
  const cat = createMemeCatalog({
    fetchImpl: countingFetch(counter),
    now: fakeClock().now,
    random: () => 0,
    enabled: false,
  })
  assert.equal(await cat.refresh(), 'local')
  assert.equal(counter.calls, 0)
  assert.equal(cat.pick(() => 0).source, 'local')
  assert.equal(cat.source(), 'local')
})
