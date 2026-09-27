// 鲸鱼娘桌宠 · client 主模块（ESM）。
// 由 lib/client.js（普通脚本工厂）动态 import 装载；本文件与 lib/client/*.mjs
// 同走 /api/whale-pet/client/* 同源路由，可被 node --test 直接单测（纯逻辑部分）。
// 职责：slots 注入（shell.overlay 本体 + settings.section 设置卡）、宠物 DOM 装载、
// 生命周期 dispose（幂等可重入——0.1.7 运行时卸载契约）。
// M0：占位宠物（classic/idle.webp 验证资源链路）+ 占位设置卡；M1 起替换为渲染器/状态机。

/** 注入一次的样式（id 幂等：重复挂载先查重）。 */
const STYLE_ID = 'whale-pet-style'

const CSS = `
.whale-pet-host{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:120px;height:120px;
  font-family:system-ui,-apple-system,'Segoe UI',sans-serif;user-select:none;touch-action:none;pointer-events:none}
.whale-pet-stage{position:relative;width:100%;height:100%;pointer-events:auto;cursor:grab}
.whale-pet-stage:active{cursor:grabbing}
.whale-pet-media{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:1}
.whale-pet-badge{position:absolute;left:50%;top:-14px;transform:translateX(-50%);
  background:rgba(24,28,38,.92);color:#e8ebf2;font-size:10px;line-height:16px;border-radius:6px;
  padding:1px 6px;white-space:nowrap;pointer-events:none}
`

function ensureStyle() {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/** 占位设置卡（React——settings.section 槽渲染方是 React，组件必须是 React 组件）。 */
function createSettingsCard(React) {
  const h = React.createElement
  return function SettingsCard() {
    return h('div', { style: { padding: '8px 0', fontSize: '13px' } },
      h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '鲸鱼娘桌宠'),
      h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #8a93a6)' } },
        '桌宠已加载（骨架占位卡）。状态镜像 / 交互 / 仪表板 / 养成随里程碑逐个上线。'),
    )
  }
}

/**
 * 挂载桌宠（由 client.js 工厂调用）。
 * @param {{ ctx: object, React: object }} deps ctx=client 半侧 cordis 上下文（slots 服务）；
 *   React=平台提供的 react（槽组件用）。
 * @returns {() => void} dispose（幂等可重入：slots 注销 + DOM 清理 + 定时器清理）。
 */
export function mountPet({ ctx, React }) {
  const h = React.createElement
  let disposed = false
  const disposers = []

  ensureStyle()

  // ---- 宠物本体（命令式 DOM，挂进 shell.overlay 槽渲染出的容器）----
  const host = document.createElement('div')
  host.className = 'whale-pet-host'
  host.setAttribute('data-whale-pet', '')

  const stage = document.createElement('div')
  stage.className = 'whale-pet-stage'
  stage.setAttribute('role', 'img')
  stage.setAttribute('aria-label', '鲸鱼娘桌宠')
  const media = document.createElement('img')
  media.className = 'whale-pet-media'
  media.alt = ''
  media.draggable = false
  media.src = '/api/whale-pet/assets/classic/idle.webp'
  stage.appendChild(media)
  host.appendChild(stage)

  /** 槽容器就绪/销毁桥：React ref 回调（el 非 null 挂载、null 卸载）。 */
  let mountHost = null
  const mountInto = (el) => {
    mountHost = el
    el.appendChild(host)
  }
  const unmountFrom = () => {
    host.remove()
    mountHost = null
  }

  function PetMount() {
    return h('div', {
      ref: (el) => { if (el) mountInto(el); else unmountFrom() },
      style: { display: 'contents' },
    })
  }

  // ---- slots 注入（generator 叠加模式：不替换其他条目）----
  const injectSlot = (slotName, def, component, label) => {
    try {
      const off = ctx.slots.inject(slotName, function* () {
        yield ctx.slots.register(def, component)
      })
      if (typeof off === 'function') disposers.push(off)
    } catch (error) {
      console.warn(`[whale-pet] 槽位 ${label} 注册失败（宠物照常尝试直挂）：`, error)
      // 失败隔离：overlay 槽缺席时直挂 body（降级路径，正常组合不会走到）。
      if (slotName === 'shell.overlay') document.body.appendChild(host)
    }
  }
  injectSlot('shell.overlay', { name: 'shell.overlay', id: 'whale-pet-overlay', order: 1000 }, PetMount, 'shell.overlay')
  injectSlot('settings.section', {
    name: 'settings.section',
    id: 'whale-pet-settings',
    order: 30,
    label: '鲸鱼娘桌宠',
  }, createSettingsCard(React), 'settings.section')

  return function dispose() {
    if (disposed) return
    disposed = true
    for (const off of disposers.splice(0)) {
      try { off() } catch {}
    }
    host.remove()
  }
}
