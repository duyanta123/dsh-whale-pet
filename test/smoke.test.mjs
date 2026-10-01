// M0 冒烟：模块面完整性（Node half 可导入、client ESM 模块语法可加载、patch 清单合法）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('Node half 导出面完整（name/apply/inject 与路由常量）', async () => {
  const mod = await import('../lib/index.mjs', { with: { type: 'module' } }).catch(() => import(new URL('../lib/index.mjs', import.meta.url)))
  assert.equal(mod.name, 'whale-pet')
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual([...mod.inject], ['webServer'])
  assert.equal(mod.ASSETS_PATH, '/api/whale-pet/assets')
  assert.equal(mod.EVENTS_PATH, '/api/whale-pet/events')
  assert.equal(mod.USAGE_PATH, '/api/whale-pet/usage')
  assert.equal(mod.BALANCE_PATH, '/api/whale-pet/balance')
})

test('client 实现模块可加载（mountPet 导出）', async () => {
  const mod = await import(new URL('../lib/client/main.mjs', import.meta.url))
  assert.equal(typeof mod.mountPet, 'function')
})

test('client 入口为工厂注册形态（combo script 约束）', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('__ModuleLoader__.load'), '入口必须经 __ModuleLoader__.load 注册')
  assert.ok(!/^\s*import\s/m.test(src) && !/^\s*export\s/m.test(src), '入口不得含 ESM 顶层 import/export（普通脚本上下文）')
})

test('cordis.patch.yml 仅 insert 且行合法', () => {
  const yml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.ok(yml.includes('- insert:'))
  assert.ok(!/replace:|remove:/.test(yml), 'bundle patch 禁止 replace/remove')
  assert.ok(yml.includes('name: dsh-whale-chan'))
})

test('package.json dsh 声明完整', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './lib/client.js')
})
