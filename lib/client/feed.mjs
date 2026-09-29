// 喂食冷却（M2-3）：喂「TOKEN 鱼干」→ eat 瞬发；30s 冷却防刷。
// 纯函数（注入时钟时刻），node --test 可单测；宿主（client/main.mjs）持有 lastFedAt。

export const FEED_COOLDOWN_MS = 30000

/**
 * 是否可喂：距上次喂食 ≥ 冷却期。
 * @param {number} now 当前时刻
 * @param {number|null} [lastFedAt] 上次喂食时刻（null/undefined = 从未喂过）
 * @param {number} [cooldownMs] 冷却时长（默认 30s；测试注入）
 * @returns {boolean}
 */
export function canFeed(now, lastFedAt, cooldownMs = FEED_COOLDOWN_MS) {
  if (typeof lastFedAt !== 'number' || !Number.isFinite(lastFedAt)) return true
  return now - lastFedAt >= cooldownMs
}

/** 距下次可喂还差多少毫秒（0 = 立即可喂）。 */
export function feedCooldownLeft(now, lastFedAt, cooldownMs = FEED_COOLDOWN_MS) {
  if (canFeed(now, lastFedAt, cooldownMs)) return 0
  return lastFedAt + cooldownMs - now
}
