// M3-6 仪表板纯函数单测：柱状布局（归一化几何/标签/tooltip）与坐标轴文案。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { barLayout, axisLabel, VIEW_W, VIEW_H, DASHBOARD_POS_KEY } from '../lib/client/dashboard.mjs'

const bucket = (start, total, hit = 0, miss = 0, out = 0) => ({
  start,
  tokens: { total },
  costHitCny: hit,
  costMissCny: miss,
  costOutCny: out,
})

test('barLayout：空输入返回空数组', () => {
  assert.deepEqual(barLayout([], 'hours'), [])
  assert.deepEqual(barLayout(undefined, 'days'), [])
})

test('barLayout：柱体几何归一化（最高柱顶满、空桶占位 h=0）', () => {
  const t0 = Date.UTC(2026, 8, 14, 2, 0)
  const bars = barLayout([bucket(t0, 1000, 0.01), bucket(t0 + 3600e3, 0), bucket(t0 + 7200e3, 500)], 'hours')
  assert.equal(bars.length, 3)
  assert.equal(bars[0].h, VIEW_H - 4) // 最高柱
  assert.equal(bars[1].h, 0) // 空桶占位
  assert.ok(bars[2].h > 0 && bars[2].h < bars[0].h)
  for (const bar of bars) {
    assert.ok(bar.x >= 0 && bar.x + bar.w <= VIEW_W + 1e-9, `x 越界：${bar.x}+${bar.w}`)
    assert.ok(bar.w >= 1.2, '柱宽下限')
  }
  // 等分槽位。
  assert.ok(Math.abs(bars[0].x - bars[1].x) > 0)
})

test('barLayout：标签与 tooltip（小时 HH:00 / 天 MM-DD，固定北京时区）', () => {
  // 标签按固定北京偏移（UTC+8）格式化：用 UTC 毫秒构造北京时刻，用例与运行时区无关
  const t0 = Date.UTC(2026, 8, 14, 2, 0) // 北京 2026-09-14 10:00（UTC 02:00）
  const day0 = Date.UTC(2026, 8, 14, 4, 0) // 北京正午，避开日界
  const [hourBar] = barLayout([bucket(t0, 1234567, 0.1, 0.2, 0.05)], 'hours')
  assert.equal(hourBar.label, '10:00')
  assert.ok(hourBar.tip.includes('1.23M'))
  assert.ok(hourBar.tip.includes('≈¥0.35'))
  const [dayBar] = barLayout([bucket(day0, 100)], 'days')
  assert.equal(dayBar.label, '09-14')
})

test('barLayout：费用三桶合计（round4）', () => {
  const [bar] = barLayout([bucket(0, 10, 0.10001, 0.20002, 0.30003)], 'hours')
  assert.equal(bar.cost, 0.6001)
})

test('axisLabel：范围文案（固定北京时区）', () => {
  const t0 = Date.UTC(2026, 8, 14, 2, 0) // 北京 2026-09-14 10:00（时区无关）
  assert.ok(axisLabel([bucket(t0, 1)], 'hours').includes('10:00'))
  assert.ok(axisLabel([], 'days') === '')
})

test('barLayout/axisLabel：桶 start 按北京时区渲染，与查看者本地时区无关', () => {
  // 北京 2026-10-03 10:00 = UTC 02:00；任意运行时区下都应渲染北京日期/小时
  const bjTen = Date.UTC(2026, 9, 3, 2, 0)
  const [hourBar] = barLayout([bucket(bjTen, 1)], 'hours')
  assert.equal(hourBar.label, '10:00')
  const [dayBar] = barLayout([bucket(bjTen, 1)], 'days')
  assert.equal(dayBar.label, '10-03')
  assert.equal(axisLabel([bucket(bjTen, 1)], 'hours'), '2026-10-03 10:00 起')
  assert.equal(axisLabel([bucket(bjTen, 1)], 'days'), '2026-10-03 ~ 2026-10-03')
})

test('DASHBOARD_POS_KEY：localStorage 键名稳定', () => {
  assert.equal(DASHBOARD_POS_KEY, 'whale-pet.dashboard')
})
