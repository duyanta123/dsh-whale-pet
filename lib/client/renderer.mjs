// 鲸鱼娘桌宠 · 渲染器（M1-5，docs/sprites-spec.md §4 实现规格）。
// 职责：状态 → 素材播放（动画 WebP 用 <img>；WebM 用双 <video> 双缓冲交叉淡入）、
// 朝向 flip（素材统一朝左基准，flip=±1 镜像）、统一地面定位线、主备链降级、
// prefers-reduced-motion 降级静态图、素材全缺失降级占位头像（可选插件失败隔离）。
// 只做播放不持状态决策：状态由 logic.mjs 选择、宿主 client/main.mjs 驱动。
// 竞态防护（双缓冲核心）：每次切换携带递增代数 gen，loadeddata 回调核对代数——
// 不是最新代即放弃（避免快速连切时旧回调把已过期的视频提到前台）。
import { resolveStateChain, assetUrl, AVATAR } from '../assets-manifest.mjs'

const STYLE_ID = 'whale-pet-renderer-style'

const CSS = `
.whale-pet-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:bottom;
  opacity:0;transition:opacity .18s ease;pointer-events:none}
.whale-pet-video.is-front{opacity:1}
@keyframes whale-pet-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4%)}75%{transform:translateX(4%)}}
.whale-pet-shake{animation:whale-pet-shake .12s linear 6}
@media (prefers-reduced-motion:reduce){.whale-pet-video{transition:none}}
`

function ensureRendererStyle() {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/**
 * 创建渲染器。
 * @param {{ stage: HTMLElement, onOnceEnded?: () => void, random?: () => number }} opts
 *   stage=宠物舞台容器（定位上下文）；onOnceEnded=once 素材播完回调（宿主清瞬发）；
 *   random=随机源（working 插曲池抽取，测试注入）。
 * @returns {{ show: (state: string) => void, setFacing: (flip: number) => void, current: () => string, dispose: () => void }}
 */
export function createRenderer({ stage, onOnceEnded, random = Math.random }) {
  ensureRendererStyle()

  const media = stage.querySelector('img')
  const reducedMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // ---- 双 video 缓冲（A/B 交替，is-front 交叉淡入）----
  const videos = []
  for (let i = 0; i < 2; i += 1) {
    const video = document.createElement('video')
    video.className = 'whale-pet-video'
    video.muted = true
    video.autoplay = true
    video.playsInline = true
    video.preload = 'auto'
    video.dataset.slot = String(i)
    stage.appendChild(video)
    videos.push(video)
  }
  let front = -1 // 当前前台的 video 槽位（-1 表示无 video 在前台）
  let gen = 0 // 切换代数：过期回调据此放弃
  let currentState = ''
  let pendingKey = '' // 待展示素材键（image probe 回调核对，防过期）
  let disposed = false

  const clearShake = () => stage.classList.remove('whale-pet-shake')

  /** 从链的 start 下标起解析播放：image 直接可播、video 等 loadeddata；失败继续降级。 */
  const advance = (state, start) => {
    const chain = resolveStateChain(state, random)
    for (let i = start; i < chain.length; i += 1) {
      const entry = chain[i]
      const key = `${state}:${entry.file}`
      if (entry.kind === 'image' || reducedMotion) {
        // image：探测成功才切（onerror 继续降级）；过期探测直接丢弃。
        pendingKey = key
        const probe = new Image()
        probe.onload = () => {
          if (disposed || pendingKey !== key) return
          showImage(entry, key)
        }
        probe.onerror = () => {
          if (disposed || pendingKey !== key) return
          advance(state, i + 1)
        }
        probe.src = assetUrl(entry.file)
        return
      }
      // video：装载到非前台缓冲，就绪后交叉淡入；装载失败继续降级。
      pendingKey = key
      const myGen = ++gen
      const target = videos[front === 0 ? 1 : 0]
      const old = front === -1 ? null : videos[front]
      const onReady = () => {
        target.removeEventListener('loadeddata', onReady)
        target.removeEventListener('error', onFail)
        if (myGen !== gen || disposed) return // 过期回调：放弃（快速连切竞态防护）
        if (old !== null) {
          old.pause()
          old.classList.remove('is-front')
        }
        target.classList.add('is-front')
        front = Number(target.dataset.slot)
        target.play().catch(() => {}) // 自动播放策略异常静默（静音视频仍可播）
        currentState = state
        stage.classList.toggle('whale-pet-shake', entry.motion === 'shake')
        if (entry.playback === 'once' && typeof onOnceEnded === 'function') {
          target.onended = () => {
            target.onended = undefined
            onOnceEnded()
          }
        }
      }
      const onFail = () => {
        target.removeEventListener('loadeddata', onReady)
        target.removeEventListener('error', onFail)
        if (myGen !== gen || disposed) return
        advance(state, i + 1) // 该候选失败 → 链上下一个
      }
      target.addEventListener('loadeddata', onReady)
      target.addEventListener('error', onFail)
      target.src = assetUrl(entry.file)
      target.load()
      return
    }
    // 全链缺失 → 占位头像（永不失败的最后兜底；占位也缺失则静默黑块）。
    showImage({ file: AVATAR, kind: 'image', playback: 'loop', motion: null }, `${state}:${AVATAR}`)
  }

  const showImage = (entry, key) => {
    gen += 1 // 作废所有在途 video 回调
    if (front !== -1) {
      const old = videos[front]
      old.pause()
      old.classList.remove('is-front')
      old.removeAttribute('src')
      front = -1
    }
    media.src = assetUrl(entry.file)
    currentState = key.slice(0, key.indexOf(':'))
    stage.classList.toggle('whale-pet-shake', entry.motion === 'shake')
  }

  return {
    /** 播放状态（幂等：同状态不重载；状态变化时按链解析并降级）。 */
    show(state) {
      if (disposed || state === currentState) return
      currentState = state
      clearShake()
      advance(state, 0)
    },
    /** 朝向（素材朝左基准）：flip=1 朝左、-1 朝右（scaleX(-1) 镜像）。 */
    setFacing(flip) {
      stage.style.transform = flip === -1 ? 'scaleX(-1)' : ''
    },
    current: () => currentState,
    dispose() {
      if (disposed) return
      disposed = true
      gen += 1
      clearShake()
      for (const video of videos) {
        video.pause()
        video.removeAttribute('src')
        video.load()
        video.remove()
      }
    },
  }
}
