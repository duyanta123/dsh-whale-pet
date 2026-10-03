// 天气换装（二期 #4，id=weather）单测：URL 组装（中文城市 encodeURIComponent、language=zh、
// 无密钥参数面）/ WEATHER_CODE_MAP 全码覆盖与未知码 / resolveWeatherId 优先级与 tempC 边界 /
// 30min 节拍常量 / 映射 id ↔ 素材文件对齐（phase2-plan §2.4/§6/§14）。
// 模块零 IO（纯函数，无时钟/随机源/fetch 依赖），全部用例确定性。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildGeocodingUrl, buildForecastUrl, WEATHER_CODE_MAP, resolveWeatherId, WEATHER_POLL_MS,
} from '../lib/client/weather.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- URL 组装（无密钥参数面）----
test('buildGeocodingUrl：中文城市 encodeURIComponent + language=zh + 固定参数面', () => {
  assert.equal(
    buildGeocodingUrl('上海'),
    'https://geocoding-api.open-meteo.com/v1/search?name=%E4%B8%8A%E6%B5%B7&count=1&language=zh&format=json',
  )
  assert.equal(
    buildGeocodingUrl('西安'),
    'https://geocoding-api.open-meteo.com/v1/search?name=%E8%A5%BF%E5%AE%89&count=1&language=zh&format=json',
  )
})

test('buildGeocodingUrl：参数面恰为 name/count/language/format，无任何密钥参数', () => {
  const url = buildGeocodingUrl('北京')
  assert.ok(url.startsWith('https://'), '必须 https')
  const u = new URL(url)
  assert.deepEqual([...u.searchParams.keys()].sort(), ['count', 'format', 'language', 'name'])
  assert.equal(u.searchParams.get('count'), '1')
  assert.equal(u.searchParams.get('language'), 'zh')
  assert.equal(u.searchParams.get('format'), 'json')
  assert.ok(!/api[_-]?key|token|secret|password/i.test(url), 'URL 不得携带密钥形参数')
})

test('buildGeocodingUrl：空格转义与特殊字符转义；首尾空白剔除', () => {
  assert.equal(buildGeocodingUrl('New York'), 'https://geocoding-api.open-meteo.com/v1/search?name=New%20York&count=1&language=zh&format=json')
  assert.equal(buildGeocodingUrl('L&A'), 'https://geocoding-api.open-meteo.com/v1/search?name=L%26A&count=1&language=zh&format=json')
  assert.equal(buildGeocodingUrl('  上海  '), buildGeocodingUrl('上海'))
})

test('buildGeocodingUrl：空/纯空白/非字符串城市抛 TypeError（city 为空应休眠不查询）', () => {
  assert.throws(() => buildGeocodingUrl(''), TypeError)
  assert.throws(() => buildGeocodingUrl('   '), TypeError)
  assert.throws(() => buildGeocodingUrl(null), TypeError)
  assert.throws(() => buildGeocodingUrl(undefined), TypeError)
  assert.throws(() => buildGeocodingUrl(123), TypeError)
})

test('buildForecastUrl：current=weather_code,temperature_2m + timezone=auto，数值/负值坐标', () => {
  assert.equal(
    buildForecastUrl(31.2304, 121.4737),
    'https://api.open-meteo.com/v1/forecast?latitude=31.2304&longitude=121.4737&current=weather_code,temperature_2m&timezone=auto',
  )
  assert.equal(
    buildForecastUrl(-33.87, -70.7),
    'https://api.open-meteo.com/v1/forecast?latitude=-33.87&longitude=-70.7&current=weather_code,temperature_2m&timezone=auto',
  )
  const u = new URL(buildForecastUrl(0, 0))
  assert.deepEqual([...u.searchParams.keys()].sort(), ['current', 'latitude', 'longitude', 'timezone'])
  assert.equal(u.searchParams.get('current'), 'weather_code,temperature_2m')
  assert.equal(u.searchParams.get('timezone'), 'auto')
  assert.ok(!/api[_-]?key|token|secret|password/i.test(u.href), 'URL 不得携带密钥形参数')
})

test('buildForecastUrl：非有限数值/缺省坐标抛 TypeError（含 Number(null)===0 隐式收敛坑）', () => {
  assert.throws(() => buildForecastUrl('x', 0), TypeError)
  assert.throws(() => buildForecastUrl(0, Number.NaN), TypeError)
  assert.throws(() => buildForecastUrl(null, null), TypeError)
  assert.throws(() => buildForecastUrl(undefined, 0), TypeError)
  assert.throws(() => buildForecastUrl('', 0), TypeError) // Number('')===0 同坑
  assert.throws(() => buildForecastUrl(Infinity, 0), TypeError)
  assert.throws(() => buildForecastUrl(0), TypeError) // lon 缺省
  assert.throws(() => buildForecastUrl(true, 0), TypeError) // 布尔不收敛
})

