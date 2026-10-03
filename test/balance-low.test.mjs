// 二期 balance-low 单测：余额响应解析（parseBalancePayload）/ 档位文案（balanceTier）/
// 阈值判定与提醒去重（balanceLowDecision）/ 轮询节拍与失败退避（nextPollAt）/
// 组装语义（模拟 main.mjs 接线循环：失败退避 + 成功复位 + 同一水位只提醒一次、回升重置）。
// 全部纯函数注入时刻，不碰 DOM/定时器/fetch（拉取与深夜门控在宿主薄执行层，phase2-plan §11）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BALANCE_POLL_MS, BALANCE_BACKOFF_MAX_MS, BALANCE_TIERS,
  balanceTier, parseBalancePayload, nextPollAt, balanceLowDecision,
} from '../lib/client/balance-low.mjs'

const MIN = 60_000

// ---- 常量口径（固定契约：约 10 分钟节拍 / 60 分钟退避封顶）----
test('常量：节拍 10min、退避封顶 60min、档位表冻结且从低到高', () => {
  assert.equal(BALANCE_POLL_MS, 10 * MIN)
  assert.equal(BALANCE_BACKOFF_MAX_MS, 60 * MIN)
  assert.deepEqual([...BALANCE_TIERS], ['empty', 'critical', 'low', 'ok', 'good', 'rich'])
  assert.ok(Object.isFrozen(BALANCE_TIERS))
})

// ---- balanceTier：musume whale-moe-core.js:132-141 同款阈值（仅作文案，不参与判定）----
test('balanceTier：档位边界（0/1/5/20/100）', () => {
  assert.equal(balanceTier(-5), 'empty')
  assert.equal(balanceTier(0), 'empty')
  assert.equal(balanceTier(0.01), 'critical')
  assert.equal(balanceTier(0.99), 'critical')
  assert.equal(balanceTier(1), 'low')
  assert.equal(balanceTier(4.99), 'low')
  assert.equal(balanceTier(5), 'ok')
  assert.equal(balanceTier(19.99), 'ok')
  assert.equal(balanceTier(20), 'good')
  assert.equal(balanceTier(99.99), 'good')
  assert.equal(balanceTier(100), 'rich')
  assert.equal(balanceTier(1234.5), 'rich')
})

test('balanceTier：无效金额回 unknown（脏数据不播报）', () => {
  for (const bad of [null, undefined, '', '   ', Number.NaN, Infinity, -Infinity, 'abc', true, false]) {
    assert.equal(balanceTier(bad), 'unknown', `balanceTier(${String(bad)}) 应为 unknown`)
  }
  assert.equal(balanceTier('12.34'), 'ok') // 数字字符串可解析
})

test('balanceTier：数组/对象隐式强转不参与档位（Number([])===0 不再误判 empty 档）', () => {
  for (const dirty of [[], ['110.00'], [42], {}]) {
    assert.equal(balanceTier(dirty), 'unknown', `balanceTier(${JSON.stringify(dirty)}) 应为 unknown`)
  }
})

// ---- parseBalancePayload：宿主路由返回体 → { ok, currency, amount } ----
const cnyPayload = (total) => ({
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: total, granted_balance: '0.00', topped_up_balance: total }],
})

test('parseBalancePayload：ok:true 包裹形状（宿主升级后 §10.2）与裸 DeepSeek 形状都接受', () => {
  assert.deepEqual(
    parseBalancePayload({ ok: true, ...cnyPayload('110.00') }),
    { ok: true, currency: 'CNY', amount: 110 },
  )
  assert.deepEqual(parseBalancePayload(cnyPayload('110.00')), { ok: true, currency: 'CNY', amount: 110 })
})

test('parseBalancePayload：数字型 total_balance / 小写币种归一', () => {
  assert.equal(parseBalancePayload(cnyPayload(3.5)).amount, 3.5)
  assert.equal(
    parseBalancePayload({ balance_infos: [{ currency: 'cny', total_balance: '7.00' }] }).currency, 'CNY',
  )
})

