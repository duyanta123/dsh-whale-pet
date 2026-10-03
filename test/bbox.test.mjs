// 动态 bbox 热区单测（二期 ⑥，whale-girl 决策 2026-08-09：热区跟随当前状态、
// 逐状态 bbox 只取首帧、flip 镜像对齐内容、bbox 外不可交互、无表回退静态表）。
// 表/映射断言全部针对真实入库产物（bbox-table.json + assets/musume 文件清点）；
// 命中探针从表内矩形派生（不硬编码像素值，素材再生成不脆断）；--check 子进程
// 同步校验表与扫描结果一致。纯逻辑直测，不碰 DOM/定时器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import tableJson from '../lib/client/bbox-table.json' with { type: 'json' }
import { BBOX_TABLE_VERSION, BBOX_STATE_FILES, resolveBBox, bboxHit } from '../lib/client/bbox.mjs'
import { hitZone } from '../lib/client/hitzone.mjs'
import { resolveStateChain } from '../lib/client/assets-manifest.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MUSUME_DIR = join(REPO_ROOT, 'assets', 'musume')
const FILES = tableJson.files

const basenameOf = (file) => {
  const i = file.lastIndexOf('/')
  return i >= 0 ? file.slice(i + 1) : file
}
/** 矩形内相对 y = relY 处的舞台点（x 取矩形中线）。 */
const pointAtRelY = (rect, relY) => [(rect.x0 + rect.x1) / 2, rect.y0 + relY * (rect.y1 - rect.y0)]

test('bbox 表：92 文件全量入库，键集与 assets/musume/*.webp 清点一致，坐标合法非空', () => {
  const webpFiles = readdirSync(MUSUME_DIR).filter((f) => f.endsWith('.webp')).sort()
  assert.equal(webpFiles.length, 92, 'assets/musume webp 总数（计划口径 92）')
  assert.equal(Object.keys(FILES).length, 92, '表条目数')
  assert.deepEqual(Object.keys(FILES).sort(), webpFiles, '表键集 = 素材目录清点（无缺无多）')
  for (const [name, rect] of Object.entries(FILES)) {
    assert.ok(rect, `${name} 有 bbox（生成时 0 空帧）`)
    assert.ok(rect.x0 >= 0 && rect.x0 < rect.x1 && rect.x1 <= 1, `${name} x0<x1 且在 [0,1]`)
    assert.ok(rect.y0 >= 0 && rect.y0 < rect.y1 && rect.y1 <= 1, `${name} y0<y1 且在 [0,1]`)
  }
})

test('bbox 表：_meta 口径与 BBOX_TABLE_VERSION 一致（工具/阈值/首帧）', () => {
  assert.equal(tableJson._meta.version, 1)
  assert.equal(BBOX_TABLE_VERSION, tableJson._meta.version)
  assert.equal(tableJson._meta.tool, 'tools/analyze-bbox.py')
  assert.equal(tableJson._meta.alphaMin, 8)
  assert.equal(tableJson._meta.frame, 'first', '只取首帧（whale-girl 决策口径）')
})

test('BBOX_STATE_FILES：冻结 27 键逐一存在于 assets/musume/ 且全命中表内非空 bbox', () => {
  assert.equal(Object.isFrozen(BBOX_STATE_FILES), true)
  const expected = [
    'balance-low', 'celebrate', 'disappointed', 'error',
    'festival-christmas', 'festival-halloween', 'festival-mid-autumn', 'festival-spring',
    'game-cheat', 'game-happy', 'game-lose', 'game-think', 'game-win',
    'idle', 'night',
    'react-belly', 'react-head', 'react-tail',
    'sleep', 'struggling', 'think', 'wait',
    'weather-cold', 'weather-rain', 'weather-snow', 'weather-thunder', 'weather-umbrella',
  ]
  assert.deepEqual(Object.keys(BBOX_STATE_FILES).sort(), expected, '27 键精确集合（9+3+15）')
  for (const [state, file] of Object.entries(BBOX_STATE_FILES)) {
    assert.equal(existsSync(join(MUSUME_DIR, file)), true, `${state} → ${file} 存在`)
    assert.ok(FILES[file], `${state} 链首在 bbox 表内有非空矩形`)
  }
  // 例外映射必须显式成表（weather-rain → 素材名带 -happy）
  assert.equal(BBOX_STATE_FILES['weather-rain'], 'dsh-whale-state-weather-rain-happy.webp')
  assert.equal(BBOX_STATE_FILES.idle, 'dsh-whale-state-idle-cute.webp')
  assert.equal(BBOX_STATE_FILES['react-head'], 'dsh-whale-state-react-head.webp')
})

