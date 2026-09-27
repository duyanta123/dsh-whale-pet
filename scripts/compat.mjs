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

function run(args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn('dsh', args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      if (process.platform === 'win32') {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true }) } catch {}
      }
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
    'dsh', ['web', '--profile', PROFILE, '--no-open', '--port', '0'],
    { shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  const stop = () => {
    try { child.kill() } catch {}
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: true }) } catch {}
    }
  }
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let base = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    if (child.exitCode !== null) return { base: null, stop, exited: true, out }
    const m = out.match(/https?:\/\/[^\s"'<>]+/)
    if (m) base = m[0].replace(/[)\].,]+$/, '')
    if (base) {
      try {
        const res = await fetch(base + PROBE_PATH, { signal: AbortSignal.timeout(3000) })
        if (res.ok) {
          const body = await res.json().catch(() => null)
          return { base, stop, exited: false, out, body }
        }
      } catch { /* 未就绪，继续等 */ }
    }
  }
  return { base, stop, exited: child.exitCode !== null, out }
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

if (failures > 0) {
  console.error(`test:compat 失败（${failures} 项）`)
  process.exit(1)
}
console.log('test:compat 通过')
