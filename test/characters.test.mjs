// 角色注册表单测（二期 ⑧）：链序主备互换纯函数（注入式——stateAssets 由测试供给，
// 无时钟/随机源参与，全部用例确定性）。规格 docs/phase2-plan.md §2.8/§14。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHARACTERS, normalizeCharacterId, swapChains } from '../lib/client/characters.mjs'
import { STATE_ASSETS } from '../lib/client/assets-manifest.mjs'

const img = (file, extra = {}) => ({ file, kind: 'image', playback: 'loop', motion: null, ...extra })

test('CHARACTERS 注册表：恰好 musume/classic 两角色，id 与键一致且整体冻结', () => {
  assert.deepEqual(Object.keys(CHARACTERS), ['musume', 'classic'])
  assert.ok(Object.isFrozen(CHARACTERS))
  for (const [key, def] of Object.entries(CHARACTERS)) {
    assert.equal(def.id, key)
    assert.ok(Object.isFrozen(def))
    assert.ok(typeof def.label === 'string' && def.label.length > 0, `label 非空：${key}`)
  }
  assert.equal(CHARACTERS.musume.label, '鲸鱼娘（musume）')
  assert.equal(CHARACTERS.classic.label, '经典小鱼干（classic）')
})

test('normalizeCharacterId：仅 classic 原样通过，其余（含脏数据）一律回 musume', () => {
  assert.equal(normalizeCharacterId('classic'), 'classic')
  assert.equal(normalizeCharacterId('musume'), 'musume')
  for (const dirty of [undefined, null, '', 'CLASSIC', 'Classic', ' classic', 'classic ', 'gpt5', 0, 1, true, {}, [], Symbol('x')]) {
    assert.equal(normalizeCharacterId(dirty), 'musume', `脏值应回 musume：${String(dirty)}`)
  }
})

test('swapChains 非 classic 角色：原样返回入参（同一引用，零拷贝）', () => {
  assert.equal(swapChains(STATE_ASSETS, 'musume'), STATE_ASSETS)
  assert.equal(swapChains(STATE_ASSETS, undefined), STATE_ASSETS)
  assert.equal(swapChains(STATE_ASSETS, 'CLASSIC'), STATE_ASSETS) // 大小写不符 = 脏值 = musume 路径
  assert.equal(swapChains(STATE_ASSETS, 42), STATE_ASSETS)
})

test('classic 互换（真实 STATE_ASSETS）：恰 9 个基础状态链首翻转为 classic 对应件', () => {
  const swapped = swapChains(STATE_ASSETS, 'classic')
  assert.notEqual(swapped, STATE_ASSETS)
  const changed = Object.keys(STATE_ASSETS).filter((s) => swapped[s] !== STATE_ASSETS[s]).sort()
  // 有对应件且原不在链首：think/wait/celebrate/error/disappointed/sleep/eat/drag/idle。
  assert.deepEqual(changed, ['celebrate', 'disappointed', 'drag', 'eat', 'error', 'idle', 'sleep', 'think', 'wait'])
})

test('classic 互换：链首翻转细节（条目原引用与 motion/pick 字段保留、其余条目相对顺序不变）', () => {
  const swapped = swapChains(STATE_ASSETS, 'classic')
  // think：[musume thinking, classic think] → [classic think, musume thinking]。
  assert.equal(swapped.think.chain[0].file, 'assets/classic/think.webp')
  assert.equal(swapped.think.chain[1].file, 'assets/musume/dsh-whale-state-thinking.webp')
  assert.equal(swapped.think.chain[0], STATE_ASSETS.think.chain[1]) // 条目对象引用保留（不克隆）
  assert.equal(swapped.think.pick, 'first')
  // eat：[webm(once), musume eat, classic eat] → classic 提首，webm/musume 相对顺序不变。
  assert.deepEqual(swapped.eat.chain.map((e) => e.file), [
    'assets/classic/eat.webp',
    'assets/webm/吃小鱼干.webm',
    'assets/musume/dsh-whale-state-eat.webp',
  ])
  assert.equal(swapped.eat.chain[1].playback, 'once')
  // error：classic 条目自带 motion:'shake'，升主后字段原样保留。
  assert.equal(swapped.error.chain[0].file, 'assets/classic/error.webp')
  assert.equal(swapped.error.chain[0].motion, 'shake')
  assert.equal(swapped.error.chain[1].motion, 'shake')
  // drag：[webm, musume pick-up, classic drag] → classic 提首。
  assert.equal(swapped.drag.chain[0].file, 'assets/classic/drag.webp')
  assert.equal(swapped.drag.chain.length, STATE_ASSETS.drag.chain.length)
})

