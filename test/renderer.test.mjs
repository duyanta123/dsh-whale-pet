// renderer 回归门禁（2026-09-30 事故固化）：renderer.mjs 引用未导入符号（REACT_ASSETS）
// 属运行时 ReferenceError——node --test 从不装载渲染器，浏览器侧又被 tick try/catch 吞掉，
// 热区反应（M2 核心）整条静默失效。本测试用最小 DOM stub 真实调用 show()，让此类
// 「用到未导入符号」的错误在 Node 侧必然抛出、必然红灯。
// stub 范围仅覆盖 renderer.mjs 的实际触面（createElement/classList/src 赋值/matchMedia）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** 极简元素 stub：只实现 renderer 用到的面。 */
function makeEl(tag) {
  const el = {
    tag,
    className: '',
    style: {},
    dataset: {},
    children: [],
    src: '',
    muted: false,
    autoplay: false,
    playsInline: false,
    preload: '',
    onended: undefined,
    appendChild(child) { el.children.push(child) },
    removeAttribute() {},
    remove() {},
    load() {},
    pause() {},
    play() { return { catch() {} } },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    contains: () => false,
    querySelector: () => null,
    classList: {
      add() {}, remove() {},
      toggle() {},
    },
  }
  return el
}

/** 装载 renderer（注入 DOM stub）；每次 test 重新装载保证隔离。 */
async function loadRenderer({ reducedMotion = false } = {}) {
  const media = makeEl('img')
  const stage = makeEl('div')
  stage.querySelector = () => media
  const head = makeEl('head')
  let styleExists = false
  globalThis.document = {
    getElementById: () => (styleExists ? makeEl('style') : null),
    createElement: (tag) => {
      if (tag === 'style') styleExists = true
      return makeEl(tag)
    },
    head,
  }
  globalThis.window = {
    matchMedia: () => ({ matches: reducedMotion }),
  }
  // Node 22 的全局 navigator 只有 getter，须 defineProperty 覆写
  Object.defineProperty(globalThis, 'navigator', { value: { deviceMemory: 8, hardwareConcurrency: 16 }, configurable: true })
  globalThis.Image = class {
    constructor() { this.onload = null; this.onerror = null; this._src = '' }
    set src(v) {
      this._src = v
      queueMicrotask(() => { if (typeof this.onload === 'function') this.onload() })
    }
    get src() { return this._src }
  }
  // 每次全新 import，避免模块内无状态假设被污染（renderer 本身无模块级可变态）
  const mod = await import(`../lib/client/renderer.mjs?case=${Date.now()}-${Math.random()}`)
  const onOnceEndedCalls = []
  const renderer = mod.createRenderer({ stage, onOnceEnded: () => onOnceEndedCalls.push(Date.now()) })
  return { renderer, stage, media, onOnceEndedCalls }
}

test('renderer.show：react-head 热区反应链可播放（REACT_ASSETS 导入回归门禁）', async () => {
  const { renderer, media } = await loadRenderer()
  assert.doesNotThrow(() => renderer.show('react-head'))
  await new Promise((r) => setTimeout(r, 20)) // 等 image probe 微任务
  assert.match(String(media.src), /react-head\.webp$/)
})

test('renderer.show：三分区热区链全部可解析', async () => {
  for (const zone of ['head', 'belly', 'tail']) {
    const { renderer, media } = await loadRenderer()
    renderer.show(`react-${zone}`)
    await new Promise((r) => setTimeout(r, 20))
    assert.match(String(media.src), new RegExp(`react-${zone}\\.webp$`), `zone=${zone}`)
  }
})

test('renderer.show：常规状态（idle/walk/night/struggling）走契约链', async () => {
  for (const state of ['idle', 'walk', 'night', 'struggling']) {
    const { renderer, media } = await loadRenderer()
    renderer.show(state)
    await new Promise((r) => setTimeout(r, 20))
    assert.notEqual(String(media.src), '', `state=${state} 应落到链首 image`)
  }
})

test('renderer.show：幂等（同状态不重复装载）', async () => {
  const { renderer } = await loadRenderer()
  renderer.show('idle')
  const first = renderer.current()
  renderer.show('idle')
  assert.equal(renderer.current(), first)
})

test('renderer：低配降级（reducedMotion）走静态图链', async () => {
  const { renderer, media } = await loadRenderer({ reducedMotion: true })
  renderer.show('walk') // walk 链首是 img，第二候选是 webm——静态模式下 webm 由 img 探测自然跳过
  await new Promise((r) => setTimeout(r, 20))
  assert.notEqual(String(media.src), '')
})
