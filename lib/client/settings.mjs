// 设置收口（M5-6）：主动行为全量配置项的默认值、校验（.check 语义：坏数据逐字段纠正
// 回默认/钳制范围，不抛错）与设置卡 UI。Node half 读写 ~/.dsh/whale-pet/settings.json
// 时也用 normalizeSettings——两端共用同一份校验，杜绝脏配置进入运行时。
import { NIGHT_MUTE_START_MIN, NIGHT_MUTE_END_MIN } from './care.mjs'
import { normalizeCharacterId } from './characters.mjs'
import { ACHIEVEMENTS, QUEST_POOL, affinityLevel } from './growth.mjs'

/** 间隔钳制范围（分钟）：过短=打扰，过长=失效。 */
export const LIMITS = Object.freeze({
  sedentaryMin: [10, 180],
  waterMin: [10, 180],
  skitMinMin: [15, 480], // 短剧最小间隔
  skitMaxMin: [15, 480], // 短剧最大间隔
  muteStartMin: [0, 23 * 60 + 59],
  muteEndMin: [0, 23 * 60 + 59],
  balanceThresholdCNY: [1, 100], // 二期余额提醒阈值（CNY，phase2-plan §9）
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
  // ---- 二期新增分区（phase2-plan §9）----
  game: {
    enabled: true, // 用户主动游玩项，默认开（非主动推送，不受深夜红线约束）
  },
  festival: {
    enabled: true, // 纯视觉面（节日换装），默认开
  },
  weather: {
    enabled: true, // 纯视觉面（天气换装）
    city: '', // 空 = 不查询不换装（dormant；client 拉取与 Node 代理都休眠）
  },
  balanceLow: {
    enabled: false, // 红线（phase2-plan §9）：隐私/强主动项默认关；深夜段连轮询都暂停
    thresholdCNY: 5,
    apiKey: '', // 明文仅存服务端 settings.json；GET/POST 响应恒经 redactSettings 脱敏
  },
  memeCdn: {
    enabled: true, // 详案 §2.4 明示的 client 直链（Supabase 公开桶）例外；失败回退本地池
  },
  character: 'musume', // 顶层标量；非 'classic'（含脏数据）一律纠正回 'musume'
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
  // ---- 二期新增分区（phase2-plan §9：逐字段纠正 + LIMITS 钳制，两端共用同一校验）----
  const game = typeof raw.game === 'object' && raw.game !== null ? raw.game : {}
  out.game.enabled = asBool(game.enabled, out.game.enabled)
  const festival = typeof raw.festival === 'object' && raw.festival !== null ? raw.festival : {}
  out.festival.enabled = asBool(festival.enabled, out.festival.enabled)
  const weather = typeof raw.weather === 'object' && raw.weather !== null ? raw.weather : {}
  out.weather.enabled = asBool(weather.enabled, out.weather.enabled)
  out.weather.city = asStr(weather.city, out.weather.city)
  const balanceLow = typeof raw.balanceLow === 'object' && raw.balanceLow !== null ? raw.balanceLow : {}
  out.balanceLow.enabled = asBool(balanceLow.enabled, out.balanceLow.enabled)
  out.balanceLow.thresholdCNY = asNum(balanceLow.thresholdCNY, out.balanceLow.thresholdCNY, LIMITS.balanceThresholdCNY)
  out.balanceLow.apiKey = asStr(balanceLow.apiKey, out.balanceLow.apiKey)
  const memeCdn = typeof raw.memeCdn === 'object' && raw.memeCdn !== null ? raw.memeCdn : {}
  out.memeCdn.enabled = asBool(memeCdn.enabled, out.memeCdn.enabled)
  out.character = normalizeCharacterId(raw.character) // 未知值/脏数据一律回 'musume'
  return out
}

/**
 * apiKey 三态合并（phase2-plan §10-3，r2）：POST body 的 balanceLow.apiKey → 落盘值。
 * - null → ''（显式清除，设置卡「清除」按钮发 null）；
 * - ''/undefined（及纯空白串、非字符串垃圾）→ 保留现值 currentKey——设置卡每次改任意开关
 *   都全量 POST（600ms 防抖），其持有的脱敏值 '' 依此语义不会清空已存 key；
 * - 非空字符串 → 覆盖（trim）。
 * 纯函数：路由层调用后把结果填回 body 再走 normalizeSettings + saveSettings（lib/index.mjs）。
 * @param {unknown} currentKey 服务端已存 key（settings.balanceLow.apiKey）
 * @param {unknown} incoming 本次 POST 传入的 key（原样，未 trim）
 * @returns {string} 落盘 key
 */
export function resolveIncomingApiKey(currentKey, incoming) {
  const current = typeof currentKey === 'string' ? currentKey : ''
  if (incoming === null) return '' // 三态②：显式清除
  if (typeof incoming !== 'string') return current // undefined/数字/布尔/对象 → 视为未提供，保留
  const trimmed = incoming.trim()
  if (trimmed === '') return current // 三态①：''/纯空白 = 保留现值（显式清除只能发 null）
  return trimmed // 三态③：非空字符串覆盖
}

/**
 * 设置脱敏出口（phase2-plan §10-3，r2）：GET 响应与 POST 响应共用同一规则——
 * balanceLow.apiKey 恒回 ''（明文 key 不出宿主、不进任何日志），仅附 apiKeySet: true|false
 * 供设置卡 placeholder 显示「已配置」。返回深拷贝，不改动服务端持有的 settings 本体。
 * apiKeySet 为归一化 schema 外的展示字段：normalizeSettings 未知字段忽略，设置卡把脱敏输出
 * 全量 POST 回灌安全无副作用（apiKey '' 按三态语义 = 保留现值）。
 * @param {object} [settings] 服务端归一化配置（缺省按 DEFAULT_SETTINGS）
 * @returns {object} 深拷贝的脱敏配置
 */
export function redactSettings(settings) {
  const out = JSON.parse(JSON.stringify(settings ?? DEFAULT_SETTINGS))
  const bl = out.balanceLow !== null && typeof out.balanceLow === 'object' ? out.balanceLow : {}
  const apiKey = typeof bl.apiKey === 'string' ? bl.apiKey : ''
  out.balanceLow = { ...bl, apiKey: '', apiKeySet: apiKey !== '' }
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
    // 二期 apiKey 输入（phase2-plan §9）：密码框写入后不回显——输入内容走本地草稿，
    // POST 成功即清空；「已配置」占位来自 GET 脱敏出口的 apiKeySet（本地保存成功后即时更新）。
    const [apiKeyDraft, setApiKeyDraft] = useState('')
    const [keyConfigured, setKeyConfigured] = useState(null) // null=未知（回退 GET 的 apiKeySet）
    // 二期「成长」区（phase2-plan §11-2）：hooks.growth 注入（main.mjs 包好的
    // { snapshot, signin, claimQuest }，签到/领奖气泡在宿主侧弹）；未注入（纯 Node 测试/旧宿主）整区不渲染。
    const [growthSnap, setGrowthSnap] = useState(null)
    useEffect(() => {
      if (!hooks.growth || typeof hooks.growth.snapshot !== 'function') return undefined
      let alive = true
      const load = () => {
        try { const s = hooks.growth.snapshot(); if (alive) setGrowthSnap(s) } catch { /* 快照失败保持上次 */ }
      }
      load()
      const timer = setInterval(load, 15000) // 轻量自刷（任务跨日自愈/好感变化）
      return () => { alive = false; clearInterval(timer) }
    }, [])

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
    // after(next)：POST 成功后的附加回调（apiKey 写入/清除时同步草稿与「已配置」状态）。
    const patch = (mutate, after) => {
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
              // 热应用走脱敏出口：明文 key 不进 client 运行时（client 侧永远用不到 key——
              // DeepSeek 代理只在 Node half，phase2-plan §10-2/§10-3）。
              hooks.onSettingsChange?.(redactSettings(next))
              after?.(next)
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

    /** apiKey 专用：value=非空字符串覆盖 / ''保留现值（三态①）/ null 显式清除（三态②）。 */
    const setApiKey = (value) => patch((s) => {
      if (s.balanceLow === null || typeof s.balanceLow !== 'object') s.balanceLow = {}
      s.balanceLow.apiKey = value
      return s
    }, (next) => {
      setApiKeyDraft('') // 写入后不回显（§9）
      const k = next?.balanceLow?.apiKey
      if (typeof k === 'string' && k !== '') setKeyConfigured(true)
      else if (k === null) setKeyConfigured(false)
    })

    const toggle = (sectionKey, key, label) => h('label', { key: `${sectionKey ?? 'root'}:${key}`, style: TOGGLE_ROW },
      h('input', {
        type: 'checkbox',
        checked: sectionKey === null ? !!settings[key] : !!settings[sectionKey]?.[key],
        onChange: (e) => setVal(sectionKey, key, e.target.checked),
      }), label)

    const numInput = (sectionKey, key, label, min, max, suffix) => h('label', { key: `${sectionKey ?? 'root'}:${key}`, style: NUM_ROW },
      label,
      h('input', {
        type: 'number', min, max, value: (sectionKey === null ? settings[key] : settings[sectionKey]?.[key]) ?? '',
        onChange: (e) => setVal(sectionKey, key, Number(e.target.value)),
        style: NUM_STYLE,
      }), suffix)

    const textInput = (sectionKey, key, label, placeholder) => h('label', { key: `${sectionKey ?? 'root'}:${key}`, style: NUM_ROW },
      label,
      h('input', {
        type: 'text', placeholder,
        value: (sectionKey === null ? settings[key] : settings[sectionKey]?.[key]) ?? '',
        onChange: (e) => setVal(sectionKey, key, e.target.value),
        style: { ...NUM_STYLE, width: '96px' },
      }))

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
      h('button', {
        type: 'button',
        onClick: () => { window.dispatchEvent(new CustomEvent('whale-pet:game-toggle')) },
        style: { ...BUTTON_STYLE, marginLeft: '6px' },
      }, '🎮 泡泡小游戏'),
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
      // ---- 二期新分区（phase2-plan §9/§11 步骤 1：六分区设置卡）----
      h('div', { style: SECTION_STYLE }, '泡泡小游戏'),
      toggle('game', 'enabled', '启用泡泡小游戏'),
      h('div', { style: SECTION_STYLE }, '换装'),
      toggle('festival', 'enabled', '节日换装（春节 / 中秋 / 万圣 / 圣诞）'),
      toggle('weather', 'enabled', '天气换装'),
      textInput('weather', 'city', '　城市', '如：上海（空 = 不查询）'),
      h('div', { style: SECTION_STYLE }, '余额提醒（DeepSeek）'),
      toggle('balanceLow', 'enabled', '余额不足提醒（默认关）'),
      numInput('balanceLow', 'thresholdCNY', '　阈值', LIMITS.balanceThresholdCNY[0], LIMITS.balanceThresholdCNY[1], 'CNY'),
      h('label', { key: 'balanceLow:apiKey', style: NUM_ROW }, 'API Key',
        h('input', {
          type: 'password',
          value: apiKeyDraft, // 恒绑草稿：已存 key 不回显（§9）
          placeholder: (keyConfigured ?? !!settings.balanceLow?.apiKeySet) ? '已配置（输入可覆盖）' : '未配置',
          autoComplete: 'new-password',
          onChange: (e) => { const v = e.target.value; setApiKeyDraft(v); setApiKey(v) },
          style: { ...NUM_STYLE, width: '120px' },
        }),
        h('button', {
          type: 'button',
          style: BUTTON_STYLE,
          onClick: () => { setApiKeyDraft(''); setKeyConfigured(false); setApiKey(null) }, // 显式清除 = 三态 null
        }, '清除')),
      h('div', { style: SECTION_STYLE }, '表情包'),
      toggle('memeCdn', 'enabled', '表情包热链（CDN，失败回退本地）'),
      h('div', { style: SECTION_STYLE }, '角色'),
      h('label', { key: 'root:character', style: NUM_ROW }, '形象',
        h('select', {
          value: settings.character ?? 'musume',
          onChange: (e) => setVal(null, 'character', e.target.value),
          style: { ...NUM_STYLE, width: '150px' },
        },
          h('option', { value: 'musume' }, '鲸鱼娘（musume）'),
          h('option', { value: 'classic' }, '经典小鱼干（classic）'))),
      // ---- 二期「成长」区（phase2-plan §4/§11-2）：好感/等级 + 签到 + 每日任务 3 槽 + 成就；
      // hooks.growth 缺席（一期宿主/纯测试）整区不渲染。签到/领取由宿主包一层（气泡反馈）。
      hooks.growth && growthSnap !== null
        ? h('div', { key: 'growth-section' },
          h('div', { style: SECTION_STYLE }, `成长（好感 ${growthSnap.affinity ?? 0} · Lv.${affinityLevel(growthSnap.affinity)} · 连签 ${growthSnap.signin?.streak ?? 0} 天 · 本周 ${growthSnap.weekSignin?.days?.length ?? 0}/7）`),
          h('button', {
            type: 'button',
            style: BUTTON_STYLE,
            onClick: () => {
              try {
                hooks.growth.signin?.()
                setGrowthSnap(hooks.growth.snapshot())
              } catch { /* 签到失败静默（下次点击重试） */ }
            },
          }, isTodayKey(growthSnap.signin?.lastDate) ? '今日已签到 ✓' : '签到'),
          h('div', { style: { ...MUTED_STYLE, margin: '4px 0 2px' } }, '每日任务'),
          ...(Array.isArray(growthSnap.quests?.slots) ? growthSnap.quests.slots.map((slot) => {
            const def = QUEST_POOL.find((q) => q.id === slot.id)
            // target 只在 QUEST_POOL 定义上（槽对象仅 {id,progress,claimed}，slot.target 恒 undefined）
            const claimable = slot.progress >= (def?.target ?? 0) && slot.claimed !== true
            return h('div', { key: `quest:${slot.id}`, style: QUEST_ROW_STYLE },
              h('span', { style: { flex: '1' } },
                `${def?.desc ?? slot.id}　${Math.min(slot.progress ?? 0, def?.target ?? 0)}/${def?.target ?? 0}${def?.reward ? `（+${def.reward.affinity} 好感）` : ''}`),
              h('button', {
                type: 'button',
                style: { ...BUTTON_STYLE, opacity: claimable ? '1' : '.45', cursor: claimable ? 'pointer' : 'default' },
                onClick: () => {
                  if (!claimable) return
                  try {
                    hooks.growth.claimQuest?.(slot.id)
                    setGrowthSnap(hooks.growth.snapshot())
                  } catch { /* 领取失败静默 */ }
                },
              }, slot.claimed === true ? '已领 ✓' : '领取'))
          }) : null),
          h('div', { style: { ...MUTED_STYLE, margin: '4px 0 2px' } },
            `成就 ${ACHIEVEMENTS.filter((a) => Array.isArray(growthSnap.achievements) && growthSnap.achievements.includes(a.id)).length}/${ACHIEVEMENTS.length}`),
          h('div', { style: MUTED_STYLE },
            ACHIEVEMENTS.filter((a) => Array.isArray(growthSnap.achievements) && growthSnap.achievements.includes(a.id))
              .map((a) => `${a.icon ?? ''}${a.name}`).join('、') || '尚未解锁成就（互动/签到/游戏即可获得）'),
        )
        : null,
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
const QUEST_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '6px', margin: '2px 12px 2px 22px', color: 'inherit', fontSize: '12px' }

/**
 * 成长 blob 的日期键是否为今天（growth.mjs dayKey 同格式：本地 'YYYY-M-D' 无前导零；
 * 签到按钮「今日已签到」态的判定基准）。
 * @param {unknown} key growth blob signin.lastDate
 */
function isTodayKey(key) {
  if (typeof key !== 'string' || key === '') return false
  const d = new Date()
  return key === `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
