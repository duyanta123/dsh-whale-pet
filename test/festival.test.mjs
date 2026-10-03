// 节日换装单测（二期 §5 / §14）：农历查表 2026–2030 全命中 / 公历 10-31、12-25 直判 /
// 表外年份与闰·非法日期回退 null / idleOverlayVisual 优先级矩阵
//（gamePose > night > balanceLowPose > festival > weather > idle；非 idle 原样）。
// 全部纯函数、固定日期常量——日期即输入，无时钟/随机面，结果 100% 确定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  festivalOf, FESTIVAL_IDS, FESTIVAL_LABELS, FESTIVAL_LUNAR_TABLE, idleOverlayVisual,
} from '../lib/client/festival.mjs'
import { nightVisualState } from '../lib/client/care.mjs'

// 本地日历日构造（月从 0 起）；时间戳形态 = 同一本地日的 getTime()，时区无关。
const localDate = (y, m, d, hh = 12) => new Date(y, m - 1, d, hh)
const stampOf = (y, m, d, hh = 12) => localDate(y, m, d, hh).getTime()

// §5 农历查表全量（10 条：春节 5 + 中秋 5）
const LUNAR_CASES = [
  ['2026-02-17', 'spring', '春节'],
  ['2027-02-06', 'spring', '春节'],
  ['2028-01-26', 'spring', '春节'],
  ['2029-02-13', 'spring', '春节'],
  ['2030-02-03', 'spring', '春节'],
  ['2026-09-25', 'mid-autumn', '中秋节'],
  ['2027-09-15', 'mid-autumn', '中秋节'],
  ['2028-10-03', 'mid-autumn', '中秋节'],
  ['2029-09-22', 'mid-autumn', '中秋节'],
  ['2030-09-12', 'mid-autumn', '中秋节'],
]

/** 'YYYY-MM-DD' → [y, m, d]（查表用例拆解用）。 */
function splitKey(key) {
  const [y, m, d] = key.split('-').map(Number)
  return [y, m, d]
}

// ---- FESTIVAL_LUNAR_TABLE 表本体 ----
test('FESTIVAL_LUNAR_TABLE：冻结、10 条、与 §5 表逐条一致', () => {
  assert.equal(Object.isFrozen(FESTIVAL_LUNAR_TABLE), true)
  assert.equal(Object.keys(FESTIVAL_LUNAR_TABLE).length, 10)
  assert.deepEqual(
    Object.entries(FESTIVAL_LUNAR_TABLE),
    LUNAR_CASES.map(([key, id]) => [key, id]),
  )
})

test('FESTIVAL_IDS / FESTIVAL_LABELS：冻结且 id 对齐素材 festival-* 命名', () => {
  assert.equal(Object.isFrozen(FESTIVAL_IDS), true)
  assert.equal(Object.isFrozen(FESTIVAL_LABELS), true)
  assert.deepEqual([...FESTIVAL_IDS], ['spring', 'christmas', 'halloween', 'mid-autumn'])
  for (const id of FESTIVAL_IDS) assert.equal(typeof FESTIVAL_LABELS[id], 'string')
})

// ---- festivalOf：农历查表 ----
test('festivalOf：§5 表 10 个农历日期全命中（字符串/Date/时间戳三形态等价）', () => {
  for (const [key, id, label] of LUNAR_CASES) {
    const [y, m, d] = splitKey(key)
    const expected = { id, label }
    assert.deepEqual(festivalOf(key), expected, `string ${key}`)
    assert.deepEqual(festivalOf(localDate(y, m, d)), expected, `Date ${key}`)
    assert.deepEqual(festivalOf(stampOf(y, m, d)), expected, `timestamp ${key}`)
  }
})

test('festivalOf：返回对象冻结且只含 id/label 两键', () => {
  const hit = festivalOf('2026-02-17')
  assert.equal(Object.isFrozen(hit), true)
  assert.deepEqual(Object.keys(hit).sort(), ['id', 'label'])
})

// ---- festivalOf：公历直判 ----
test('festivalOf：万圣 10-31 / 圣诞 12-25 公历直判（含表外年份）', () => {
  assert.deepEqual(festivalOf('2026-10-31'), { id: 'halloween', label: '万圣节' })
  assert.deepEqual(festivalOf('2026-12-25'), { id: 'christmas', label: '圣诞节' })
  // 表外年份公历节日仍直判（查表只约束农历节日）
  assert.deepEqual(festivalOf('2031-10-31'), { id: 'halloween', label: '万圣节' })
  assert.deepEqual(festivalOf('2031-12-25'), { id: 'christmas', label: '圣诞节' })
  assert.deepEqual(festivalOf(localDate(2027, 10, 31)), { id: 'halloween', label: '万圣节' })
  assert.deepEqual(festivalOf(stampOf(2027, 12, 25)), { id: 'christmas', label: '圣诞节' })
})