test('classic 保持原链：musume 专属状态与已是链首的状态沿用入参原引用', () => {
  const swapped = swapChains(STATE_ASSETS, 'classic')
  // night 链内虽有 classic/sleep.webp，但那是借用件而非 assets/classic/night.webp 对应件 → 原链。
  assert.equal(swapped.night, STATE_ASSETS.night)
  assert.equal(swapped.struggling, STATE_ASSETS.struggling) // 无任何 classic 条目
  assert.equal(swapped.working, STATE_ASSETS.working) // pick:'random' 插曲链，无 classic 条目
  // classic 已在链首：welcome/wake/play/joy/walk 不动（同 def 引用）。
  for (const s of ['welcome', 'wake', 'play', 'joy', 'walk']) {
    assert.equal(swapped[s], STATE_ASSETS[s], `${s} 已是 classic 链首，应原引用`)
  }
})

test('纯函数边界：互换绝不修改入参（深快照前后一致）', () => {
  const snapshot = structuredClone(STATE_ASSETS)
  swapChains(STATE_ASSETS, 'classic')
  assert.deepEqual(STATE_ASSETS, snapshot)
})

test('memo 化：同入参映射的 classic 结果复用同一对象；不同映射各自成表', () => {
  const a = swapChains(STATE_ASSETS, 'classic')
  const b = swapChains(STATE_ASSETS, 'classic')
  assert.equal(a, b)
  const synth = { think: STATE_ASSETS.think }
  const c = swapChains(synth, 'classic')
  assert.notEqual(c, a)
  assert.equal(swapChains(synth, 'classic'), c)
})

test('互换幂等：对已互换结果再次 swap 不再变化（升主即稳；回 musume 走原样路径）', () => {
  const once = swapChains(STATE_ASSETS, 'classic')
  const twice = swapChains(once, 'classic')
  assert.deepEqual(twice, once)
  // 幂等而非开关：二次 swap 不回退原表——角色切回由 musume 路径（原样返回）承担。
  assert.equal(swapChains(once, 'musume'), once)
})

test('参数化：互换规则由「链内存在 assets/classic/<状态名>.webp 条目」驱动，与具体状态名解耦', () => {
  const synth = {
    a: { pick: 'first', chain: [img('assets/musume/a.webp'), img('assets/classic/a.webp')] },
    b: { pick: 'first', chain: [img('assets/musume/b.webp')] }, // 无对应件 → 原链
    c: { pick: 'first', chain: [img('assets/classic/c.webp'), img('assets/musume/c.webp')] }, // 已在链首
    d: { pick: 'first', chain: [img('assets/musume/d.webp'), img('assets/classic/d-alt.webp'), img('assets/classic/d.webp')] },
    e: { pick: 'random', chain: [img('assets/musume/e.webp'), img('assets/classic/e.webp')] },
  }
  const swapped = swapChains(synth, 'classic')
  assert.deepEqual(swapped.a.chain.map((x) => x.file), ['assets/classic/a.webp', 'assets/musume/a.webp'])
  assert.equal(swapped.b, synth.b)
  assert.equal(swapped.c, synth.c)
  // 近名条目 classic/d-alt.webp 不是 d 的对应件：只精确条目升主，其余相对顺序不变。
  assert.deepEqual(swapped.d.chain.map((x) => x.file), [
    'assets/classic/d.webp',
    'assets/musume/d.webp',
    'assets/classic/d-alt.webp',
  ])
  // pick:'random' 链同样按统一规则升主（现状 working 无 classic 条目不可达；行为在此固化，
  // 若未来为插曲链加对应件需先明确随机池语义，见 characters.mjs 注释）。
  assert.deepEqual(swapped.e.chain.map((x) => x.file), ['assets/classic/e.webp', 'assets/musume/e.webp'])
})

test('降级路径：null/非对象/缺 chain/空 chain/链条目含 null 均不抛错且不改入参', () => {
  assert.equal(swapChains(null, 'classic'), null)
  assert.equal(swapChains(undefined, 'classic'), undefined)
  assert.equal(swapChains(42, 'classic'), 42)
  assert.deepEqual(swapChains({}, 'classic'), {})
  const odd = {
    noChain: { pick: 'first' },
    emptyChain: { pick: 'first', chain: [] },
    nullEntry: { pick: 'first', chain: [null, img('assets/musume/x.webp')] },
  }
  const oddSnapshot = structuredClone(odd)
  const swappedOdd = swapChains(odd, 'classic')
  assert.equal(swappedOdd.noChain, odd.noChain)
  assert.equal(swappedOdd.emptyChain, odd.emptyChain)
  assert.equal(swappedOdd.nullEntry, odd.nullEntry) // 无 classic 对应件（null 条目安全跳过）
  assert.deepEqual(odd, oddSnapshot)
  // 互换结果顶层冻结（不可变契约面）。
  assert.ok(Object.isFrozen(swappedOdd))
  assert.ok(Object.isFrozen(swapChains(STATE_ASSETS, 'classic')))
})