test('parseBalancePayload：CNY 命中优先；非 CNY 回退首条（musume pickBalanceAccount 语义）', () => {
  const mixed = { is_available: true, balance_infos: [
    { currency: 'USD', total_balance: '0.14' },
    { currency: 'CNY', total_balance: '88.00' },
  ] }
  assert.deepEqual(parseBalancePayload(mixed), { ok: true, currency: 'CNY', amount: 88 })
  assert.deepEqual(
    parseBalancePayload({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '0.14' }] }),
    { ok: true, currency: 'USD', amount: 0.14 },
  )
  // currency 缺省/空串按 'CNY' 兜底（girl-pet shapeBalance 同语义）
  assert.equal(parseBalancePayload({ balance_infos: [{ total_balance: '5.00' }] }).currency, 'CNY')
  assert.equal(parseBalancePayload({ balance_infos: [{ currency: '', total_balance: '5.00' }] }).currency, 'CNY')
})

test('parseBalancePayload：is_available:false / stub / 上游失败 → ok:false 且 reason 可追溯', () => {
  assert.deepEqual(parseBalancePayload({ ok: true, is_available: false, balance_infos: [] }),
    { ok: false, reason: 'unavailable' })
  // 现 stub（lib/index.mjs 余额路由）：未配置恒 { ok:false, reason:'balance-not-configured' }
  assert.deepEqual(parseBalancePayload({ ok: false, reason: 'balance-not-configured' }),
    { ok: false, reason: 'balance-not-configured' })
  assert.equal(parseBalancePayload({ ok: false }).reason, 'balance-error') // 无 reason 兜底
})

test('parseBalancePayload：坏载荷一律 ok:false', () => {
  for (const bad of [null, undefined, 'x', 42, true, {}, { balance_infos: 'oops' }, { balance_infos: [] }]) {
    const out = parseBalancePayload(bad)
    assert.equal(out.ok, false, `payload ${JSON.stringify(bad) ?? String(bad)} 应解析失败`)
    assert.equal(typeof out.reason, 'string')
  }
  assert.equal(parseBalancePayload({ balance_infos: [null] }).reason, 'bad-payload')
  assert.equal(parseBalancePayload({ balance_infos: [{}] }).reason, 'bad-amount') // 缺金额
})

test('parseBalancePayload：金额脏数据绝不映射成 0（告警安全，走退避重试）', () => {
  for (const dirty of ['', '   ', 'abc', null, undefined, -1, '-0.01', true]) {
    const out = parseBalancePayload({ balance_infos: [{ currency: 'CNY', total_balance: dirty }] })
    assert.equal(out.ok, false, `total_balance=${JSON.stringify(dirty)} 应解析失败`)
    assert.equal(out.reason, 'bad-amount')
  }
})

test('parseBalancePayload：数组型 total_balance 不再隐式收敛（[] 绝不映射成 0）', () => {
  // [] 曾被 Number() 收敛成 0 并触发「余额已见底」误报；['110.00'] 曾被静默当作 110
  assert.deepEqual(
    parseBalancePayload({ balance_infos: [{ currency: 'CNY', total_balance: [] }] }),
    { ok: false, reason: 'bad-amount' },
  )
  assert.deepEqual(
    parseBalancePayload({ balance_infos: [{ currency: 'CNY', total_balance: ['110.00'] }] }),
    { ok: false, reason: 'bad-amount' },
  )
  // 官方真实形状（非空数字字符串）不受白名单影响
  assert.deepEqual(
    parseBalancePayload({ balance_infos: [{ currency: 'CNY', total_balance: '110.00' }] }),
    { ok: true, currency: 'CNY', amount: 110 },
  )
})

// ---- balanceLowDecision：阈值判定 + 提醒去重（同一水位只提醒一次，水位回升重置）----
test('balanceLowDecision：正常→跌破提醒一次→持续低不重复→回升重置→再低再提醒', () => {
  const TH = 5
  assert.deepEqual(balanceLowDecision({ amount: 20, thresholdCNY: TH, alertedLow: false }),
    { alert: false, alertedLow: false, tier: 'good' })
  assert.deepEqual(balanceLowDecision({ amount: 3, thresholdCNY: TH, alertedLow: false }),
    { alert: true, alertedLow: true, tier: 'low' }) // 首次跌破：提醒
  assert.deepEqual(balanceLowDecision({ amount: 2, thresholdCNY: TH, alertedLow: true }),
    { alert: false, alertedLow: true, tier: 'low' }) // 持续低：不重复
  assert.deepEqual(balanceLowDecision({ amount: 9, thresholdCNY: TH, alertedLow: true }),
    { alert: false, alertedLow: false, tier: 'ok' }) // 回升：重置记忆
  assert.deepEqual(balanceLowDecision({ amount: 1, thresholdCNY: TH, alertedLow: false }),
    { alert: true, alertedLow: true, tier: 'low' }) // 再次跌破：再提醒
})

