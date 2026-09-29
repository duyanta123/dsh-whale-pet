// 分区热区（M2-2，docs/sprites-spec.md 热区节）：[0,1] 归一化矩形静态声明，
// 参照 musume whale-moe-core 两套姿态——full 按 tail > head > belly 行序首个命中，
// peek（探头小窗姿态）整脸即头。纯函数无 DOM，node --test 可单测。
// 命中返回区 id：'head' | 'belly' | 'tail'；越界坐标先夹取到 [0,1]；无命中兜底 'head'。

export const HIT_ZONES = Object.freeze({
  full: Object.freeze([
    Object.freeze({ id: 'tail', x0: 0.0, y0: 0.78, x1: 1.0, y1: 1.0 }),
    Object.freeze({ id: 'head', x0: 0.2, y0: 0.0, x1: 0.8, y1: 0.45 }),
    Object.freeze({ id: 'belly', x0: 0.18, y0: 0.45, x1: 0.82, y1: 0.78 }),
  ]),
  peek: Object.freeze([Object.freeze({ id: 'head', x0: 0.0, y0: 0.0, x1: 1.0, y1: 1.0 })]),
})

export const ZONE_IDS = Object.freeze(['head', 'belly', 'tail'])

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))

/**
 * 热区命中：坐标为舞台内归一化点（[0,1]），按姿态分区表行序首个包含即返回。
 * @param {number} nx 归一化 x
 * @param {number} ny 归一化 y
 * @param {'full'|'peek'} [pose] 姿态（探头用 peek）；未知姿态回退 full
 * @returns {'head'|'belly'|'tail'}
 */
export function hitZone(nx, ny, pose = 'full') {
  const x = clamp01(nx)
  const y = clamp01(ny)
  const zones = HIT_ZONES[pose] ?? HIT_ZONES.full
  for (const zone of zones) {
    if (x >= zone.x0 && x <= zone.x1 && y >= zone.y0 && y <= zone.y1) return zone.id
  }
  return 'head'
}
