// 素材契约（M1-2）：状态 → 主备素材链（chain[0] 首选，逐级降级）。
// 单源说明：本模块是 client/测试共用的契约面；demo 预览页继续用 assets/manifest.js
// （window.PET_MANIFEST 旧面，不改动也不双写）——test/manifest.test.mjs 负责
// 「契约文件真实存在 + 与旧面清单一致」的漂移守卫。
// 契约字段（实测口径，见 docs/sprites-spec.md）：
// - file：包内根相对路径（'assets/…'）；client 侧拼接 ASSET_BASE（/api/whale-pet/assets/）。
// - kind：'image'（动画 WebP，<img> 播放）| 'video'（VP9 alpha WebM，双 <video> 双缓冲）。
// - playback：'loop'（循环到状态结束）| 'once'（播完一次回底层状态；video onended 驱动）。
//   WebP/WebM 均为全动画格式、时序内嵌（浏览器原生解码），故不设 frames/fps——
//   计划 M1-2 的 frames/fps 字段经实测判定无意义，以 playback/kind 为准（附录 B 已记）。
// - motion：可选叠加表现（'shake'），渲染器以 CSS 动画实现；null 表示无。
// - pick：'first'（默认，按链序首个可加载者）| 'random'（链首随机段，working 插曲用）。
// 二期（phase2-plan §10/§11-2）：EXTRA_STATE_ASSETS 15 键「按需入链」——不并入
// STATE_ASSETS/STATE_NAMES（17 状态契约与 docs/state-machine.md §2 不变），由
// resolveStateChain 回落解析（可解析、可降级、可渲染）；角色互换（setCharacter）经
// characters.mjs swapChains 参数化换表（musume 默认零成本，classic 下 9 基础状态链首
// 换 classic 文件 → bbox 查表自然 miss 回退静态热区，characters×bbox 自洽）。

import { swapChains, normalizeCharacterId } from './characters.mjs'

/** client 侧素材路由前缀（与 lib/index.mjs ASSETS_PATH 对应）。 */
export const ASSET_BASE = '/api/whale-pet/assets/'

const img = (file, extra = {}) => ({ file, kind: 'image', playback: 'loop', motion: null, ...extra })
const vid = (file, playback = 'loop') => ({ file, kind: 'video', playback, motion: null })

/**
 * 状态素材契约（17 状态：15 基础 + M5-2 深夜困倦 night + M6-4 遇挫 struggling；另有热区/表情扩展面）。
 * 主备链语义：先按 pick 选出候选组，组内按 chain 序降级；全部缺失降级占位头像。
 */
