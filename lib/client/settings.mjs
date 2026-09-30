// 设置收口（M5-6）：主动行为全量配置项的默认值、校验（.check 语义：坏数据逐字段纠正
// 回默认/钳制范围，不抛错）与设置卡 UI。Node half 读写 ~/.dsh/whale-pet/settings.json
// 时也用 normalizeSettings——两端共用同一份校验，杜绝脏配置进入运行时。
import { NIGHT_MUTE_START_MIN, NIGHT_MUTE_END_MIN } from './care.mjs'

/** 间隔钳制范围（分钟）：过短=打扰，过长=失效。 */
export const LIMITS = Object.freeze({
  sedentaryMin: [10, 180],
  waterMin: [10, 180],
  skitMinMin: [15, 480], // 短剧最小间隔
  skitMaxMin: [15, 480], // 短剧最大间隔
  muteStartMin: [0, 23 * 60 + 59],
  muteEndMin: [0, 23 * 60 + 59],
})

/**
 * 默认配置：主动行为低频默认开（详案「它来找你——但一切可关」），
 * 番茄钟/完成音效默认关（强主动/带声音项）。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  care: {
    sedentaryEnabled: true,
    sedentaryMin: 45,
    waterEnabled: true,
    waterMin: 60,
    pomodoroEnabled: false,
  },
  skit: {
    enabled: true,
    minMinutes: 40,
    maxMinutes: 80,
  },
  night: {
    muteEnabled: true,
    startMin: NIGHT_MUTE_START_MIN, // 23:00
    endMin: NIGHT_MUTE_END_MIN, // 07:00
  },
  walkEnabled: true,
  fusion: {
    enabled: true, // M6-4 telemetry 融合总开关（实测费用/洞察台词/遇挫表情）
  },
  sound: {
    enabled: false, // M5-5 红线：完成音效默认关闭
    file: '', // 空 = 用系统内置 tada.wav
  },
})

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value))

/** 布尔纠正：仅 true/非零数字/'true' 视为真，其余 false。 */
function asBool(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value === 'true' || value === '1'
  return fallback
}

/** 数值纠正：非法回默认，合法钳制范围。 */
function asNum(value, fallback, range) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN)
  if (!Number.isFinite(n)) return fallback
  return range ? clamp(Math.round(n), range[0], range[1]) : n
}

