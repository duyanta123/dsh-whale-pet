#!/usr/bin/env node
// 宿主升级跟随工具（M6-3 跟随约定）：解包官方桌面端 app.asar，逐项核对本插件的宿主耦合面。
// 用法：node scripts/desktop-probe.mjs <桌面端安装目录 | app.asar 路径>
//       （如 `node scripts/desktop-probe.mjs "D:\deep seek harness"`）
// 零依赖：自实现 asar 头解析（pickle 布局：[0..4]=4、[4..8]=headerSize、JSON@16、文件数据@8+headerSize+offset）。
// 核对项来自 2026-10-01 对 @deepseek-ai/dsh-desktop@0.2.0-rc.2 的解包核验（开发计划附录 B）；
// 每次官方 release 后重跑一遍，任何 ✗ 都意味着宿主契约变更、需要先适配再发插件。
import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'

// ---- asar 最小读取器 ----

function openAsar(archivePath) {
  const fd = openSync(archivePath, 'r')
  const sizeBuf = Buffer.alloc(8)
  readSync(fd, sizeBuf, 0, 8, 0)
  const headerSize = sizeBuf.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerSize)
  readSync(fd, headerBuf, 0, headerSize, 8)
  const jsonLen = headerBuf.readUInt32LE(4)
  const header = JSON.parse(headerBuf.subarray(8, 8 + jsonLen).toString('utf8'))
  const dataStart = 8 + headerSize
  return {
    header,
    /** 读取 asar 内单个文件，返回 Buffer；路径段相对于 asar 根（不带前导分隔符）。 */
    read(pathSegs) {
      let node = header
      for (const seg of pathSegs) {
        node = node.files?.[seg]
        if (!node) return null
      }
      if (node.files) return null
      const buf = Buffer.alloc(node.size)
      readSync(fd, buf, 0, node.size, dataStart + Number(node.offset))
      return buf
    },
    /** 收集满足正则的文件路径（asar 内部以 \ 分隔，统一成 / 再匹配）。 */
    files() {
      const out = []
      const walk = (node, prefix) => {
        for (const [name, child] of Object.entries(node.files ?? {})) {
          const p = `${prefix}/${name}`
          if (child.files) walk(child, p)
          else out.push(p)
        }
      }
      walk(header, '')
      return out
    },
    close: () => closeSync(fd),
  }
}

// ---- 探测项 ----

const runtime = (pkg) => `@deepseek-ai/dsh@${pkg?.dependencies?.['@deepseek-ai/dsh'] ?? '?'}`

