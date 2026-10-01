// M6-3 跟随工具：任务记账决定性实验 —— 普通聊天轮次是否被账本记录（turn/end 记账修正的复验器）。
// 前置：桌面端以 --remote-debugging-port=9222 运行、desktop profile 已装入本插件。
// 用法：node test/desktop-probe-settled.mjs（发一条极小消息，消耗少量配额）。
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = targets.find(t => t.type === 'page' && /^dsh-app:\/\//.test(t.url))
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { socket.addEventListener('open', res, { once: true }); socket.addEventListener('error', rej, { once: true }) })
let id = 0
const pending = new Map()
socket.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
})
const call = (method, params = {}) => new Promise((res, rej) => {
  const callId = ++id
  setTimeout(() => { pending.delete(callId); rej(new Error('timeout ' + method)) }, 20000)
  pending.set(callId, { resolve: res, reject: rej })
  socket.send(JSON.stringify({ id: callId, method, params }))
})
const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
await call('Runtime.enable').catch(() => {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const petBefore = await evaluate(`(async () => (await fetch('/api/whale-pet/state')).json())().then(j => j.pet.stats)`)
console.log('before:', JSON.stringify(petBefore))

// 发消息（复用冒烟 D 段技法）
await evaluate(`(() => { const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => (e.getAttribute('placeholder') || '').includes('发消息')); el?.focus(); return !!el })()`)
await call('Input.insertText', { text: '实验消息：只回复一个字：好' })
await sleep(600)
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('发送') && !x.disabled); b?.click(); return !!b })()`)
console.log('已发送，等待轮次结束…')

// 等 thinking 出现再消失（或 75s 超时）
let sawThinking = false
let quiet = 0
for (let i = 0; i < 150; i += 1) {
  await sleep(500)
  const facts = await evaluate(`(async () => (await fetch('/api/whale-pet/state')).json())().then(j => ({ t: j.thinking, w: j.windows.map(w => w.name) }))`).catch(() => null)
  if (facts?.t) { sawThinking = true; quiet = 0 }
  else if (sawThinking) quiet += 1
  if (sawThinking && quiet >= 12) break // thinking 结束 6s
}
console.log('sawThinking:', sawThinking)
await sleep(3000)

const probe = await evaluate(`(async () => (await fetch('/api/whale-pet/probe')).json())()`)
const nonSession = probe.events.filter(e => e.event !== 'session/event')
console.log('probe 总数:', probe.events.length, '| 非 session/event:', nonSession.length)
for (const e of nonSession) console.log(' ', new Date(e.at).toLocaleTimeString('zh-CN'), e.event, JSON.stringify(e.payload).slice(0, 260))
const petAfter = await evaluate(`(async () => (await fetch('/api/whale-pet/state')).json())().then(j => j.pet.stats)`)
console.log('after:', JSON.stringify(petAfter))
socket.close()
