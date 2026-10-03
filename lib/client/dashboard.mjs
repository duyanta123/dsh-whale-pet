// 用量仪表板（M3-4）：手写内联 SVG 柱状图（按小时/天切换）+ 悬停 tooltip +
// 面板位置存 localStorage；📊 入口在设置卡（window 事件 toggle）。
// 纯函数面（柱状布局/标签）与 DOM 面分离——node --test 只测纯函数。不引图表库。
import { fmtTokens, money } from './usage.mjs'

export const DASHBOARD_POS_KEY = 'whale-pet.dashboard'
export const VIEW_W = 100
export const VIEW_H = 40

// 与 usage-ledger.mjs 的分桶口径一致：桶 start 为北京时区（UTC+8）对齐的 UTC 毫秒，
// 标签须按固定北京偏移格式化（取 UTC 字段），用查看者本地时区会小时偏移/日期偏一天。
const BJ_OFFSET_MS = 8 * 3600e3

const round4 = (n) => Math.round((Number(n) || 0) * 1e4) / 1e4

/**
 * 柱状布局（纯函数）：桶序列 → 归一化柱体几何与标签。
 * @param {Array<{start: number, tokens: {total: number}, costHitCny: number,
 *   costMissCny: number, costOutCny: number}>} buckets 时/日桶（已按 start 升序）
 * @param {'hours'|'days'} mode
 * @returns {Array<{ x: number, w: number, h: number, label: string, tokens: number, cost: number }>}
 *   x/w/h 为 viewBox（0..100 / 0..40）坐标；h=0 表示空桶（仍占位以便 tooltip）。
 */
