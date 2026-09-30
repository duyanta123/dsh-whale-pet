// M1-9 素材契约门禁：契约链的每个素材文件真实存在 + 与 demo 旧清单（assets/manifest.js）一致。
// 契约单源 lib/assets-manifest.mjs；旧面是普通脚本（window.PET_MANIFEST 赋值），demo 专用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { STATE_ASSETS, STATE_NAMES, REACT_ASSETS, AVATAR, MEME_COUNT } from '../lib/assets-manifest.mjs'

const pkg = (rel) => new URL(`../${rel}`, import.meta.url)
const allContractFiles = () => {
  const files = []
  for (const def of Object.values(STATE_ASSETS)) files.push(...def.chain.map((e) => e.file))
  for (const chain of Object.values(REACT_ASSETS)) files.push(...chain.map((e) => e.file))
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

test('契约引用的每个素材文件真实存在（含热区/头像/表情包）', () => {
  for (const file of allContractFiles()) {
    assert.ok(existsSync(pkg(file)), `素材缺失：${file}`)
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