/** 字符串纠正：非字符串回默认。 */
function asStr(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

/**
 * 设置校验/归一化（.check 语义）：任何输入（含坏数据/旧版本缺字段）都返回合法全量配置；
 * 未知字段忽略；逐字段纠正而非整体回退（用户其他配置尽量保留）。
 * @param {unknown} raw 待校验对象（可为 null/undefined/任意脏数据）
 * @param {object} [base] 归一基准（默认 DEFAULT_SETTINGS；测试注入）
 * @returns {object} 深拷贝的合法配置
 */
export function normalizeSettings(raw, base = DEFAULT_SETTINGS) {
  const out = JSON.parse(JSON.stringify(base))
  if (raw === null || raw === undefined || typeof raw !== 'object') return out
  const care = typeof raw.care === 'object' && raw.care !== null ? raw.care : {}
  out.care.sedentaryEnabled = asBool(care.sedentaryEnabled, out.care.sedentaryEnabled)
  out.care.sedentaryMin = asNum(care.sedentaryMin, out.care.sedentaryMin, LIMITS.sedentaryMin)
  out.care.waterEnabled = asBool(care.waterEnabled, out.care.waterEnabled)
  out.care.waterMin = asNum(care.waterMin, out.care.waterMin, LIMITS.waterMin)
  out.care.pomodoroEnabled = asBool(care.pomodoroEnabled, out.care.pomodoroEnabled)
  const skit = typeof raw.skit === 'object' && raw.skit !== null ? raw.skit : {}
  out.skit.enabled = asBool(skit.enabled, out.skit.enabled)
  out.skit.minMinutes = asNum(skit.minMinutes, out.skit.minMinutes, LIMITS.skitMinMin)
  out.skit.maxMinutes = asNum(skit.maxMinutes, out.skit.maxMinutes, LIMITS.skitMaxMin)
  if (out.skit.minMinutes > out.skit.maxMinutes) {
    // 区间颠倒：交换而非重置（尽量保留用户意图）
    const t = out.skit.minMinutes
    out.skit.minMinutes = out.skit.maxMinutes
    out.skit.maxMinutes = t
  }
  const night = typeof raw.night === 'object' && raw.night !== null ? raw.night : {}
  out.night.muteEnabled = asBool(night.muteEnabled, out.night.muteEnabled)
  out.night.startMin = asNum(night.startMin, out.night.startMin, LIMITS.muteStartMin)
  out.night.endMin = asNum(night.endMin, out.night.endMin, LIMITS.muteEndMin)
  out.walkEnabled = asBool(raw.walkEnabled, out.walkEnabled)
  const fusion = typeof raw.fusion === 'object' && raw.fusion !== null ? raw.fusion : {}
  out.fusion.enabled = asBool(fusion.enabled, out.fusion.enabled)
  const sound = typeof raw.sound === 'object' && raw.sound !== null ? raw.sound : {}
  out.sound.enabled = asBool(sound.enabled, out.sound.enabled)
  out.sound.file = asStr(sound.file, out.sound.file)
  return out
}

// ---- 设置卡 UI（M4-4 卡片自 main.mjs 迁入 + M5 开关收口；React 由平台提供）----
const SETTINGS_PATH = '/api/whale-pet/settings'

/**
 * 创建设置卡组件（含等级/账本展示 + 主动行为开关）。
 * @param {object} React 平台提供的 react
 * @param {{ onSettingsChange?: (settings: object) => void }} [hooks] 设置热应用回调
 */
export function createSettingsCard(React, hooks = {}) {
  const h = React.createElement
  const { useState, useEffect, useRef } = React
  return function SettingsCard() {
    const [pet, setPet] = useState(null)
    const [settings, setSettings] = useState(null)
    const [savedAt, setSavedAt] = useState(0)
    const saveTimer = useRef(null)

    useEffect(() => {
      let alive = true
      const loadState = async () => {
        try {
          const res = await fetch('/api/whale-pet/state', { cache: 'no-store' })
          if (res.ok && alive) setPet((await res.json()).pet ?? null)
        } catch { /* 路由暂不可达：保留上次快照 */ }
      }
      const loadSettings = async () => {
        try {
          const res = await fetch(SETTINGS_PATH, { cache: 'no-store' })
          if (res.ok && alive) setSettings(await res.json())
        } catch { /* 失败保持 null（UI 显示加载中） */ }
      }
      loadState()
      loadSettings()
      const timer = setInterval(loadState, 10000)
      return () => { alive = false; clearInterval(timer) }
    }, [])

    // 开关变更：乐观更新 + 600ms 防抖 POST（全量配置）；成功后热应用。
    const patch = (mutate) => {
      setSettings((prev) => {
        const next = mutate(JSON.parse(JSON.stringify(prev ?? DEFAULT_SETTINGS)))
        if (saveTimer.current !== null) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
          fetch(SETTINGS_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
          }).then((res) => {
            if (res.ok) {
              setSavedAt(Date.now())
              hooks.onSettingsChange?.(next)
            }
          }).catch(() => { /* 失败静默：下次修改会重试 */ })
        }, 600)
        return next
      })
    }

    const setVal = (sectionKey, key, value) => patch((s) => {
      if (sectionKey === null) s[key] = value
      else s[sectionKey][key] = value
    })

    const toggle = (sectionKey, key, label) => h('label', { key, style: TOGGLE_ROW },
      h('input', {
        type: 'checkbox',
        checked: sectionKey === null ? !!settings[key] : !!settings[sectionKey]?.[key],
        onChange: (e) => setVal(sectionKey, key, e.target.checked),
      }), label)

    const numInput = (sectionKey, key, label, min, max, suffix) => h('label', { key, style: NUM_ROW },
      label,
      h('input', {
        type: 'number', min, max, value: (sectionKey === null ? settings[key] : settings[sectionKey]?.[key]) ?? '',
        onChange: (e) => setVal(sectionKey, key, Number(e.target.value)),
        style: NUM_STYLE,
      }), suffix)

    if (settings === null) {
      return h('div', { style: CARD_STYLE }, h('div', { style: TITLE_STYLE }, '鲸鱼娘桌宠'),
        h('div', { style: MUTED_STYLE }, '设置加载中…'))
    }

    const stats = pet?.stats ?? {}
    const titles = Array.isArray(pet?.titles) ? pet.titles : []
    const xpForLevel = (lv) => (50 * lv * (lv - 1)) / 2
    const level = pet?.level ?? 1
    const cur = xpForLevel(level)
    const next = xpForLevel(level + 1)
    const pct = Math.min(100, Math.round(((pet?.xp ?? 0) - cur) / Math.max(1, next - cur) * 100))

    return h('div', { style: CARD_STYLE },
      h('div', { style: TITLE_STYLE }, '鲸鱼娘桌宠'),
      h('div', { style: { ...MUTED_STYLE, marginBottom: '8px' } },
        '状态镜像/交互陪伴/用量仪表板/养成/主动陪伴'),
      h('div', { style: { marginBottom: '6px' } },
        h('span', { style: { fontWeight: 600 } }, `Lv.${level}`),
        h('span', { style: { color: '#8a93a6', marginLeft: '8px' } }, `XP ${pet?.xp ?? 0}（${pct}% → Lv.${level + 1}）`),
      ),
      h('div', { style: { background: 'rgba(86,134,254,.14)', borderRadius: '4px', height: '6px', marginBottom: '8px' } },
        h('div', { style: { width: `${pct}%`, height: '6px', borderRadius: '4px', background: 'rgba(86,134,254,.75)' } })),
      h('div', { style: { color: '#8a93a6', marginBottom: '6px' } },
        `任务 ${stats.tasksDone ?? 0} · 失败 ${stats.failures ?? 0} · 会话 ${stats.sessions ?? 0} · 陪伴 ${Math.round((stats.activeMs ?? 0) / 60000)}分钟`),
      h('div', { style: { marginBottom: '8px' } },
        titles.length > 0
          ? h('span', {}, '称号：', titles.join('、'))
          : h('span', { style: { color: '#8a93a6' } }, '称号：尚未解锁（完成任务/会话即可获得）')),
      h('button', {
        type: 'button',
        onClick: () => { window.dispatchEvent(new CustomEvent('whale-pet:dashboard-toggle')) },
        style: BUTTON_STYLE,
      }, '📊 用量仪表板'),
      // ---- M5 主动行为收口 ----
      h('div', { style: SECTION_STYLE }, '主动陪伴'),
      toggle('care', 'sedentaryEnabled', '久坐提醒'),
      numInput('care', 'sedentaryMin', '　间隔', LIMITS.sedentaryMin[0], LIMITS.sedentaryMin[1], '分钟'),
      toggle('care', 'waterEnabled', '喝水提醒'),
      numInput('care', 'waterMin', '　间隔', LIMITS.waterMin[0], LIMITS.waterMin[1], '分钟'),
      toggle('care', 'pomodoroEnabled', '番茄钟（25 分钟专注 + 5 分钟休息）'),
      h('div', { style: SECTION_STYLE }, '随机短剧'),
      toggle('skit', 'enabled', '情景短剧气泡'),
      numInput('skit', 'minMinutes', '　间隔下限', LIMITS.skitMinMin[0], LIMITS.skitMinMin[1], '分钟'),
      numInput('skit', 'maxMinutes', '　间隔上限', LIMITS.skitMaxMin[0], LIMITS.skitMaxMin[1], '分钟'),
      h('div', { style: SECTION_STYLE }, '深夜与散步'),
      toggle('night', 'muteEnabled', `深夜静音（${Math.floor(settings.night.startMin / 60)}:00–${Math.floor(settings.night.endMin / 60)}:00 无主动行为）`),
      toggle(null, 'walkEnabled', '周期散步'),
      h('div', { style: SECTION_STYLE }, '任务完成音效'),
      toggle('sound', 'enabled', '完成时播放系统提示音'),
      h('div', { style: SECTION_STYLE }, '数据融合（dsh-local-telemetry）'),
      toggle('fusion', 'enabled', '实测费用 / 洞察台词 / 遇挫表情'),
      savedAt > 0
        ? h('div', { style: { ...MUTED_STYLE, marginTop: '6px' } }, `已保存 ✓ ${new Date(savedAt).toLocaleTimeString()}`)
        : null,
    )
  }
}

const CARD_STYLE = { padding: '8px 0', fontSize: '13px' }
const TITLE_STYLE = { fontWeight: 600, marginBottom: '4px' }
const MUTED_STYLE = { color: 'var(--dsw-alias-label-tertiary, #8a93a6)' }
const BUTTON_STYLE = { padding: '4px 12px', border: '0', borderRadius: '6px',
  background: 'rgba(86,134,254,.16)', color: '#b7c8fe', cursor: 'pointer', fontSize: '12px' }
const SECTION_STYLE = { fontWeight: 600, margin: '10px 0 4px', borderTop: '1px solid rgba(128,140,160,.25)', paddingTop: '8px' }
const TOGGLE_ROW = { display: 'flex', alignItems: 'center', gap: '6px', margin: '3px 0', cursor: 'pointer' }
const NUM_ROW = { display: 'inline-flex', alignItems: 'center', gap: '4px', margin: '2px 12px 2px 22px', color: '#8a93a6' }
const NUM_STYLE = { width: '52px', padding: '1px 4px', border: '1px solid rgba(128,140,160,.4)',
  borderRadius: '4px', background: 'transparent', color: 'inherit' }
