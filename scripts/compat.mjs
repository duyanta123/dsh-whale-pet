#!/usr/bin/env node
// test:compat 门禁（M0-4）：宿主版本锁定 + 隔离 profile 全流程探活。
// 流程：版本校验 → 从官方 web 模板初始化隔离 profile → add 本地包 → 配置 dump
// （插件行必须进入组合树）→ 限时启动 dsh web 探活（HTTP 200 + 本插件路由可达）→ 清理。
// 基线：@deepseek-ai/dsh@0.1.7-rc.2（改基线须同步开发计划 §1 宿主基线与 CI）。
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const EXPECTED_DSH_VERSION = '0.1.7-rc.2'
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PROFILE = `compat-whale-pet-${process.pid}`
const BOOT_TIMEOUT_MS = 90_000
const PROBE_PATH = '/api/whale-pet/state'

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE || process.env.HOME, '.dsh')
const profileDir = join(dshHome, 'profiles', PROFILE)

let failures = 0
const fail = (msg) => { failures += 1; console.error(`  ✗ ${msg}`) }
const ok = (msg) => console.log(`  ✓ ${msg}`)

/**
 * Windows 进程树击杀（2026-09-30 实测修正，见开发计划附录 B）：
 * 旧顺序 `child.kill()` → `taskkill /T` 会先杀死 shell 壳进程，
 * 随后 taskkill 打在已死 PID 上失效，dsh 孙进程脱树泄漏并污染后续运行。
 * 正确顺序：先对存活进程 taskkill /T /F，再补 child.kill()；
 * 另按命令行特征（profile 名每次运行唯一，不误伤其他 dsh 会话）做脱树孙进程兜底清扫。
 */