export function barLayout(buckets, mode) {
  const list = Array.isArray(buckets) ? buckets : []
  const maxTokens = list.reduce((m, b) => Math.max(m, Number(b?.tokens?.total) || 0), 0)
  const slot = list.length > 0 ? VIEW_W / list.length : VIEW_W
  const barW = Math.max(1.2, slot * 0.62)
  return list.map((bucket, i) => {
    const tokens = Number(bucket?.tokens?.total) || 0
    const cost = round4((Number(bucket?.costHitCny) || 0) + (Number(bucket?.costMissCny) || 0) + (Number(bucket?.costOutCny) || 0))
    const h = maxTokens > 0 && tokens > 0 ? Math.max(0.6, (tokens / maxTokens) * (VIEW_H - 4)) : 0
    const date = new Date(bucket.start + BJ_OFFSET_MS)
    const label = mode === 'days'
      ? `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
      : `${String(date.getUTCHours()).padStart(2, '0')}:00`
    return {
      x: round4(i * slot + (slot - barW) / 2),
      w: round4(barW),
      h: round4(h),
      label,
      tokens,
      cost,
      tip: `${label} · ${fmtTokens(tokens)} tokens · ${money(cost)}`,
    }
  })
}

/** tooltip 文本（hours 模式带日期，days 模式不带小时）。 */
export function axisLabel(buckets, mode) {
  const list = Array.isArray(buckets) ? buckets : []
  if (list.length === 0) return ''
  const first = new Date(list[0].start + BJ_OFFSET_MS)
  const last = new Date(list[list.length - 1].start + BJ_OFFSET_MS)
  const d = (x) => `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`
  return mode === 'days' ? `${d(first)} ~ ${d(last)}` : `${d(first)} ${String(first.getUTCHours()).padStart(2, '0')}:00 起`
}

/**
 * 创建仪表板面板（挂 host 内 fixed 定位；默认隐藏，toggle 显示）。
 * @param {{ host: HTMLElement }} deps
 * @returns {{ toggle: () => void, refresh: () => Promise<void>, dispose: () => void }}
 */
export function createDashboard({ host }) {
  const panel = document.createElement('div')
  panel.className = 'whale-pet-dash'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '用量仪表板')
  panel.style.cssText = [
    'position:fixed', 'right:150px', 'bottom:24px', 'z-index:2147483000',
    'width:340px', 'padding:12px 14px', 'border-radius:12px',
    'background:rgba(24,28,38,.96)', 'color:#e8ebf2', 'font-size:12px',
    'box-shadow:0 10px 30px rgba(0,0,0,.35)', 'display:none', 'user-select:none',
  ].join(';')

  const header = document.createElement('div')
  header.textContent = '📊 用量仪表板'
  header.style.cssText = 'font-weight:600;margin-bottom:8px;cursor:move'
  const meta = document.createElement('div')
  meta.style.cssText = 'color:#9aa4b8;margin-bottom:6px'
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.style.cssText = 'width:100%;height:120px;display:block;background:rgba(255,255,255,.04);border-radius:6px'
  const tooltip = document.createElement('div')
  tooltip.style.cssText = 'margin-top:6px;color:#c8d2e4;min-height:16px'
  const footer = document.createElement('div')
  footer.style.cssText = 'margin-top:8px;display:flex;gap:6px'
  const btnHours = document.createElement('button')
  btnHours.textContent = '按小时'
  const btnDays = document.createElement('button')
  btnDays.textContent = '按天'
  for (const btn of [btnHours, btnDays]) {
    btn.style.cssText = 'flex:1;padding:4px 0;border:0;border-radius:6px;background:rgba(255,255,255,.08);color:#e8ebf2;cursor:pointer;font-size:12px'
  }
  footer.appendChild(btnHours)
  footer.appendChild(btnDays)
  panel.appendChild(header)
  panel.appendChild(meta)
  panel.appendChild(svg)
  panel.appendChild(tooltip)
  panel.appendChild(footer)
  host.appendChild(panel)

  let mode = 'hours'
  let snapshot = null
  let visible = false
  let refreshTimer = null

  // 位置恢复/保存（localStorage；坏数据回退默认）。保存值只在落盘当时的窗口尺寸内
  // 合法，恢复时可能整体越出当前视口（缩小窗口/换显示器），显示时经 clampPos 钳回。
  try {
    const saved = JSON.parse(localStorage.getItem(DASHBOARD_POS_KEY) ?? 'null')
    if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
      panel.style.left = `${saved.left}px`
      panel.style.top = `${saved.top}px`
      panel.style.right = 'auto'
      panel.style.bottom = 'auto'
    }
  } catch { /* 坏数据回退默认位置 */ }
  // 把面板位置钳回当前视口（拖拽 pointermove 同款公式）。display:none 时
  // offsetWidth/offsetHeight 量不到（为 0），只可在 display:block 之后调用。
  const clampPos = () => {
    const left = parseFloat(panel.style.left)
    const top = parseFloat(panel.style.top)
    if (Number.isNaN(left) || Number.isNaN(top)) return // 默认 right/bottom 定位，不涉钳制
    panel.style.left = `${Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, left))}px`
    panel.style.top = `${Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, top))}px`
    panel.style.right = 'auto'
    panel.style.bottom = 'auto'
  }
  const savePos = () => {
    try {
      localStorage.setItem(DASHBOARD_POS_KEY, JSON.stringify({
        left: parseFloat(panel.style.left) || panel.offsetLeft,
        top: parseFloat(panel.style.top) || panel.offsetTop,
      }))
    } catch { /* localStorage 缺席（隐私模式）静默 */ }
  }

  const render = () => {
    if (snapshot === null) return
    const buckets = mode === 'days' ? snapshot.days : snapshot.hours
    const bars = barLayout(buckets, mode)
    meta.textContent = axisLabel(buckets, mode)
      + ` · 今日 ${fmtTokens(snapshot.totals?.today?.tokens?.total ?? 0)} tokens · ${money(snapshot.totals?.today?.costHitCny + snapshot.totals?.today?.costMissCny + snapshot.totals?.today?.costOutCny ?? 0)}`
    while (svg.firstChild !== null) svg.removeChild(svg.firstChild)
    for (const bar of bars) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', String(bar.x))
      rect.setAttribute('y', String(VIEW_H - bar.h))
      rect.setAttribute('width', String(bar.w))
      rect.setAttribute('height', String(bar.h))
      rect.setAttribute('fill', 'rgba(86,134,254,.75)')
      rect.setAttribute('rx', '0.6')
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
      title.textContent = bar.tip
      rect.appendChild(title)
      rect.addEventListener('mouseenter', () => { tooltip.textContent = bar.tip })
      svg.appendChild(rect)
    }
    if (bars.length === 0) {
      tooltip.textContent = '暂无用量数据（跑一轮会话后出现柱状图）'
    }
  }

  const refresh = async () => {
    try {
      const res = await fetch('/api/whale-pet/usage', { cache: 'no-store' })
      if (res.ok) {
        snapshot = await res.json()
        render()
      }
    } catch { /* 路由暂不可达：保留上次快照 */ }
  }

  // 面板拖拽（header 按住拖动；位置存 localStorage）。
  const drag = { id: null, offX: 0, offY: 0 }
  header.addEventListener('pointerdown', (event) => {
    drag.id = event.pointerId
    const rect = panel.getBoundingClientRect()
    drag.offX = event.clientX - rect.left
    drag.offY = event.clientY - rect.top
    try { header.setPointerCapture(event.pointerId) } catch {}
  })
  header.addEventListener('pointermove', (event) => {
    if (event.pointerId !== drag.id) return
    const left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, event.clientX - drag.offX))
    const top = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, event.clientY - drag.offY))
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
    panel.style.right = 'auto'
    panel.style.bottom = 'auto'
  })
  header.addEventListener('pointerup', (event) => {
    if (event.pointerId !== drag.id) return
    drag.id = null
    savePos()
  })
  // 窗口尺寸变化（缩窗口/换显示器）时重钳一次，面板已显示才需要。
  const onResize = () => { if (visible) clampPos() }
  window.addEventListener('resize', onResize)

  btnHours.addEventListener('click', () => { mode = 'hours'; render() })
  btnDays.addEventListener('click', () => { mode = 'days'; render() })

  return {
    toggle() {
      visible = !visible
      panel.style.display = visible ? 'block' : 'none'
      if (visible) {
        // 挂载时面板 display:none 量不到尺寸，故钳制放在显示时：越界的
        // localStorage 旧值（保存于更大窗口）此处自动拉回当前视口内。
        clampPos()
        refresh()
        if (refreshTimer === null) refreshTimer = setInterval(refresh, 30000)
      } else if (refreshTimer !== null) {
        clearInterval(refreshTimer)
        refreshTimer = null
      }
    },
    refresh,
    dispose() {
      if (refreshTimer !== null) clearInterval(refreshTimer)
      refreshTimer = null
      window.removeEventListener('resize', onResize)
      panel.remove()
    },
  }
}
