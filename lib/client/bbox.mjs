// 动态 bbox 热区（二期 ⑥）：逐状态归一化 bbox 解析 + flip 镜像命中，取代一期
// 「全状态静态并集」热区。决策依据 refs/whale-girl
// decisions/implemented/bug-fix/2026-08-09-hitarea-follows-state.md——
// ① 热区跟随当前状态（逐状态 bbox，walk 等宽幅状态不再把并集撑大）；
// ② 只取首帧（多帧 sheet 的第 2..N 帧内容跨度不计入 bbox，生成口径见
//    tools/analyze-bbox.py：PIL 首帧 alpha>=8 不透明像素 → 归一化 [0,1]）；
// ③ 热区按内容实际位置对齐（flip=-1 时先镜像点 x 再对矩形判定，§8 flip 语义）；
// ④ 点在 bbox 外 → null（宿主不触发热区反应，消除「空白可点」的原始缺陷）。
// 表 lib/client/bbox-table.json 由 python tools/analyze-bbox.py 真实生成入库
// （92 文件全表，--check 可同步校验）；纯逻辑零 DOM/零定时器/零 fetch，node --test 直测。
// 链首解析三段口径（phase2-plan §2.6，防 characters×bbox 错位）：
//   ① 一期 9 键 → 现存导出 resolveStateChain(state)[0].file 实时链首——classic 角色
//     下链首变 classic 文件 → 不在本表 → null → 回退静态热区（热区随显示素材几何自洽）；
//   ② react 3 键 → 现存导出 REACT_ASSETS[zone][0].file（不可走 resolveStateChain：
//     react-* 不在 STATE_ASSETS，会命中占位头像回落，assets-manifest.mjs:74-76）；
//   ③ 二期 15 键 → 本冻结映射查表（classic 套无对应件，链首恒 musume；集成工程师落地
//     EXTRA_STATE_ASSETS 时在 test/manifest.test.mjs 断言链首 === 本表，漂移守卫单源）。
// 无表/未知状态回退 hitzone.mjs 现有静态 full 表（恒返回三区之一），不修改 hitzone.mjs。

import table from './bbox-table.json' with { type: 'json' }
import { resolveStateChain, REACT_ASSETS } from './assets-manifest.mjs'
import { hitZone } from './hitzone.mjs'

/** 表结构版本（= 表 _meta.version；消费方按版本兼容，当前 1）。 */
export const BBOX_TABLE_VERSION = table._meta.version

/**
 * 冻结 27 键映射：状态 id → assets/musume 链首素材 basename（表键）。
 * 构成 = 一期 9（think/wait/celebrate/error/disappointed/sleep/night/struggling/idle）
 * + react 3（react-head/belly/tail）+ 二期 15（game-*5 / balance-low / festival-*4 / weather-*5）。
 * 双重身份：③ 段的运行时链首来源 + 集成工程师 EXTRA_STATE_ASSETS 漂移守卫基线
 * （phase2-plan §2.6/§11 步骤 2.1；weather-rain→weather-rain-happy 这类例外映射必须显式成表）。
 */
export const BBOX_STATE_FILES = Object.freeze({
  // 一期 9 键（实时链首见 resolveStateChain；此处 basename 供漂移守卫比对）
  think: 'dsh-whale-state-thinking.webp',
  wait: 'dsh-whale-state-waiting.webp',
  celebrate: 'dsh-whale-state-work-celebrate.webp',
  error: 'dsh-whale-state-angry.webp',
  disappointed: 'dsh-whale-state-meme-cry.webp',
  sleep: 'dsh-whale-state-work-sleep.webp',
  night: 'dsh-whale-state-night.webp',
  struggling: 'dsh-whale-state-meme-doubt.webp',
  idle: 'dsh-whale-state-idle-cute.webp',
  // react 3 键（REACT_ASSETS 实时链首）
  'react-head': 'dsh-whale-state-react-head.webp',
  'react-belly': 'dsh-whale-state-react-belly.webp',
  'react-tail': 'dsh-whale-state-react-tail.webp',
  // 二期 15 键（冻结映射即链首）
  'game-think': 'dsh-whale-state-game-think.webp',
  'game-happy': 'dsh-whale-state-game-happy.webp',
  'game-cheat': 'dsh-whale-state-game-cheat.webp',
  'game-win': 'dsh-whale-state-game-win.webp',
  'game-lose': 'dsh-whale-state-game-lose.webp',
  'balance-low': 'dsh-whale-state-balance-low.webp',
  'festival-spring': 'dsh-whale-state-festival-spring.webp',
  'festival-christmas': 'dsh-whale-state-festival-christmas.webp',
  'festival-halloween': 'dsh-whale-state-festival-halloween.webp',
  'festival-mid-autumn': 'dsh-whale-state-festival-mid-autumn.webp',
  'weather-rain': 'dsh-whale-state-weather-rain-happy.webp', // 例外映射：素材名带 -happy，必须显式成表
  'weather-snow': 'dsh-whale-state-weather-snow.webp',
  'weather-thunder': 'dsh-whale-state-weather-thunder.webp',
  'weather-umbrella': 'dsh-whale-state-weather-umbrella.webp',
  'weather-cold': 'dsh-whale-state-weather-cold.webp',
})