const checks = [
  {
    name: '桌面应用清单（@deepseek-ai/dsh-desktop）',
    run(asar) {
      const pkg = JSON.parse(asar.read(['package.json']) ?? '')
      return `应用 ${pkg.name} ${pkg.version}${pkg.dshBuildCommit ? `（build ${String(pkg.dshBuildCommit).slice(0, 9)}）` : ''}`
    },
  },
  {
    name: '内置 dsh runtime 版本',
    run(asar) {
      const pkg = JSON.parse(asar.read(['dsh', 'package.json']) ?? '')
      return `${pkg.name} ${pkg.version}；捆绑 CLI ${runtime(pkg)}`
    },
  },
  {
    name: 'client combo 装载器 __ModuleLoader__（前端 index chunk）',
    run(asar) {
      const chunk = asar.files().find((p) => /^\/dsh\/node_modules\/@deepseek-ai\/dsh-web-frontend\/dist\/assets\/index-[^/]+\.js$/.test(p))
      if (!chunk) throw new Error('前端 index chunk 未找到')
      const buf = asar.read(chunk.replace(/^\//, '').split('/'))
      if (!buf?.includes('__ModuleLoader__')) throw new Error(`${chunk} 中无 __ModuleLoader__`)
      return chunk
    },
  },
  {
    name: '槽位 shell.overlay（桌宠本体挂载点）',
    run(asar) {
      const buf = asar.read(['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-layout', 'lib', 'client.js'])
      if (!buf?.includes('shell.overlay')) throw new Error('dsh-client-ui-layout/lib/client.js 中未找到')
      return 'dsh-client-ui-layout/lib/client.js'
    },
  },
  {
    name: '槽位 settings.section（设置卡挂载点）',
    run(asar) {
      const hit = asar.files().find((p) => /^\/dsh\/node_modules\/@deepseek-ai\/dsh-client-ui-settings[a-z-]*\/lib\/client\.js$/.test(p)
        && asar.read(p.replace(/^\//, '').split('/'))?.includes('settings.section'))
      if (!hit) throw new Error('client-ui-settings* 均未声明该槽位')
      return hit
    },
  },
  {
    name: 'dsh.client 清单解析（platform/inject/external）',
    run(asar) {
      const buf = asar.read(['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'index.js'])
      if (!buf?.includes('dsh.client') || !buf?.includes('parseDshClient')) throw new Error('dsh-client-modules/lib/index.js 中未找到')
      return 'dsh-client-modules/lib/index.js'
    },
  },
  {
    name: '插件路由与注入（webServer.register + collectIndexInjections）',
    run(asar) {
      const buf = asar.read(['dsh', 'node_modules', '@deepseek-ai', 'dsh-host-webserver', 'lib', 'index.js'])
      const need = ['register(route', 'collectIndexInjections']
      for (const s of need) if (!buf?.includes(s)) throw new Error(`dsh-host-webserver/lib/index.js 中缺 ${s}`)
      return 'dsh-host-webserver/lib/index.js'
    },
  },
  {
    name: '状态镜像事件（agent/created、agent/request-error、turn/start、turn/end）',
    run(asar) {
      const events = ['agent/created', 'agent/request-error', 'turn/start', 'turn/end']
      const missing = []
      const scanned = asar.files().filter((p) => /^\/dsh\/node_modules\/@deepseek-ai\/dsh-(agent|session|subagent|jobs)[a-z-]*\/lib\/[a-zA-Z0-9._-]+\.js$/.test(p))
      for (const ev of events) {
        const hit = scanned.some((p) => asar.read(p.replace(/^\//, '').split('/'))?.includes(ev))
        if (!hit) missing.push(ev)
      }
      if (missing.length > 0) throw new Error(`缺失事件：${missing.join('、')}（扫描 ${scanned.length} 个运行时文件）`)
      return `四事件均在（扫描 ${scanned.length} 个文件）`
    },
  },
  {
    name: '插件兼容门禁（peerDependencies 精确版本校验）',
    run(asar) {
      const buf = asar.read(['dsh', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'])
      for (const s of ['evaluatePluginCompatibility', 'includePrerelease']) {
        if (!buf?.includes(s)) throw new Error(`dsh-app-boot/lib/index.js 中缺 ${s}`)
      }
      return 'dsh-app-boot/lib/index.js（本插件 peerDependencies >=0.1.7-rc.2 声明经此校验）'
    },
  },
  {
    name: 'desktop profile 归属（Electron 独占标记）',
    run(asar) {
      const buf = asar.read(['dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'])
      if (!buf?.includes('managed exclusively by the Electron application')) throw new Error('bin.js 中未找到独占标记')
      return 'npm 版 dsh 拒绝操作 desktop profile（插件管理须走桌面自带 CLI 或应用内管理器）'
    },
  },
]

// ---- 入口 ----

const arg = process.argv[2]
const asarPath = (() => {
  const p = arg ? resolve(arg) : null
  if (!p) throw new Error('用法：node scripts/desktop-probe.mjs <桌面端安装目录 | app.asar 路径>')
  if (existsSync(p) && p.toLowerCase().endsWith('.asar')) return p
  const candidate = join(p, 'resources', 'app.asar')
  if (existsSync(candidate)) return candidate
  throw new Error(`未找到 app.asar：既不是 .asar 文件，目录下也没有 resources/app.asar（${p}）`)
})()

console.log(`desktop-probe · ${asarPath}`)
let failures = 0
const asar = openAsar(asarPath)
try {
  for (const check of checks) {
    try {
      const detail = check.run(asar)
      console.log(`  ✓ ${check.name} — ${detail}`)
    } catch (error) {
      failures += 1
      console.error(`  ✗ ${check.name} — ${error?.message ?? error}`)
    }
  }
} finally {
  asar.close()
}

if (failures > 0) {
  console.error(`desktop-probe 失败（${failures} 项）：宿主契约有变，先适配再发插件`)
  process.exit(1)
}
console.log('desktop-probe 通过：宿主耦合面与 2026-10-01 核验基线一致')