// ---- WEATHER_CODE_MAP 全码覆盖（phase2-plan §6 全表 = musume WEATHER_MAP 28 码重分雨档）----
test('WEATHER_CODE_MAP：§6 全表冻结映射（28 码）', () => {
  assert.equal(Object.isFrozen(WEATHER_CODE_MAP), true)
  assert.deepEqual(WEATHER_CODE_MAP, {
    '0': 'clear', '1': 'clear', '2': 'clear', '3': 'clear',
    '45': 'clear', '48': 'clear',
    '51': 'rain', '53': 'rain', '55': 'rain',
    '56': 'umbrella', '57': 'umbrella',
    '61': 'umbrella', '63': 'umbrella', '65': 'umbrella',
    '66': 'umbrella', '67': 'umbrella',
    '80': 'rain', '81': 'rain', '82': 'umbrella',
    '71': 'snow', '73': 'snow', '75': 'snow', '77': 'snow', '85': 'snow', '86': 'snow',
    '95': 'thunder', '96': 'thunder', '99': 'thunder',
  })
})

test('WEATHER_CODE_MAP：键恰为 Open-Meteo 发码集，未发码位不入表（未知码归 resolveWeatherId 兜底）', () => {
  const keys = Object.keys(WEATHER_CODE_MAP)
  assert.equal(keys.length, 28)
  assert.ok(keys.every((k) => /^\d+$/.test(k)), '键必须为数字字符串')
  for (const absent of ['4', '44', '46', '47', '50', '52', '54', '58', '60', '62', '64', '68', '69', '70', '72', '74', '76', '78', '79', '83', '84', '87', '88', '89', '93', '94', '97', '98']) {
    assert.equal(absent in WEATHER_CODE_MAP, false, `未发码位 ${absent} 不应入表`)
  }
})

// ---- resolveWeatherId 优先级 thunder > snow > rain > umbrella > cold(tempC≤0) > clear ----
test('resolveWeatherId：非 clear 映射命中直接生效（压过 cold 温度派生）', () => {
  assert.equal(resolveWeatherId({ code: 95, tempC: -30 }), 'thunder')
  assert.equal(resolveWeatherId({ code: 96, tempC: -30 }), 'thunder')
  assert.equal(resolveWeatherId({ code: 99, tempC: -30 }), 'thunder')
  assert.equal(resolveWeatherId({ code: 75, tempC: 25 }), 'snow')
  assert.equal(resolveWeatherId({ code: 86, tempC: 10 }), 'snow')
  assert.equal(resolveWeatherId({ code: 51, tempC: -30 }), 'rain')
  assert.equal(resolveWeatherId({ code: 81, tempC: -30 }), 'rain')
  assert.equal(resolveWeatherId({ code: 61, tempC: -30 }), 'umbrella')
  assert.equal(resolveWeatherId({ code: 82, tempC: -30 }), 'umbrella')
})

test('resolveWeatherId：cold 只在未命中实质天气且 tempC≤0 时派生', () => {
  assert.equal(resolveWeatherId({ code: 0, tempC: -5 }), 'cold')
  assert.equal(resolveWeatherId({ code: 1, tempC: -20 }), 'cold')
  assert.equal(resolveWeatherId({ code: 3, tempC: -1 }), 'cold')
  assert.equal(resolveWeatherId({ code: 45, tempC: -0.5 }), 'cold') // 雾回 clear 后温度派生
})

test('resolveWeatherId：tempC 边界 0 / 0.5 / −0.5', () => {
  assert.equal(resolveWeatherId({ code: 0, tempC: 0 }), 'cold') // ≤0 含 0（结冰点）
  assert.equal(resolveWeatherId({ code: 0, tempC: 0.5 }), 'clear')
  assert.equal(resolveWeatherId({ code: 0, tempC: -0.5 }), 'cold')
})

test('resolveWeatherId：未知/缺码/脏输入回 clear（=不换装）', () => {
  assert.equal(resolveWeatherId({}), 'clear')
  assert.equal(resolveWeatherId({ code: 999 }), 'clear')
  assert.equal(resolveWeatherId({ code: -1 }), 'clear')
  assert.equal(resolveWeatherId({ code: 50 }), 'clear')
  assert.equal(resolveWeatherId({ code: null }), 'clear')
  assert.equal(resolveWeatherId({ code: undefined }), 'clear')
  assert.equal(resolveWeatherId(), 'clear')
  assert.equal(resolveWeatherId({ code: 'oops' }), 'clear')
  assert.equal(resolveWeatherId({ code: Number.NaN }), 'clear')
  assert.equal(resolveWeatherId({ code: 0, tempC: 25 }), 'clear') // 晴天常温不换装
})

