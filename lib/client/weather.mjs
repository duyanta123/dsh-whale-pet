// 天气换装（二期 #4，id=weather）：Open-Meteo 无密钥方案的纯函数半边。
// ① geocoding / forecast 请求 URL 组装（无密钥参数面，geocoding language=zh 支持中文城市）；
// ② WMO weathercode → 素材状态 id 映射（对应 assets/musume/dsh-whale-state-weather-*.webp）。
// 零 IO（零 DOM/零 fetch/零定时器）：client 不外联（红线）——Node half 代理
// （GET /api/whale-pet/weather，fetch/超时/dispose 一律在宿主侧）与 client 30min 轮询
// 定时器由集成工程师接线（phase2-plan §2.4/§10/§11），本模块只产出 URL 字符串与 id。
// 映射表出处：Open-Meteo WMO weather code，以 musume WEATHER_MAP（whale-moe-core.js:1682-1715）
// 为基础，按本插件素材库把雨档细分为 rain（小雨淋雨开心）/umbrella（持续雨与冻雨打伞）两档
// （phase2-plan §6；umbrella 为契约 5-id 集合的有理由补充，§12-②，素材 weather-umbrella.webp 已在库核实）。

const GEOCODING_BASE = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_BASE = 'https://api.open-meteo.com/v1/forecast'

/** client 拉取 /api/whale-pet/weather 的节拍常量：30 分钟（宿主路由内存缓存同拍，phase2-plan §10-1）。 */
export const WEATHER_POLL_MS = 30 * 60_000

/**
 * 组装 Open-Meteo geocoding 请求 URL（无密钥，language=zh 支持中文城市，取 count=1 首条）。
 * @param {string} city 城市名（首尾空白剔除；空/非字符串抛 TypeError——设置 weather.city
 *   为空时应保持休眠不查询，调用前由宿主路由校验）
 * @returns {string}
 */
export function buildGeocodingUrl(city) {
  if (typeof city !== 'string' || city.trim() === '') {
    throw new TypeError('weather: city 必须为非空字符串（weather.city 为空时应休眠不查询）')
  }
  return (
    GEOCODING_BASE +
    '?name=' + encodeURIComponent(city.trim()) +
    '&count=1&language=zh&format=json'
  )
}

/**
 * 坐标参数收敛：number 或非空数字字符串 → 有限数值；其余一律无效。
 * 显式拒绝 null/undefined/''/布尔——Number(null)===0、Number('')===0 的隐式收敛坑
 * 会把缺失坐标静默变成纬度/经度 0（赤道几内亚湾，真实地点），必须排除。
 */
function toCoord(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * 组装 Open-Meteo forecast 请求 URL：仅取 current=weather_code,temperature_2m，时区随定位自动。
 * @param {number|string} lat 纬度（geocoding 首条结果 latitude；非法输入抛 TypeError）
 * @param {number|string} lon 经度（同上 longitude）
 * @returns {string}
 */
export function buildForecastUrl(lat, lon) {
  const la = toCoord(lat)
  const lo = toCoord(lon)
  if (la === null || lo === null) {
    throw new TypeError('weather: lat/lon 必须为有限数值（geocoding 首条结果）')
  }
  return (
    FORECAST_BASE +
    '?latitude=' + encodeURIComponent(String(la)) +
    '&longitude=' + encodeURIComponent(String(lo)) +
    '&current=weather_code,temperature_2m&timezone=auto'
  )
}

/**
 * WMO weathercode（字符串键）→ 素材状态 id 冻结映射（phase2-plan §6 全表，28 码）。
 * 表外码（Open-Meteo 不发）不入表，resolveWeatherId 统一回 clear。
 */
export const WEATHER_CODE_MAP = Object.freeze({
  // 晴 / 大致晴 / 多云间晴 / 阴 → 不换装
  '0': 'clear',
  '1': 'clear',
  '2': 'clear',
  '3': 'clear',
  // 雾 / 雾凇：无素材语义，不做牵强映射（裁量点 phase2-plan §12）→ 不换装
  '45': 'clear',
  '48': 'clear',
  // 毛毛雨 / 小雨：小雨欢快（rain-happy）
  '51': 'rain',
  '53': 'rain',
  '55': 'rain',
  // 冻毛毛雨 / 冻雨：打伞挡冻雨
  '56': 'umbrella',
  '57': 'umbrella',
  // 持续小 / 中 / 大雨：持续降雨打伞
  '61': 'umbrella',
  '63': 'umbrella',
  '65': 'umbrella',
  '66': 'umbrella',
  '67': 'umbrella',
  // 小 / 阵雨：淋雨开心
  '80': 'rain',
  '81': 'rain',
  // 强阵雨：打伞
  '82': 'umbrella',
  // 小 / 中 / 大雪、雪粒、阵 / 强阵雪
  '71': 'snow',
  '73': 'snow',
  '75': 'snow',
  '77': 'snow',
  '85': 'snow',
  '86': 'snow',
  // 雷雨 / 雷雨伴冰雹 / 强雷暴
  '95': 'thunder',
  '96': 'thunder',
  '99': 'thunder',
})

/**
 * weathercode + 气温 → 换装素材状态 id（纯函数，phase2-plan §2.4/§6）。
 * 优先级：thunder > snow > rain > umbrella > cold(tempC≤0) > clear——映射表为单码单值，
 * 等价实现为：命中非 clear 的映射直接生效（压过温度派生）；仅当未命中实质天气
 * （clear / 表外未知 / 缺码）且 tempC ≤ 0 时派生 cold（结冰/严寒，musume weatherFx
 * cold 派生思路 whale-moe-core.js:1806-1816 的轻量版）；其余 → clear（=不换装）。
 * @param {{ code?: number|string, tempC?: number }} input code=Open-Meteo weather_code
 *  （JSON 产 number，路由透传，字符串码等价接受）；tempC=气温 ℃，必须是有限数值
 *   （路由 JSON 解析产物），非数值/缺省视为不派生
 * @returns {'clear'|'rain'|'snow'|'thunder'|'umbrella'|'cold'}
 */
export function resolveWeatherId({ code, tempC } = {}) {
  const key = code === undefined || code === null ? '' : String(code)
  const mapped = Object.hasOwn(WEATHER_CODE_MAP, key) ? WEATHER_CODE_MAP[key] : 'clear'
  if (mapped !== 'clear') return mapped
  if (typeof tempC === 'number' && Number.isFinite(tempC) && tempC <= 0) return 'cold'
  return 'clear'
}