test('balanceLowDecision：阈值边界（严格小于，等于阈值不告警）', () => {
  assert.deepEqual(balanceLowDecision({ amount: 5, thresholdCNY: 5, alertedLow: false }),
    { alert: false, alertedLow: false, tier: 'ok' })
  assert.equal(balanceLowDecision({ amount: 4.99, thresholdCNY: 5, alertedLow: false }).alert, true)
})

test('balanceLowDecision：tier 只随金额走档位文案、与判定阈值无关', () => {
  assert.deepEqual(balanceLowDecision({ amount: 0.5, thresholdCNY: 1, alertedLow: false }),
    { alert: true, alertedLow: true, tier: 'critical' })
  // 低于阈值 30（判定告警），但档位文案只按金额 20 → good（musume：n<20 才是 ok）——tier 与阈值解耦
  assert.deepEqual(balanceLowDecision({ amount: 20, thresholdCNY: 30, alertedLow: false }),
    { alert: true, alertedLow: true, tier: 'good' })
  assert.equal(balanceLowDecision({ amount: 19.5, thresholdCNY: 30, alertedLow: false }).tier, 'ok')
  assert.deepEqual(balanceLowDecision({ amount: 0, thresholdCNY: 5, alertedLow: false }),
    { alert: true, alertedLow: true, tier: 'empty' })
})

test('balanceLowDecision：金额无效 → 不提醒不重置（保留既有记忆）', () => {
  for (const bad of [null, undefined, '', '   ', 'abc', Number.NaN, Infinity, true]) {
    const kept = balanceLowDecision({ amount: bad, thresholdCNY: 5, alertedLow: true })
    assert.deepEqual(kept, { alert: false, alertedLow: true, tier: 'unknown' },
      `amount=${String(bad)} 不应重置 alertedLow`)
    const fresh = balanceLowDecision({ amount: bad, thresholdCNY: 5, alertedLow: false })
    assert.equal(fresh.alertedLow, false) // 也绝不凭空置位
  }
})

test('balanceLowDecision：阈值无效/非正 → 不判定不重置（脏配置不触发误报或误复位）', () => {
  for (const bad of [Number.NaN, 0, -1, '', null, undefined]) {
    const out = balanceLowDecision({ amount: 3, thresholdCNY: bad, alertedLow: true })
    assert.equal(out.alert, false)
    assert.equal(out.alertedLow, true, `thresholdCNY=${String(bad)} 不应重置 alertedLow`)
  }
  // 阈值为数字字符串可解析（设置层 asNum 产物为数字，此处仅防御）
  assert.equal(balanceLowDecision({ amount: 3, thresholdCNY: '5', alertedLow: false }).alert, true)
})

test('balanceLowDecision：alertedLow 脏值归一为布尔', () => {
  assert.deepEqual(balanceLowDecision({ amount: 1, thresholdCNY: 5, alertedLow: undefined }),
    { alert: true, alertedLow: true, tier: 'low' })
  assert.deepEqual(balanceLowDecision({ amount: 1, thresholdCNY: 5, alertedLow: 'yes' }),
    { alert: false, alertedLow: true, tier: 'low' }) // 非严格 true 一律视为已提醒
})

// ---- nextPollAt：成功 10min / 失败 2^n 指数退避封顶 60min ----
test('nextPollAt：成功回到基础节拍，failStreak 不影响成功分支', () => {
  assert.equal(nextPollAt(1000, { ok: true }), 1000 + 10 * MIN)
  assert.equal(nextPollAt(1000, { ok: true, failStreak: 99 }), 1000 + 10 * MIN)
})