test('resolveBBox：已知状态返回与表一致的矩形；未知/链首 classic·webm 状态 null', () => {
  // ① 一期 9 键实时链首（resolveStateChain）+ ② react（REACT_ASSETS）+ ③ 二期冻结映射
  for (const state of ['idle', 'think', 'game-win', 'festival-spring', 'react-head']) {
    const rect = resolveBBox(state)
    assert.ok(rect, `${state} 解析出矩形`)
    const file = BBOX_STATE_FILES[state]
    assert.equal(rect.x0, FILES[file].x0)
    assert.equal(rect.y0, FILES[file].y0)
    assert.equal(rect.x1, FILES[file].x1)
    assert.equal(rect.y1, FILES[file].y1)
  }
  // 一期 9 键实时链首与冻结映射一致（本模块内自洽 sanity；EXTRA 漂移断言归 manifest.test）
  for (const state of ['think', 'wait', 'celebrate', 'error', 'disappointed', 'sleep', 'night', 'struggling', 'idle']) {
    assert.equal(basenameOf(resolveStateChain(state)[0].file), BBOX_STATE_FILES[state])
  }
  // 返回冻结副本（防调用方改写共享表数据）
  assert.equal(Object.isFrozen(resolveBBox('idle')), true)
  // 未知状态 / 链首为 classic 或 webm 的状态（§8 ⛔ 行）→ null → 运行时回退静态表
  assert.equal(resolveBBox('no-such-state'), null)
  assert.equal(resolveBBox('welcome'), null) // classic/welcome.webp
  assert.equal(resolveBBox('walk'), null) // classic/walk.webp
  assert.equal(resolveBBox('eat'), null) // webm/吃小鱼干.webm
  assert.equal(resolveBBox('working'), null) // webm 插曲池
})

test('resolveBBox：注入 chainHeadFile 模拟 classic 角色 → 查表 miss → null（characters×bbox 自洽）', () => {
  assert.equal(resolveBBox('idle', { chainHeadFile: 'assets/classic/idle.webp' }), null)
  // 注入为链首事实：musume 全路径 / 裸 basename 两种形式都按显示素材几何命中
  const viaPath = resolveBBox('idle', { chainHeadFile: 'assets/musume/dsh-whale-state-idle-cute.webp' })
  assert.deepEqual({ ...viaPath }, { ...resolveBBox('idle') })
  const viaBasename = resolveBBox('idle', { chainHeadFile: 'dsh-whale-state-idle-cute.webp' })
  assert.deepEqual({ ...viaBasename }, { ...resolveBBox('idle') })
  // 注入 92 表内其他 musume 文件同样按该文件几何解析（热区跟随显示内容）
  const peek = resolveBBox('idle', { chainHeadFile: 'assets/musume/dsh-whale-settings-peek.webp' })
  assert.deepEqual({ ...peek }, { ...FILES['dsh-whale-settings-peek.webp'] })
})

test('bboxHit：矩形内三段 head/belly/tail（矩形相对高度 0.2/0.6/0.95 探针）、矩形外 null、越界夹取', () => {
  const rect = resolveBBox('idle')
  const midY = (rect.y0 + rect.y1) / 2
  for (const [relY, zone] of [[0.2, 'head'], [0.6, 'belly'], [0.95, 'tail']]) {
    const [x, y] = pointAtRelY(rect, relY)
    assert.equal(bboxHit(x, y, 'idle'), zone, `relY=${relY} → ${zone}（比例沿用静态 full 表 0.45/0.78）`)
  }
  // 矩形外 → null（右/上/下间隙中点，均从表内矩形派生）
  assert.equal(bboxHit(rect.x1 + (1 - rect.x1) / 2, midY, 'idle'), null, '右外侧 null')
  assert.equal(bboxHit((rect.x0 + rect.x1) / 2, rect.y0 / 2, 'idle'), null, '上外侧 null')
  assert.equal(bboxHit((rect.x0 + rect.x1) / 2, rect.y1 + (1 - rect.y1) / 2, 'idle'), null, '下外侧 null')
  // 越界坐标先夹取 [0,1]（夹取后落矩形外 → null；非数值 → 0）
  assert.equal(bboxHit(1.5, midY, 'idle'), null)
  assert.equal(bboxHit(-0.5, midY, 'idle'), null)
  assert.equal(bboxHit(undefined, midY, 'idle'), null)
})