test('festivalOf：公历节日前后一日不命中（边界）', () => {
  for (const key of ['2026-10-30', '2026-11-01', '2026-12-24', '2026-12-26', '2027-02-14']) {
    assert.equal(festivalOf(key), null, key) // musume 的 valentine 无素材，不采用
  }
})

// ---- festivalOf：表外年份回退 null（固定契约原文）----
test('festivalOf：表外年份（2031 春节/中秋等）→ null', () => {
  // 2031 年春节/中秋真实存在但不在 2026–2030 查表内 → 一律 null
  for (const key of ['2031-01-23', '2031-02-17', '2031-09-25', '2031-10-03', '2025-02-17', '2025-09-25']) {
    assert.equal(festivalOf(key), null, key)
  }
  // 表内日期的相邻日也不命中（春节次日/中秋前日）
  for (const key of ['2026-02-16', '2026-02-18', '2026-09-24', '2026-09-26', '2028-01-25', '2028-01-27']) {
    assert.equal(festivalOf(key), null, key)
  }
})

// ---- festivalOf：闰/非法日期 → null ----
test('festivalOf：闰日与非法日历日 → null', () => {
  assert.equal(festivalOf('2027-02-29'), null) // 非闰年 02-29：非法
  assert.equal(festivalOf('2028-02-29'), null) // 闰年 02-29：合法日期但非节日
  assert.equal(festivalOf('2026-02-30'), null) // 2 月无 30 日
  assert.equal(festivalOf('2026-04-31'), null) // 4 月无 31 日
  assert.equal(festivalOf('2026-13-01'), null)
  assert.equal(festivalOf('2026-00-10'), null)
  assert.equal(festivalOf('2026-02-00'), null)
})

test('festivalOf：非法输入形态 → null（严格 YYYY-MM-DD 补零格式）', () => {
  for (const bad of ['', 'abc', '2026/02/17', '2026-2-17', '2026-02-17 ', '20260217',
    '26-02-17', '2026-02-17- Extra']) {
    assert.equal(festivalOf(bad), null, `string ${JSON.stringify(bad)}`)
  }
  assert.equal(festivalOf(Number.NaN), null)
  assert.equal(festivalOf(Number.POSITIVE_INFINITY), null)
  assert.equal(festivalOf(Number.NEGATIVE_INFINITY), null)
  assert.equal(festivalOf(new Date('not-a-date')), null) // Invalid Date
  for (const bad of [null, undefined, true, 2026n, {}, ['2026-02-17']]) {
    assert.equal(festivalOf(bad), null, `type ${String(bad)}`)
  }
})

test('festivalOf：Date/时间戳按本地日历日解析（当日任意时刻稳定命中）', () => {
  for (const hh of [0, 8, 12, 23]) {
    assert.deepEqual(festivalOf(localDate(2026, 2, 17, hh)), { id: 'spring', label: '春节' }, `hh=${hh}`)
    assert.deepEqual(festivalOf(stampOf(2026, 9, 25, hh)), { id: 'mid-autumn', label: '中秋节' }, `hh=${hh}`)
    assert.equal(festivalOf(localDate(2026, 10, 31, hh))?.id, 'halloween', `hh=${hh}`)
  }
})

// ---- idleOverlayVisual：非 idle 原样（固定契约原文）----
test('idleOverlayVisual：非 idle 原样返回，任何 opts 都不覆盖交互/镜像态', () => {
  const full = {
    nightMute: true, gamePose: 'game-think', balanceLowPose: 'balance-low',
    festivalId: 'spring', weatherId: 'thunder',
  }
  for (const next of ['think', 'wait', 'celebrate', 'error', 'disappointed', 'sleep',
    'night', 'struggling', 'eat', 'play', 'walk', 'drag']) {
    assert.equal(idleOverlayVisual(next, full), next, next)
  }
})

// ---- idleOverlayVisual：优先级矩阵 ----
test('idleOverlayVisual：优先级矩阵（gamePose > night > balanceLowPose > festival > weather > idle）', () => {
  const cases = [
    // [{opts}, 期望]
    [{}, 'idle'], // 空覆盖 → 原 idle
    [{ nightMute: false }, 'idle'],
    [{ festivalId: 'spring' }, 'festival-spring'],
    [{ weatherId: 'rain' }, 'weather-rain'],
    [{ festivalId: 'spring', weatherId: 'thunder' }, 'festival-spring'], // festival > weather（固定契约序）
    [{ balanceLowPose: 'balance-low', festivalId: 'spring', weatherId: 'rain' }, 'balance-low'], // balanceLow > festival
    [{ nightMute: true, balanceLowPose: 'balance-low', festivalId: 'spring' }, 'night'], // night > balanceLow
    [{ nightMute: true, festivalId: 'spring', weatherId: 'snow' }, 'night'], // night > festival/weather
    [{ gamePose: 'game-think', nightMute: true, balanceLowPose: 'balance-low',
      festivalId: 'spring', weatherId: 'thunder' }, 'game-think'], // gamePose 全档最高
    [{ balanceLowPose: 'balance-low', nightMute: false }, 'balance-low'],
    [{ festivalId: 'mid-autumn' }, 'festival-mid-autumn'],
    [{ festivalId: 'halloween', weatherId: 'rain' }, 'festival-halloween'],
    [{ festivalId: 'christmas', weatherId: 'snow' }, 'festival-christmas'],
  ]
  for (const [opts, expected] of cases) {
    assert.equal(idleOverlayVisual('idle', opts), expected, JSON.stringify(opts))
  }
})