/** 一期 9 键（链首解析 ① 段走 resolveStateChain 实时解析；②③ 段见文件头）。 */
const PHASE1_STATES = new Set([
  'think', 'wait', 'celebrate', 'error', 'disappointed',
  'sleep', 'night', 'struggling', 'idle',
])

// 三段分区比例沿用 hitzone.mjs 静态 full 表（lib/client/hitzone.mjs:7-11：
// head 0–0.45 / belly 0.45–0.78 / tail 0.78–1.0），保证 head/belly/tail 语义连续。
// 边界按 phase2-plan §2.6 公式「≤0.45 head / ≤0.78 belly / 其余 tail」字面落。
const HEAD_SPLIT = 0.45
const BELLY_SPLIT = 0.78

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))
const basenameOf = (file) => {
  const i = file.lastIndexOf('/')
  return i >= 0 ? file.slice(i + 1) : file
}

/**
 * 状态 → 链首 basename（三段口径，见文件头）。
 * @param {string} state 状态 id
 * @returns {string|null} 链首文件 basename；未知状态/缺链 → null
 */
function chainHeadBasename(state) {
  if (!Object.hasOwn(BBOX_STATE_FILES, state)) return null
  if (state.startsWith('react-')) {
    // ② react 3 键：REACT_ASSETS 实时链首（musume 专属素材，无 classic 对应件）
    const chain = REACT_ASSETS[state.slice('react-'.length)]
    return chain && chain[0] ? basenameOf(chain[0].file) : null
  }
  if (!PHASE1_STATES.has(state)) return BBOX_STATE_FILES[state]
  // ① 一期 9 键：实时链首（classic 角色下返回 classic 文件 → 调用方查表 miss）
  const chain = resolveStateChain(state)
  return chain && chain[0] ? basenameOf(chain[0].file) : null
}

/**
 * 状态 → 当前显示素材的归一化 bbox（表 lib/client/bbox-table.json 查表）。
 * @param {string} state 状态 id（未知状态 → null）
 * @param {{ chainHeadFile?: string }} [opts] 注入链首 file 覆盖实时解析
 *   （classic 角色用例/测试由此构造；注入后按显示素材几何查表——链首不在
 *   assets/musume 表内即 null，回退静态热区，热区与显示素材不脱钩）
 * @returns {{x0,y0,x1,y1}|null} 归一化矩形（冻结副本）| null
 *   （未知状态 / 链首不在表 / 表项全透明 null）
 */
export function resolveBBox(state, { chainHeadFile } = {}) {
  const file = chainHeadFile != null && chainHeadFile !== ''
    ? String(chainHeadFile)
    : chainHeadBasename(state)
  if (!file) return null
  const rect = table.files[basenameOf(file)]
  if (!rect) return null
  return Object.freeze({ x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 })
}

/**
 * 热区命中：舞台内归一化点 (nx,ny) 对当前状态 bbox 判定。
 * 有表状态：flip=-1（朝右，scaleX(-1) 镜像）先镜像点 x（x←1−x）再夹取 [0,1]
 *（镜像与夹取可交换，先镜像系 §8 口径字面落）；点在 bbox 外 → null（宿主不触发
 * 反应——whale-girl 决策核心收益）；点在内 → 按矩形高度三段分区（相对 y
 * ≤0.45 head / ≤0.78 belly / 其余 tail，比例沿用静态 full 表）。
 * 无表状态：回退 hitzone.mjs 现有静态 full 表（恒返回三区之一，不修改 hitzone.mjs）。
 * 静态表 x 向对称，传镜像后坐标与一期 hitZone(nx,ny,'full') 行为完全一致。
 * @param {number} nx 归一化 x
 * @param {number} ny 归一化 y
 * @param {string} state 当前动画状态 id（renderer.current()）
 * @param {{ flip?: 1|-1, chainHeadFile?: string }} [opts] flip 朝向（1 朝左 / -1 朝右）
 * @returns {'head'|'belly'|'tail'|null} 命中区；bbox 外 → null
 */
export function bboxHit(nx, ny, state, { flip = 1, chainHeadFile } = {}) {
  const x = clamp01(flip === -1 ? 1 - nx : nx)
  const y = clamp01(ny)
  const rect = resolveBBox(state, { chainHeadFile })
  if (!rect) return hitZone(x, y, 'full')
  if (x < rect.x0 || x > rect.x1 || y < rect.y0 || y > rect.y1) return null
  const h = rect.y1 - rect.y0
  if (!(h > 0)) return 'head'
  const relY = (y - rect.y0) / h
  if (relY <= HEAD_SPLIT) return 'head'
  if (relY <= BELLY_SPLIT) return 'belly'
  return 'tail'
}
