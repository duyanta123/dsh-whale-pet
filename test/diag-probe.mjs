// 桌面端只读诊断：probe 环形缓冲 + settings 契约 + 会话错误面（不做任何点击/写入）。
const t = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = t.find((x) => x.type === 'page' && /^dsh-app:\/\//.test(x.url))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pend = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) }
})
const call = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const ev = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.value
}

const probe = await ev(`(async () => (await (await fetch('/api/whale-pet/probe')).json()).events ?? [])()`)
console.log('probe 事件数:', probe.length)
const byType = {}
for (const e of probe) byType[e.event] = (byType[e.event] ?? 0) + 1
console.log('按事件类型:', JSON.stringify(byType))
console.log('最近 6 条:', JSON.stringify(probe.slice(-6).map((e) => ({ at: new Date(e.at).toISOString().slice(11, 19), event: e.event }))))

const settings = await ev(`(async () => (await (await fetch('/api/whale-pet/settings')).json()))()`)
const phase2Keys = ['game', 'festival', 'weather', 'balanceLow', 'memeCdn', 'character']
console.log('settings 二期键:', JSON.stringify(phase2Keys.map((k) => `${k}=${JSON.stringify(settings[k] ?? '缺失')}`)))

const state = await ev(`(async () => (await (await fetch('/api/whale-pet/state')).json()))()`)
console.log('pet.stats:', JSON.stringify(state.pet?.stats))
console.log('当前 windows:', JSON.stringify((state.windows ?? []).map((w) => w.name)))

const sessionErr = await ev(`(() => {
  const errs = [...document.querySelectorAll('[class*="error"],[class*="Error"],[role="alert"]')]
    .map((x) => (x.textContent || '').trim()).filter((s) => s.length > 0 && s.length < 160)
  return [...new Set(errs)].slice(0, 4)
})()`)
console.log('页面错误面:', JSON.stringify(sessionErr))
ws.close()
