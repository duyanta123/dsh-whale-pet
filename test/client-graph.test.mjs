// M6-2 门禁固化：client 模块图完整性——lib/client/*.mjs 的相对导入必须全部落在
// /api/whale-pet/client/ 命名空间内且目标真实存在。
// 依据（附录 B 实测）：浏览器会把 '../' 规范化到命名空间根，父级相对导入 404 且
// 令整条 client 模块链加载失败（M3 dashboard、M2 bubble 曾各埋一处，本测试防复发）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client')

test('client 模块图：相对导入全部同命名空间（./ 前缀）且目标存在', () => {
  const files = readdirSync(CLIENT_DIR).filter((f) => f.endsWith('.mjs'))
  assert.ok(files.length >= 10, `client 模块数异常：${files.length}`)
  const problems = []
  for (const file of files) {
    const src = readFileSync(join(CLIENT_DIR, file), 'utf8')
    for (const match of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const spec = match[1]
      if (!spec.startsWith('./')) {
        problems.push(`${file} -> ${spec}（越出 /client/ 命名空间，浏览器 404）`)
        continue
      }
      if (!existsSync(join(CLIENT_DIR, spec))) {
        problems.push(`${file} -> ${spec}（目标不存在）`)
      }
    }
  }
  assert.deepEqual(problems, [])
})

test('client 模块图：入口 main.mjs 可被 Node 解析（语法面）', async () => {
  // ESM 语法级解析（不执行 DOM 路径）；import() 失败即语法/解析问题
  await import('../lib/client/logic.mjs')
  await import('../lib/client/care.mjs')
  await import('../lib/client/fusion.mjs')
  await import('../lib/client/usage.mjs')
})
