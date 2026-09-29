// M2-5 交互陪伴单测：热区命中顺序 / 喂食冷却 / 气泡队列与触发表（纯函数域）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hitZone, HIT_ZONES, ZONE_IDS } from '../lib/client/hitzone.mjs'
import { canFeed, feedCooldownLeft, FEED_COOLDOWN_MS } from '../lib/client/feed.mjs'
import {
  matchMemeTrigger, pickMeme, pushBubble, MEME_POOL, MEME_TRIGGERS, BUBBLE_QUEUE_MAX,
} from '../lib/client/bubble.mjs'

test('HIT_ZONES 声明：两套姿态、矩形 [0,1]、full 行序 tail > head > belly', () => {
  assert.deepEqual(HIT_ZONES.full.map((z) => z.id), ['tail', 'head', 'belly'])
  assert.deepEqual(HIT_ZONES.peek.map((z) => z.id), ['head'])
  for (const zones of Object.values(HIT_ZONES)) {
    for (const z of zones) {
      for (const v of [z.x0, z.y0, z.x1, z.y1]) {
        assert.ok(v >= 0 && v <= 1, `坐标越界：${v}`)
      }
    }
  }
  assert.deepEqual([...ZONE_IDS].sort(), ['belly', 'head', 'tail'])
})

test('hitZone：full 姿态按 tail > head > belly 首个命中', () => {
  assert.equal(hitZone(0.5, 0.9), 'tail') // 尾部压过头部带（y 0.78 以下先判 tail）
  assert.equal(hitZone(0.5, 0.2), 'head')
  assert.equal(hitZone(0.5, 0.6), 'belly')
  // 边界含端点：belly 上沿 0.45 命中 belly（head 上限 0.45 也含 0.45，belly 行在后）。
  assert.equal(hitZone(0.5, 0.45), 'head')
  assert.equal(hitZone(0.5, 0.4501), 'belly')
  // 越界夹取。
  assert.equal(hitZone(-1, 2), 'tail')
  assert.equal(hitZone(2, -1), 'head')
})

test('hitZone：peek 姿态整脸即头；未知姿态回退 full', () => {
  assert.equal(hitZone(0.5, 0.9, 'peek'), 'head')
  assert.equal(hitZone(0.1, 0.1, 'peek'), 'head')
  assert.equal(hitZone(0.5, 0.9, 'nope'), 'tail')
})

test('喂食冷却：30s 内拒绝、到期放行、从未喂过立即可喂', () => {
  const now = 1_000_000
  assert.equal(canFeed(now, null), true)
  assert.equal(canFeed(now, undefined), true)
  assert.equal(canFeed(now, now - FEED_COOLDOWN_MS), true) // 恰好到期
  assert.equal(canFeed(now, now - FEED_COOLDOWN_MS + 1), false)
  assert.equal(canFeed(now, now - 1000), false)
  // 自定义冷却（测试注入）。
  assert.equal(canFeed(now, now - 500, 500), true)
})

test('feedCooldownLeft：剩余毫秒与归零', () => {
  const now = 2_000_000
  assert.equal(feedCooldownLeft(now, null), 0)
  assert.equal(feedCooldownLeft(now, now - 10000), FEED_COOLDOWN_MS - 10000)
  assert.equal(feedCooldownLeft(now, now - FEED_COOLDOWN_MS), 0)
  assert.equal(feedCooldownLeft(now, now - FEED_COOLDOWN_MS - 5), 0)
})

test('表情包池 30 张 + 随机抽样落在池内', () => {
  assert.equal(MEME_POOL.length, 30)
  const picked = pickMeme(() => 0.999)
  assert.ok(MEME_POOL.includes(picked))
  assert.equal(pickMeme(() => 0), MEME_POOL[0])
})

test('matchMemeTrigger：情绪关键词命中 meme-* 素材（预留表）', () => {
  assert.ok(matchMemeTrigger('任务失败了，呜呜')?.includes('meme-cry'))
  assert.ok(matchMemeTrigger('辛苦啦，爱你！')?.includes('meme-heart'))
  assert.ok(matchMemeTrigger('好的没问题')?.includes('meme-yes'))
  assert.ok(matchMemeTrigger('为什么呀？')?.includes('meme-doubt'))
  assert.equal(matchMemeTrigger(''), null)
  assert.equal(matchMemeTrigger('普通文本没有关键词'), null)
  assert.ok(MEME_TRIGGERS.length >= 8, '触发表预留不足')
})

test('pushBubble：FIFO 队列上限丢最旧（纯函数不改入参）', () => {
  const q0 = []
  const q1 = pushBubble(q0, { text: 'a' })
  const q2 = pushBubble(q1, { text: 'b' })
  const q3 = pushBubble(q2, { text: 'c' })
  assert.deepEqual(q3.map((b) => b.text), ['a', 'b', 'c'])
  const q4 = pushBubble(q3, { text: 'd' })
  assert.deepEqual(q4.map((b) => b.text), ['b', 'c', 'd'])
  assert.deepEqual(q3.map((b) => b.text), ['a', 'b', 'c']) // 原队列未被修改
  assert.equal(q4.length, BUBBLE_QUEUE_MAX)
})