test('bboxHit：flip=-1 x 镜像——网格对偶 + 不对称矩形上镜像真实改变判定', () => {
  // 对偶：flip=-1 的点 x 与 flip=1 的点 1−x 同判（两侧用同一表达式 1−x，规避 1ulp 漂移）
  for (const state of ['idle', 'walk']) { // 有表态 + 回退静态表态（静态表 x 向对称）
    for (let i = 0; i <= 10; i += 1) {
      const x = i / 10
      const xm = 1 - x
      for (const y of [0, 0.2, 0.5, 0.8, 1]) {
        assert.equal(bboxHit(x, y, state, { flip: -1 }), bboxHit(xm, y, state, { flip: 1 }))
      }
    }
  }
  // 非空验证：musume 表内找不对称矩形（x0 < 1−x1），构造「flip=1 在矩形内、
  // flip=-1 镜像点落在矩形外」的探针——若实现漏镜像，此用例必红。
  let best = null
  for (const [name, r] of Object.entries(FILES)) {
    const gap = 1 - r.x1 - r.x0 // >0 ⟺ x0 < 1−x1（左边距小于右边距：矩形偏左，镜像点落在右侧矩形外）
    if (gap > (best?.gap ?? 0) && r.x1 > 0.5) best = { name, rect: r, gap }
  }
  assert.ok(best && best.gap >= 0.001, `表内存在 ≥0.001 的 x 向不对称矩形（实际 ${best?.name} ${best?.gap}）`)
  const r = best.rect
  const probeX = (r.x0 + (1 - r.x1)) / 2 // ∈ (x0, 1−x1) ⊂ 矩形内；镜像点 1−probe > x1 落矩形外
  const midY = (r.y0 + r.y1) / 2
  const opts = { chainHeadFile: `assets/musume/${best.name}` }
  assert.notEqual(bboxHit(probeX, midY, 'idle', { ...opts, flip: 1 }), null, 'flip=1 原点在矩形内')
  assert.equal(bboxHit(probeX, midY, 'idle', { ...opts, flip: -1 }), null, 'flip=-1 镜像点在矩形外')
})

test('bboxHit：无表状态回退 hitzone.mjs 静态 full 语义（恒三区之一，永不 null）', () => {
  const points = [[0.5, 0.2], [0.5, 0.6], [0.5, 0.9], [0.01, 0.01], [0.99, 0.99], [0.3, 0.7], [0.7, 0.5]]
  for (const state of ['welcome', 'walk', 'eat', 'working', 'no-such-state']) {
    for (const [x, y] of points) {
      assert.equal(bboxHit(x, y, state), hitZone(x, y, 'full'), `${state}(${x},${y}) 与静态表一致`)
      assert.ok(['head', 'belly', 'tail'].includes(bboxHit(x, y, state)))
      assert.notEqual(bboxHit(x, y, state), null, '回退路径恒返回三区之一')
    }
  }
  // 对照：同一点，有表状态在 bbox 外 → null（消除「空白可点」），回退态恒有区
  assert.equal(bboxHit(0.01, 0.01, 'idle'), null)
  assert.equal(bboxHit(0.01, 0.01, 'welcome'), 'head')
  // characters×bbox 自洽：classic 链首注入下 idle 回退静态热区（与一期行为完全一致）
  assert.equal(bboxHit(0.5, 0.3, 'idle', { chainHeadFile: 'assets/classic/idle.webp' }), hitZone(0.5, 0.3, 'full'))
})

test('bbox-table.json 与扫描结果同步（真实运行 python tools/analyze-bbox.py --check）', () => {
  let out = null
  let lastErr = null
  for (const py of ['python', 'python3']) {
    try {
      out = execFileSync(py, ['tools/analyze-bbox.py', '--check'], {
        cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000,
      })
      break
    } catch (err) {
      lastErr = err
      if (err.code !== 'ENOENT') break // 解释器在但 --check 失败（表不同步）→ 直接红
    }
  }
  assert.ok(out !== null, `python --check 可运行（最后错误：${lastErr?.message ?? '无'}）`)
  assert.equal(out.trim(), `check ok: ${Object.keys(FILES).length} files in sync`)
})
