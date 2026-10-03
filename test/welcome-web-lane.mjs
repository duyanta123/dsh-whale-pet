// web 车道真实 agent/created → welcome 硬断言：隔离 profile 自管环境，浏览器页面加载
// 即创建真实新会话（agent/created，桌面端今天实测 source='resume' 的对照面）。
// 断言：页面加载后 12s 内 dataset.state === 'welcome'（真实事件，非 mock 注入）。
// 运行：node test/welcome-web-lane.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { bootHost, cleanup, findBrowser, openBrowser, waitFor } from './cdp-lib.mjs'

const watchdog = setTimeout(() => { console.error('WATCHDOG: 4 分钟强制退出'); process.exit(2) }, 240_000)
const browserPath = findBrowser()
if (browserPath === null) { console.error('未找到 Chrome/Edge'); process.exit(2) }

let host = null
let browser = null
let chromeDir = null
try {
  host = await bootHost({ profile: `whale-welcome-${process.pid}` })
  console.log('隔离宿主就绪:', host.base)
  chromeDir = mkdtempSync(join(tmpdir(), 'whale-welcome-chrome-'))
  browser = await openBrowser({ browserPath, pageUrl: host.pageUrl, cdpPort: 9335, dataDir: chromeDir })
  const { evaluate, call, events } = browser
  await call('Runtime.enable').catch(() => {})
  // 页面加载 → dsh 会话启动 → agent/created → welcome 窗口（6s）。10s 内必须观察到。
  const seen = await waitFor(evaluate,
    `document.querySelector('[data-whale-pet]')?.dataset.state === 'welcome'`,
    '真实 welcome 窗口', 12_000).then(() => true, () => false)
  const state = await evaluate(`document.querySelector('[data-whale-pet]')?.dataset.state ?? null`)
  const windows = await evaluate(`(async () => (await (await fetch('/api/whale-pet/state')).json()).windows ?? [])()`)
  console.log(`${seen ? 'PASS' : 'FAIL'} 页面加载真实 agent/created → welcome 窗口（12s 内）  当前 state=${state} windows=${JSON.stringify(windows.map((w) => w.name))}`)
  const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown').length
  console.log(`页面异常数: ${errs}`)
  process.exit(seen && errs === 0 ? 0 : 1)
} finally {
  clearTimeout(watchdog)
  try { cleanup(browser, host) } catch {}
}