test('resolveWeatherId：未知/缺码 + tempC≤0 → 仍温度派生 cold（§6 口径；钉住 §2.4/§6 分裂边界防漂移）', () => {
  // 计划 §2.4 写「未知/缺码 → clear（=不换装）」，§6 又写「tempC ≤ 0 且未命中
  // rain/snow/thunder/umbrella → cold」——两处在该组合上语义分裂。实现取 §6
  // （weather.mjs：表外/缺码先落 clear，再经温度派生可得 cold——严寒不因上游发码
  // 扩展而丢失换装）。本用例钉住该边界：若改成 §2.4 口径（未知/缺码恒 clear）此处变红。
  assert.equal(resolveWeatherId({ code: 999, tempC: -5 }), 'cold')
  assert.equal(resolveWeatherId({ code: null, tempC: -5 }), 'cold')
  assert.equal(resolveWeatherId({ code: undefined, tempC: -1 }), 'cold')
  assert.equal(resolveWeatherId({ tempC: 0 }), 'cold') // 缺码 + 0℃（≤0 含冰点）
  assert.equal(resolveWeatherId({ code: 'oops', tempC: -0.5 }), 'cold')
  assert.equal(resolveWeatherId({ code: Number.NaN, tempC: -5 }), 'cold')
  // 对照：未知/缺码 + tempC>0 → clear（=不换装）
  assert.equal(resolveWeatherId({ code: 999, tempC: 5 }), 'clear')
})

test('resolveWeatherId：数字码与字符串码等价（Open-Meteo JSON 产 number，路由透传容错）', () => {
  for (const code of [0, 45, 51, 61, 71, 80, 95, 999]) {
    assert.equal(resolveWeatherId({ code }), resolveWeatherId({ code: String(code) }))
  }
})

test('resolveWeatherId：tempC 非有限数值视为缺省，不派生 cold', () => {
  assert.equal(resolveWeatherId({ code: 0, tempC: '0' }), 'clear') // 字符串不收敛（路由 JSON 产 number）
  assert.equal(resolveWeatherId({ code: 0, tempC: Number.NaN }), 'clear')
  assert.equal(resolveWeatherId({ code: 0, tempC: null }), 'clear')
  assert.equal(resolveWeatherId({ code: 0, tempC: undefined }), 'clear')
})

// ---- 常量与素材对齐 ----
test('WEATHER_POLL_MS：30 分钟节拍常量（client 轮询 /api/whale-pet/weather）', () => {
  assert.equal(WEATHER_POLL_MS, 30 * 60_000)
  assert.equal(WEATHER_POLL_MS, 1_800_000)
})

test('映射 id 与素材文件对齐：rain/snow/thunder/umbrella 由码可达；cold 由温度派生；五素材在库', () => {
  const ids = new Set(Object.values(WEATHER_CODE_MAP))
  // rain/snow/thunder/umbrella 必须有 weathercode 映射可达（死 id 即素材永不可达）
  for (const id of ['rain', 'snow', 'thunder', 'umbrella']) {
    assert.ok(ids.has(id), `id ${id} 不可达（死 id，无任何 weathercode 映射到它）`)
  }
  // cold 不入码表（纯温度派生），但必须经 resolveWeatherId 可达
  assert.ok(!ids.has('cold'), 'cold 不应由 weathercode 直接映射（设计：tempC≤0 派生）')
  assert.equal(resolveWeatherId({ code: 0, tempC: -1 }), 'cold')
  const FILES = {
    rain: 'dsh-whale-state-weather-rain-happy.webp', // 唯一 id→文件名例外（§6 表）
    snow: 'dsh-whale-state-weather-snow.webp',
    thunder: 'dsh-whale-state-weather-thunder.webp',
    umbrella: 'dsh-whale-state-weather-umbrella.webp',
    cold: 'dsh-whale-state-weather-cold.webp',
  }
  const musumeDir = join(ROOT, 'assets', 'musume')
  for (const [id, file] of Object.entries(FILES)) {
    assert.ok(existsSync(join(musumeDir, file)), `素材缺失：${file}（id=${id}）`)
  }
  assert.ok(Object.isFrozen(WEATHER_CODE_MAP), '映射必须冻结（调用方不可篡改）')
})
