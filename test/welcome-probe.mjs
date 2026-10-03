// D1 welcome 判别实验 v4：逐个点击两颗「新建会话」按钮，读每次点击后最新 agent/created 的
// source 与 welcome 窗口 —— 实证 UI 各入口的会话语义（startup vs resume）。
import { setTimeout as delay } from 'node:timers/promises'
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
const windows = async () => ev(`(async () => (await (await fetch('/api/whale-pet/state')).json()).windows ?? [])()`)
const lastAgentCreated = async () => ev(`(async () => {
  const es = (await (await fetch('/api/whale-pet/probe')).json()).events ?? []
  const e = [...es].reverse().find((x) => x.event === 'agent/created')
  return e ? { at: new Date(e.at).toISOString().slice(11, 19), source: e.payload?.source ?? null } : null
})()`)
const clickNth = async (n) => ev(`(() => {
  const bs = [...document.querySelectorAll('button,[role="button"]')]
    .filter((x) => (x.getAttribute('aria-label') || '') === '新建会话' && !(x.title || '').includes('中新建'))
  const b = bs[${n}]
  if (!b) return 'no-button-' + ${n}
  const tag = (b.title || '') + '@' + (b.closest('[class*="sidebar"],[class*="header"],nav,aside')?.className?.slice?.(0, 30) ?? 'body')
  b.click()
  return tag
})()`)
const waitNewAgent = async (before) => {
  for (let i = 0; i < 14; i += 1) {
    await delay(500)
    const cur = await lastAgentCreated()
    if (cur && cur.at !== before) return cur
  }
  return null
}

for (const n of [0, 1]) {
  const before = (await lastAgentCreated())?.at ?? ''
  const where = await clickNth(n)
  const created = await waitNewAgent(before)
  const wins = await windows()
  console.log(`按钮[${n}] ${where} → agent/created: ${created ? JSON.stringify(created) : '未触发'}；welcome=${wins.some((w) => w.name === 'welcome') ? '有' : '无'}`)
}
ws.close()
