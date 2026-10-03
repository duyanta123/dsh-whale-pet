// 气泡容器（M2-4）：任务完成信息 / 表情包 / 主动播报共用。
// 纯函数面（触发表/队列）与 DOM 面分离——node --test 只测纯函数。
// 随机吐槽：assets/memes/ 30 张抽样弹 5s；meme-* 素材按情绪关键词预留触发表（M5 主动播报接入）。
import { MEME_COUNT, memeUrl, assetUrl } from './assets-manifest.mjs'

/** 表情包池（30 张，随机吐槽抽样用）。 */
export const MEME_POOL = Object.freeze(
  Array.from({ length: MEME_COUNT }, (_, i) => memeUrl(i + 1)),
)

/** 气泡默认展示时长（随机吐槽 5s）。 */
export const BUBBLE_SHOW_MS = 5000
/** 队列上限：超出丢最旧（防长任务刷屏）。 */
export const BUBBLE_QUEUE_MAX = 3

/**
 * 情绪关键词 → meme-* 素材触发表（预留； musume 套 18 个 meme 状态按语义摘录常用 8 个）。
 * pattern 命中文案即返回素材文件（assetUrl 拼接）。
 */
export const MEME_TRIGGERS = Object.freeze([
  { id: 'cry', file: 'assets/musume/dsh-whale-state-meme-cry.webp', pattern: /哭|难过|失败|出错|error|failed/i },
  { id: 'heart', file: 'assets/musume/dsh-whale-state-meme-heart.webp', pattern: /喜欢|开心|爱你|辛苦了|感谢|thank/i },
  { id: 'yes', file: 'assets/musume/dsh-whale-state-meme-yes.webp', pattern: /好的|没问题|收到|完成|done|ok/i },
  { id: 'no', file: 'assets/musume/dsh-whale-state-meme-no.webp', pattern: /不行|拒绝|不要|取消|cancel/i },
  { id: 'doubt', file: 'assets/musume/dsh-whale-state-meme-doubt.webp', pattern: /为什么|什么意思|怎么|why|\?|？/ },
  { id: 'shock', file: 'assets/musume/dsh-whale-state-meme-shock.webp', pattern: /震惊|居然|竟然|哇|卧槽|wow/i },
  { id: 'smug', file: 'assets/musume/dsh-whale-state-meme-smug.webp', pattern: /厉害|优秀|完美|漂亮|nice|perfect/i },
  { id: 'wakuwaku', file: 'assets/musume/dsh-whale-state-meme-wakuwaku.webp', pattern: /开始|出发|冲|加油|go|start/i },
])

/** 文案 → meme 素材 URL（首个命中；无命中 null）。 */
export function matchMemeTrigger(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  for (const trigger of MEME_TRIGGERS) {
    if (trigger.pattern.test(text)) return assetUrl(trigger.file)
  }
  return null
}

/** 随机抽一张表情包 URL（注入随机源可单测）。 */
export function pickMeme(random = Math.random) {
  return MEME_POOL[Math.floor(random() * MEME_POOL.length) % MEME_POOL.length]
}

/** 气泡入队（纯函数）：FIFO，超上限丢最旧。 */
export function pushBubble(queue, item, max = BUBBLE_QUEUE_MAX) {
  const next = [...queue, item]
  return next.length > max ? next.slice(next.length - max) : next
}

/**
 * 创建气泡容器（挂 host 内、stage 外——stage 有朝向 scaleX(-1) 镜像，气泡文字不能跟着翻）。
 * @param {{ host: HTMLElement }} deps host=宠物根容器（与 stage 同盒、无 transform）
 * @returns {{ say: (text: string, opts?: { memeUrl?: string, ms?: number }) => void,
 *             hide: () => void, dispose: () => void }}
 */
export function createBubble({ host }) {
  const el = document.createElement('div')
  el.className = 'whale-pet-bubble'
  el.setAttribute('role', 'status')
  el.style.cssText = [
    'position:absolute', 'left:50%', 'bottom:calc(100% + 10px)', 'transform:translateX(-50%)',
    'max-width:220px', 'padding:8px 12px', 'border-radius:12px',
    'background:rgba(24,28,38,.94)', 'color:#e8ebf2', 'font-size:12px', 'line-height:17px',
    'box-shadow:0 6px 18px rgba(0,0,0,.28)', 'text-align:center',
    'opacity:0', 'transition:opacity .18s ease', 'pointer-events:none',
    'white-space:pre-line', 'z-index:2',
  ].join(';')
  const img = document.createElement('img')
  img.alt = ''
  img.draggable = false
  img.style.cssText = 'display:none;max-width:180px;max-height:120px;border-radius:8px;margin:0 auto 4px'
  const text = document.createElement('div')
  text.style.cssText = 'display:none'
  el.appendChild(img)
  el.appendChild(text)
  host.appendChild(el)

  let hideTimer = null

  const render = (item) => {
    if (item.memeUrl) {
      img.src = item.memeUrl
      img.style.display = 'block'
    } else {
      img.removeAttribute('src')
      img.style.display = 'none'
    }
    text.textContent = item.text ?? ''
    text.style.display = item.text ? 'block' : 'none'
    el.style.opacity = '1'
    if (hideTimer !== null) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      hideTimer = null
      el.style.opacity = '0'
    }, item.ms ?? BUBBLE_SHOW_MS)
  }

  return {
    say(text2, opts = {}) {
      render({ text: text2, memeUrl: opts.memeUrl ?? null, ms: opts.ms })
    },
    hide() {
      if (hideTimer !== null) clearTimeout(hideTimer)
      hideTimer = null
      el.style.opacity = '0'
    },
    dispose() {
      if (hideTimer !== null) clearTimeout(hideTimer)
      hideTimer = null
      el.remove()
    },
  }
}