export const STATE_ASSETS = {
  welcome: { pick: 'first', chain: [img('assets/classic/welcome.webp'), img('assets/musume/dsh-whale-state-daily-done.webp')] },
  think: { pick: 'first', chain: [img('assets/musume/dsh-whale-state-thinking.webp'), img('assets/classic/think.webp')] },
  // working 插曲：三个 webm 段随机（pick:'random' 取链首组），全部缺失降级 work-debug 静图。
  working: {
    pick: 'random',
    chain: [vid('assets/webm/偷吃Token.webm'), vid('assets/webm/东张西望.webm'), vid('assets/webm/工作摸鱼.webm'), img('assets/musume/dsh-whale-state-work-debug.webp')],
  },
  wait: { pick: 'first', chain: [img('assets/musume/dsh-whale-state-waiting.webp'), img('assets/classic/wait.webp')] },
  celebrate: { pick: 'first', chain: [img('assets/musume/dsh-whale-state-work-celebrate.webp'), img('assets/classic/celebrate.webp'), img('assets/musume/dsh-whale-state-game-win.webp')] },
  error: { pick: 'first', chain: [img('assets/musume/dsh-whale-state-angry.webp', { motion: 'shake' }), img('assets/classic/error.webp', { motion: 'shake' })] },
  disappointed: { pick: 'first', chain: [img('assets/musume/dsh-whale-state-meme-cry.webp'), img('assets/classic/disappointed.webp')] },
  sleep: { pick: 'first', chain: [img('assets/musume/dsh-whale-state-work-sleep.webp'), img('assets/classic/sleep.webp')] },
  wake: { pick: 'first', chain: [img('assets/classic/wake.webp'), vid('assets/webm/睡眼惺忪.webm', 'once'), img('assets/musume/dsh-whale-state-daily-stretch.webp')] },
  eat: { pick: 'first', chain: [vid('assets/webm/吃小鱼干.webm', 'once'), img('assets/musume/dsh-whale-state-eat.webp'), img('assets/classic/eat.webp')] },
  play: { pick: 'first', chain: [img('assets/classic/play.webp'), img('assets/musume/dsh-whale-state-daily-stretch.webp')] },
  joy: { pick: 'first', chain: [img('assets/classic/joy.webp'), img('assets/musume/dsh-whale-state-meme-heart.webp')] },
  drag: { pick: 'first', chain: [vid('assets/webm/被鼠标拖拽悬空反馈.webm'), img('assets/musume/dsh-whale-state-pick-up.webp'), img('assets/classic/drag.webp')] },
  walk: { pick: 'first', chain: [img('assets/classic/walk.webp'), vid('assets/webm/螃蟹走路.webm')] },
  // 深夜困倦（M5-2）：深夜静音段内的 idle 兜底视觉（静音段红线：无主动气泡/音效/散步）。
  night: { pick: 'first', chain: [img('assets/musume/dsh-whale-state-night.webp'), img('assets/musume/dsh-whale-state-work-sleep.webp'), img('assets/classic/sleep.webp')] },
  // 遇挫细分（M6-4 融合）：工具失败/模型重试后的困惑视觉（think 期间增强）。
  struggling: { pick: 'first', chain: [img('assets/musume/dsh-whale-state-meme-doubt.webp'), img('assets/musume/dsh-whale-state-work-debug.webp')] },
  idle: { pick: 'first', chain: [img('assets/musume/dsh-whale-state-idle-cute.webp'), img('assets/classic/idle.webp')] },
}

/** 全部状态名（与 docs/state-machine.md §2 一一对应，verify 门禁校验）。 */
export const STATE_NAMES = Object.freeze(Object.keys(STATE_ASSETS))

/**
 * 二期换装/游戏姿势素材（phase2-plan §10，15 键）：game-*×5 / balance-low / festival-*×4 /
 * weather-*×5，image+loop 单链。键集与 bbox.mjs 的 BBOX_STATE_FILES 二期段逐一对应
 * （test/manifest.test.mjs 断言链首 === 本表，漂移守卫单源；weather-rain 的素材名带
 * -happy 后缀，例外映射在此显式成表）。不并入 STATE_ASSETS/STATE_NAMES——保持
 * 17 状态唯一权威（docs/state-machine.md §2）与 manifest.test 长度断言不变。
 * 这些状态是 idle 兜底视觉覆盖（festival.mjs idleOverlayVisual 的输出域），不进状态机行序。
 */
export const EXTRA_STATE_ASSETS = {
  'game-think': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-game-think.webp')] },
  'game-happy': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-game-happy.webp')] },
  'game-cheat': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-game-cheat.webp')] },
  'game-win': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-game-win.webp')] },
  'game-lose': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-game-lose.webp')] },
  'balance-low': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-balance-low.webp')] },
  'festival-spring': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-festival-spring.webp')] },
  'festival-christmas': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-festival-christmas.webp')] },
  'festival-halloween': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-festival-halloween.webp')] },
  'festival-mid-autumn': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-festival-mid-autumn.webp')] },
  'weather-rain': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-weather-rain-happy.webp')] },
  'weather-snow': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-weather-snow.webp')] },
  'weather-thunder': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-weather-thunder.webp')] },
  'weather-umbrella': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-weather-umbrella.webp')] },
  'weather-cold': { pick: 'first', chain: [img('assets/musume/dsh-whale-state-weather-cold.webp')] },
}