test('idleOverlayVisual：nightMute 下 balanceLowPose 不生效（夜里只显示 night）', () => {
  // nightMute 严格 === true（沿用 care.mjs nightVisualState 语义）；1/'yes' 等真值不生效
  assert.equal(idleOverlayVisual('idle', { nightMute: true, balanceLowPose: 'balance-low' }), 'night')
  assert.equal(idleOverlayVisual('idle', { nightMute: 1, balanceLowPose: 'balance-low' }), 'balance-low')
  assert.equal(idleOverlayVisual('idle', { nightMute: 'yes', balanceLowPose: 'balance-low' }), 'balance-low')
  assert.equal(idleOverlayVisual('idle', { nightMute: false, balanceLowPose: 'balance-low' }), 'balance-low')
})

test('idleOverlayVisual：weather 五素材 id 全映射；clear=不换装', () => {
  assert.equal(idleOverlayVisual('idle', { weatherId: 'rain' }), 'weather-rain')
  assert.equal(idleOverlayVisual('idle', { weatherId: 'snow' }), 'weather-snow')
  assert.equal(idleOverlayVisual('idle', { weatherId: 'thunder' }), 'weather-thunder')
  assert.equal(idleOverlayVisual('idle', { weatherId: 'umbrella' }), 'weather-umbrella')
  assert.equal(idleOverlayVisual('idle', { weatherId: 'cold' }), 'weather-cold')
  assert.equal(idleOverlayVisual('idle', { weatherId: 'clear' }), 'idle') // 无素材语义
  assert.equal(idleOverlayVisual('idle', { weatherId: 'weather-clear' }), 'idle')
  assert.equal(idleOverlayVisual('idle', { weatherId: 'clear', festivalId: 'spring' }), 'festival-spring')
})

test('idleOverlayVisual：festival/weather 短 id 与素材全 id 双形态容忍；未知 id 落空到下一级', () => {
  assert.equal(idleOverlayVisual('idle', { festivalId: 'festival-spring' }), 'festival-spring')
  assert.equal(idleOverlayVisual('idle', { festivalId: 'festival-mid-autumn' }), 'festival-mid-autumn')
  assert.equal(idleOverlayVisual('idle', { weatherId: 'weather-rain' }), 'weather-rain')
  // 未知/脏 id → 视为未设置（musume 的 valentine、雾等无素材语义）
  assert.equal(idleOverlayVisual('idle', { festivalId: 'valentine' }), 'idle')
  assert.equal(idleOverlayVisual('idle', { weatherId: 'fog' }), 'idle')
  assert.equal(idleOverlayVisual('idle', { festivalId: 'festival-valentine', weatherId: 'rain' }), 'weather-rain')
  assert.equal(idleOverlayVisual('idle', { festivalId: '' }), 'idle')
  assert.equal(idleOverlayVisual('idle', { festivalId: null, weatherId: null }), 'idle')
  assert.equal(idleOverlayVisual('idle', { gamePose: '', balanceLowPose: null }), 'idle')
})

test('idleOverlayVisual：缺参兜底（opts 缺省/undefined/null）', () => {
  assert.equal(idleOverlayVisual('idle'), 'idle')
  assert.equal(idleOverlayVisual('idle', undefined), 'idle')
  assert.equal(idleOverlayVisual('idle', null), 'idle')
  assert.equal(idleOverlayVisual('idle', {}), 'idle')
})

// ---- 与 care.mjs nightVisualState 的可替换性（超集回归）----
test('idleOverlayVisual：无覆盖通道时与 care.mjs nightVisualState 逐点一致（可作超集替换）', () => {
  for (const next of ['idle', 'think', 'wait', 'celebrate', 'error', 'disappointed', 'sleep']) {
    for (const nightMute of [true, false, undefined]) {
      assert.equal(
        idleOverlayVisual(next, { nightMute }),
        nightVisualState(next, nightMute),
        `next=${next} nightMute=${nightMute}`,
      )
    }
  }
})