function killTree(child, tag) {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true })
    } catch {}
    try {
      spawn('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
        `Where-Object { $_.CommandLine -match '${tag}' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { shell: false })
    } catch {}
  }
  try { child.kill() } catch {}
}

/** 查询命令行含 tag 的 node 进程 PID 列表（Windows）；查询失败返回 []（不因工具问题误判）。 */
function sweepProfilePids(tag) {
  if (process.platform !== 'win32') return Promise.resolve([])
  return new Promise((resolveSweep) => {
    try {
      const child = spawn('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
        `Where-Object { $_.CommandLine -match '${tag}' } | ` +
        `ForEach-Object { $_.ProcessId }`], { shell: false })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.on('error', () => resolveSweep([]))
      child.on('close', (code) => {
        if (code !== 0) return resolveSweep([])
        resolveSweep(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number))
      })
    } catch {
      resolveSweep([])
    }
  })
}

function run(args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn('dsh', args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      killTree(child, PROFILE)
      resolveRun({ code: -1, out, err, timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun({ code, out, err, timedOut: false })
    })
  })
}

/** 启动 dsh web 并解析监听地址；探活成功或超时后返回 { url, stop() }。 */
async function bootWebAndProbe({ expectPluginRoute }) {
  const child = spawn(
    'dsh', ['--profile', PROFILE, '--no-open', '--port', '0'],
    { shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const stop = () => killTree(child, PROFILE)
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let base = null
  let lastProbe = "never"
  let lastLogAt = 0
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    if (child.exitCode !== null) return { base: null, stop, exited: true, out, err }
    const m = out.match(/https?:\/\/[^\s"'<>]+/)
    // base 只保留 origin：boot URL 形如 http://127.0.0.1:PORT/?token=…，
    // 截掉 query 并去掉尾斜杠（否则拼出 //api/... 双斜杠 404）。
    if (m) base = m[0].replace(/[)\].,]+$/, '').split('?')[0].replace(/\/+$/, '')
    if (base) {
      try {
        const res = await fetch(base + PROBE_PATH, { signal: AbortSignal.timeout(3000) })
        if (res.ok) {
          const body = await res.json().catch(() => null)
          return { base, stop, exited: false, out, err, body }
        }
        lastProbe = `status ${res.status}`
      } catch (error) {
        lastProbe = `fetch: ${error?.message ?? error}${error?.cause ? ' / ' + (error.cause?.message ?? error.cause) : ''}`
      }
      if (Date.now() - lastLogAt > 5000) {
        lastLogAt = Date.now()
        console.log(`    …探活 ${Math.round((Date.now() - (deadline - BOOT_TIMEOUT_MS)) / 1000)}s ${base}${PROBE_PATH} → ${lastProbe}`)
      }
    } else if ((BOOT_TIMEOUT_MS - (deadline - Date.now())) % 15000 === 0) {
      console.log(`    …boot ${Math.round((deadline - Date.now()) / 1000)}s：out=${JSON.stringify(out.slice(0, 120))} err=${JSON.stringify(err.slice(0, 120))}`)
    }
  }
  return { base, stop, exited: child.exitCode !== null, out, err }
}

console.log(`test:compat · 基线 @deepseek-ai/dsh@${EXPECTED_DSH_VERSION}`)

// 1) 版本锁定
const ver = await run(['--version'], { timeoutMs: 30_000 })
if (ver.out.trim() === EXPECTED_DSH_VERSION) ok(`宿主版本 ${ver.out.trim()}`)
else fail(`宿主版本应为 ${EXPECTED_DSH_VERSION}，实际「${ver.out.trim() || ver.err.trim()}」`)

if (failures === 0) {
  // 2) 初始化隔离 profile（从官方 web 模板；已存在则沿用）
  const init = await run(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], { timeoutMs: 120_000 })
  if (init.code === 0) ok(`隔离 profile ${PROFILE} 就绪`)
  else fail(`profile 初始化失败：${(init.err || init.out).slice(0, 300)}`)

  if (failures === 0) {
    // 3) add 本地包（pnpm file: 安装）
    const add = await run(['plugin', '--profile', PROFILE, 'add', PACKAGE_ROOT], { timeoutMs: 300_000 })
    if (add.code === 0) ok('plugin add 本地包成功')
    else fail(`plugin add 失败：${(add.err || add.out).slice(0, 500)}`)

    if (failures === 0) {
      // 4) 配置 dump：插件行必须出现在组合树
      const dump = await run(['--profile', PROFILE, '--dump-config'], { timeoutMs: 120_000 })
      if (dump.code === 0 && dump.out.includes('whale-pet')) ok('配置 dump 含 whale-pet 插件行')
      else fail('配置 dump 未包含 whale-pet 插件行')

      if (failures === 0) {
        // 5) 限时启动探活
        console.log('  … 启动 dsh web 探活（最长 90s）')
        const boot = await bootWebAndProbe({})
        try {
          if (boot.base && boot.body) ok(`web 启动探活成功：${boot.base}${PROBE_PATH} → ${JSON.stringify(boot.body).slice(0, 80)}`)
          else fail(`web 探活失败${boot.exited ? '（进程提前退出）' : ''}：${(boot.out || '').slice(-400)}`)
        } finally {
          boot.stop()
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
    }
  }
}

// 6) 清理隔离 profile
try {
  rmSync(profileDir, { recursive: true, force: true })
  ok('隔离 profile 已清理')
} catch (error) {
  console.warn(`  ! 清理失败（可手动删除 ${profileDir}）：${error.message}`)
}

// 7) 泄漏自检：本次运行不得残留任何 dsh boot 进程（脱树孙进程曾致后续门禁并发卡死）。
const leakPids = await sweepProfilePids(PROFILE)
if (leakPids.length > 0) {
  killTree({ pid: leakPids[0], kill() {} }, PROFILE)
  await new Promise((r) => setTimeout(r, 2000))
  const again = await sweepProfilePids(PROFILE)
  if (again.length > 0) fail(`dsh boot 进程泄漏未清干净：${again.join(', ')}`)
  else ok('dsh boot 进程泄漏自检：清扫后无残留')
} else {
  ok('dsh boot 进程泄漏自检：无残留')
}

if (failures > 0) {
  console.error(`test:compat 失败（${failures} 项）`)
  process.exit(1)
}
console.log('test:compat 通过')