/** 分区热区反应素材（M2）：头/肚子/尾巴。 */
export const REACT_ASSETS = Object.freeze({
  head: [img('assets/musume/dsh-whale-state-react-head.webp')],
  belly: [img('assets/musume/dsh-whale-state-react-belly.webp')],
  tail: [img('assets/musume/dsh-whale-state-react-tail.webp')],
})

/** 占位头像（全链缺失/低配降级）。 */
export const AVATAR = 'assets/classic/avatar.png'

/** 表情包目录前缀（M2 气泡：assets/memes/meme-001..030.webp）。 */
export const MEME_COUNT = 30
export const memeUrl = (i) => `${ASSET_BASE}memes/meme-${String(i).padStart(3, '0')}.webp`

/**
 * 当前角色的状态素材表（默认 musume = STATE_ASSETS 本体引用，零拷贝零成本）。
 * setCharacter 经 characters.mjs swapChains 换表（同入参 memo 复用，幂等可重入）。
 */
let activeStateAssets = STATE_ASSETS
let activeCharacter = 'musume'

/**
 * 角色变体切换（phase2-plan §11-2；main.mjs 启动与设置热应用时调用，幂等）：
 * - 'musume'/脏值（normalizeCharacterId 归一）→ 回默认表（原引用）；
 * - 'classic' → swapChains(STATE_ASSETS, 'classic')（链内存在 assets/classic/<状态名>.webp
 *   精确条目的 9 个基础状态升主；musume 专属状态与二期 EXTRA 面不在互换域——classic 套
 *   仅覆盖一期基础状态）。REACT_ASSETS 不参与互换（classic 无对应件）。
 * @param {unknown} id 角色 id（settings.character；脏数据回 'musume'）
 */
export function setCharacter(id) {
  activeCharacter = normalizeCharacterId(id)
  activeStateAssets = swapChains(STATE_ASSETS, activeCharacter)
}

/** 当前角色 id（归一化后；观测面/测试用）。 */
export function getCharacterId() {
  return activeCharacter
}

/**
 * 解析状态的候选序列：先查当前角色表（musume/classic），再回落二期 EXTRA_STATE_ASSETS
 * （game-×5、festival-×4、weather-×5、balance-low 为 musume 专属换装面，classic 下原链）；
 * 都未命中 → 占位头像链。pick='random' 时先随机选出链首组内一段（视频段），
 * 其后仍按链序降级；pick='first' 原样返回整链。
 * @param {string} state 状态名
 * @param {() => number} [rng] 随机源（测试注入；默认 Math.random）
 * @returns {Array<{file,kind,playback,motion}>} 有序候选链
 */
export function resolveStateChain(state, rng = Math.random) {
  const def = activeStateAssets[state] ?? EXTRA_STATE_ASSETS[state]
  if (!def) return [img(AVATAR)]
  if (def.pick !== 'random') return def.chain
  // 链首组 = 连续的 video 段（working 插曲池）；随机取其一，其后接降级链。
  const videos = []
  let i = 0
  while (i < def.chain.length && def.chain[i].kind === 'video') {
    videos.push(def.chain[i])
    i += 1
  }
  if (videos.length === 0) return def.chain
  const picked = videos[Math.floor(rng() * videos.length) % videos.length]
  return [picked, ...def.chain.slice(i)]
}

/** 由 file 拼出 client 可取的 URL（ ASSET_BASE + 去掉 'assets/' 前缀）。 */
export function assetUrl(file) {
  const rel = file.startsWith('assets/') ? file.slice('assets/'.length) : file
  return ASSET_BASE + rel.split('/').map(encodeURIComponent).join('/')
}