test('nextPollAt：失败按 2^failStreak 退避并封顶 60min', () => {
  const t = 5_000_000
  assert.equal(nextPollAt(t, { ok: false, failStreak: 1 }), t + 20 * MIN)
  assert.equal(nextPollAt(t, { ok: false, failStreak: 2 }), t + 40 * MIN)
  assert.equal(nextPollAt(t, { ok: false, failStreak: 3 }), t + 60 * MIN) // 80min 封顶
  assert.equal(nextPollAt(t, { ok: false, failStreak: 10 }), t + 60 * MIN)
  assert.equal(nextPollAt(t, { ok: false, failStreak: 1024 }), t + 60 * MIN) // 2^1024=Infinity 也不溢出
})

test('nextPollAt：failStreak 缺省/脏值按 0；ok 非 true 一律按失败', () => {
  const t = 0
  assert.equal(nextPollAt(t, { ok: false }), t + 10 * MIN)
  assert.equal(nextPollAt(t, {}), t + 10 * MIN)
  assert.equal(nextPollAt(t, { ok: false, failStreak: -3 }), t + 10 * MIN)
  assert.equal(nextPollAt(t, { ok: false, failStreak: Number.NaN }), t + 10 * MIN)
  assert.equal(nextPollAt(t, { ok: false, failStreak: 2.7 }), t + 40 * MIN) // 向下取整
  assert.equal(nextPollAt(t, undefined), t + 10 * MIN) // 完全缺参按失败 0 档
})

test('nextPollAt：now 非法按 0 计（不抛错）', () => {
  assert.equal(nextPollAt(Number.NaN, { ok: true }), 10 * MIN)
})

// ---- 组装语义：模拟 main.mjs 接线循环（phase2-plan §11：fetch → parse → decision → nextPollAt）----
test('组装语义：轮询循环端到端（退避递增/成功复位/提醒一次/回升再提醒）', () => {
  let now = 1_000_000
  let failStreak = 0
  let alertedLow = false
  const alerts = []
  // 单轮：解析 → 下一节拍 → 成功才判定去重（失败走 failStreak+1 再传入 nextPollAt 的推荐接线）
  const poll = (payload) => {
    const parsed = parseBalancePayload(payload)
    const ok = parsed.ok === true
    const interval = nextPollAt(now, { ok, failStreak: ok ? 0 : failStreak + 1 }) - now
    if (ok) {
      failStreak = 0 // 成功即复位
      const d = balanceLowDecision({ amount: parsed.amount, thresholdCNY: 5, alertedLow })
      alertedLow = d.alertedLow
      if (d.alert) alerts.push({ at: now, amount: parsed.amount, tier: d.tier })
    } else {
      failStreak += 1
    }
    now += interval
    return { ok, interval }
  }
  // ① stub（未配置 apiKey）：失败 → 首次退避 20min，无提醒
  assert.deepEqual(poll({ ok: false, reason: 'balance-not-configured' }), { ok: false, interval: 20 * MIN })
  assert.equal(alerts.length, 0)
  // ② 上游失败：退避加码 40min
  assert.deepEqual(poll({ ok: false, reason: 'upstream-http-502' }), { ok: false, interval: 40 * MIN })
  // ③ 成功且充足：回到 10min 基础节拍（failStreak 复位）
  assert.deepEqual(poll(cnyPayload('20.00')), { ok: true, interval: 10 * MIN })
  // ④ 跌破阈值：提醒一次（金额/档位/时刻随提醒带回）
  const at4 = now
  poll(cnyPayload('3.20'))
  assert.equal(alerts.length, 1)
  assert.deepEqual(alerts[0], { at: at4, amount: 3.2, tier: 'low' })
  // ⑤ 持续低水位：节照常轮询但不再重复提醒
  poll(cnyPayload('2.00'))
  assert.equal(alerts.length, 1)
  // ⑥ 充值回升：重置去重记忆
  poll(cnyPayload('50.00'))
  assert.equal(alerts.length, 1)
  // ⑦ 再次跌破：再提醒一次，档位文案随金额变化
  poll(cnyPayload('0.50'))
  assert.equal(alerts.length, 2)
  assert.equal(alerts[1].tier, 'critical')
})
