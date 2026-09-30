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

/** client 侧素材路由前缀（与 lib/index.mjs ASSETS_PATH 对应）。 */
export const ASSET_BASE = '/api/whale-pet/assets/'

const img = (file, extra = {}) => ({ file, kind: 'image', playback: 'loop', motion: null, ...extra })
const vid = (file, playback = 'loop') => ({ file, kind: 'video', playback, motion: null })

/**
 * 状态素材契约（16 状态：15 基础 + M5-2 深夜困倦 night；另有热区/表情扩展面）。
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
  idle: { pick: 'first', chain: [img('assets/musume/dsh-whale-state-idle-cute.webp'), img('assets/classic/idle.webp')] },
}

/** 全部状态名（与 docs/state-machine.md §2 一一对应，verify 门禁校验）。 */
export const STATE_NAMES = Object.freeze(Object.keys(STATE_ASSETS))

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
 * 解析状态的候选序列：pick='random' 时先随机选出链首组内一段（视频段），
 * 其后仍按链序降级；pick='first' 原样返回整链。
 * @param {string} state 状态名
 * @param {() => number} [rng] 随机源（测试注入；默认 Math.random）
 * @returns {Array<{file,kind,playback,motion}>} 有序候选链
 */
export function resolveStateChain(state, rng = Math.random) {
  const def = STATE_ASSETS[state]
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
