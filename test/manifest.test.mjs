// M1-9 素材契约门禁：契约链的每个素材文件真实存在 + 与 demo 旧清单（assets/manifest.js）一致。
// 契约单源 lib/assets-manifest.mjs；旧面是普通脚本（window.PET_MANIFEST 赋值），demo 专用。
// 二期（phase2-plan §11-2.1）：EXTRA_STATE_ASSETS 15 键入链——文件存在性入全量守卫 +
// 链首 === bbox.mjs BBOX_STATE_FILES 漂移断言（「按 state id 推导文件名」的无守卫双源防复发；
// weather-rain→weather-rain-happy 这类例外映射必须显式成表，本断言即其单源回归点）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  STATE_ASSETS, STATE_NAMES, REACT_ASSETS, AVATAR, MEME_COUNT,
  EXTRA_STATE_ASSETS, resolveStateChain, setCharacter, getCharacterId,
} from '../lib/assets-manifest.mjs'
import { BBOX_STATE_FILES } from '../lib/client/bbox.mjs'

const pkg = (rel) => new URL(`../${rel}`, import.meta.url)
const allContractFiles = () => {
  const files = []
  for (const def of Object.values(STATE_ASSETS)) files.push(...def.chain.map((e) => e.file))
  for (const chain of Object.values(REACT_ASSETS)) files.push(...chain.map((e) => e.file))
  for (const def of Object.values(EXTRA_STATE_ASSETS)) files.push(...def.chain.map((e) => e.file))
  files.push(AVATAR)
  for (let i = 1; i <= MEME_COUNT; i += 1) {
    files.push(`assets/memes/meme-${String(i).padStart(3, '0')}.webp`)
  }
  return files
}

test('状态契约：17 状态（15 基础 + night + struggling）、链非空、kind/playback 合法', () => {
  assert.equal(STATE_NAMES.length, 17)
  for (const [state, def] of Object.entries(STATE_ASSETS)) {
    assert.ok(def.chain.length >= 1, `${state} 链为空`)
    assert.ok(def.pick === 'first' || def.pick === 'random', `${state} pick 非法`)
    for (const entry of def.chain) {
      assert.ok(entry.kind === 'image' || entry.kind === 'video', `${state} kind 非法`)
      assert.ok(entry.playback === 'loop' || entry.playback === 'once', `${state} playback 非法`)
    }
  }
})

test('契约引用的每个素材文件真实存在（含热区/头像/表情包/二期 EXTRA）', () => {
  for (const file of allContractFiles()) {
    assert.ok(existsSync(pkg(file)), `素材缺失：${file}`)
  }
  // 二期游戏开局特效（main.mjs 直呼 assetUrl 播放，不在任何链内——单独守卫）
  assert.ok(existsSync(pkg('assets/webm/鲸鱼吐泡泡特效.webm')), '素材缺失：assets/webm/鲸鱼吐泡泡特效.webm')
})

test('二期 EXTRA_STATE_ASSETS：15 键、image/loop 单链、链首 === BBOX_STATE_FILES（漂移守卫单源）', () => {
  assert.equal(Object.keys(EXTRA_STATE_ASSETS).length, 15)
  for (const [state, def] of Object.entries(EXTRA_STATE_ASSETS)) {
    assert.ok(def.pick === 'first', `${state} pick 应为 first`)
    assert.equal(def.chain.length, 1, `${state} 应为单链`)
    assert.equal(def.chain[0].kind, 'image', `${state} 应为 image`)
    assert.equal(def.chain[0].playback, 'loop', `${state} 应为 loop`)
    assert.equal(
      def.chain[0].file.split('/').pop(),
      BBOX_STATE_FILES[state],
      `EXTRA 链首与 bbox.mjs BBOX_STATE_FILES 漂移：${state}`,
    )
  }
})

test('二期漂移守卫：默认角色（musume）下实时链首 === BBOX_STATE_FILES 对应键（一期 9 + react 3）', () => {
  for (const [state, basename] of Object.entries(BBOX_STATE_FILES)) {
    if (state.startsWith('react-')) {
      const chain = REACT_ASSETS[state.slice('react-'.length)]
      assert.ok(chain && chain[0], `react 链缺失：${state}`)
      assert.equal(chain[0].file.split('/').pop(), basename, `react 链首漂移：${state}`)
    } else if (Object.hasOwn(EXTRA_STATE_ASSETS, state)) {
      continue // 二期 15 键由冻结映射即链首（上一测试已断言）
    } else {
      const chain = resolveStateChain(state)
      assert.ok(chain && chain[0], `状态链缺失：${state}`)
      assert.equal(chain[0].file.split('/').pop(), basename, `一期实时链首漂移：${state}`)
    }
  }
})

test('与 demo 旧清单（assets/manifest.js）一致——契约文件必须在旧面内（漂移守卫）', () => {
  const src = readFileSync(pkg('assets/manifest.js'), 'utf8')
  const sandbox = {}
  new Function('window', src)(sandbox) // 旧面是纯赋值脚本，沙箱求值即可
  const legacy = sandbox.PET_MANIFEST
  assert.ok(legacy, 'assets/manifest.js 未定义 window.PET_MANIFEST')
  const legacyFiles = new Set()
  for (const key of ['musume', 'classic', 'webm', 'fatfish']) {
    for (const entry of legacy[key] ?? []) legacyFiles.add(entry.file)
  }
  for (const meme of legacy.memes ?? []) legacyFiles.add(meme)
  if (typeof legacy.avatar === 'string') legacyFiles.add(legacy.avatar) // 头像是旧面顶层字段
  for (const file of allContractFiles()) {
    assert.ok(legacyFiles.has(file), `契约文件不在旧面清单（漂移）：${file}`)
  }
})

test('二期接线：setCharacter 全局换表 → resolveStateChain 实时链首随角色切换（characters×manifest 回归防护）', () => {
  // 直测接线面（assets-manifest 模块级 activeStateAssets；main.mjs 启动/设置热应用调 setCharacter）：
  // classic 下基础状态链首换 classic 文件（bbox.mjs 按实时链首查表 miss → 回退静态热区的自洽前提）；
  // musume 专属状态与二期 EXTRA 面不参与互换；脏值归一回 musume；还原后回到 STATE_ASSETS 本体引用。
  try {
    assert.equal(resolveStateChain('think')[0].file, 'assets/musume/dsh-whale-state-thinking.webp') // 默认 musume
    setCharacter('classic')
    assert.equal(getCharacterId(), 'classic')
    assert.equal(resolveStateChain('think')[0].file, 'assets/classic/think.webp') // 精确对应件升主
    assert.equal(resolveStateChain('night')[0].file, 'assets/musume/dsh-whale-state-night.webp') // 链内借用件（classic/sleep）不算对应件，原链
    assert.equal(resolveStateChain('weather-rain')[0].file, 'assets/musume/dsh-whale-state-weather-rain-happy.webp') // EXTRA 面不互换
    setCharacter('nonsense') // 脏值 → normalizeCharacterId 归一回 musume
    assert.equal(getCharacterId(), 'musume')
    assert.equal(resolveStateChain('think')[0].file, 'assets/musume/dsh-whale-state-thinking.webp')
    setCharacter('musume') // 还原默认：回 STATE_ASSETS 本体引用（零拷贝语义）
    assert.equal(resolveStateChain('think'), STATE_ASSETS.think.chain)
  } finally {
    setCharacter('musume') // 全局单例状态：无论断言成败都还原，不污染本文件其他用例
  }
})
