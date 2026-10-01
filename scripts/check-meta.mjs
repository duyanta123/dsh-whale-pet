// 校验 0.1.7 插件元数据链：exports 放行 locale 子路径、icon 字段、locale 文件格式。
// 宿主 readPluginMeta 语义：resolvePluginResource('dsh-whale-chan/locale/en.json') 经 ESM resolver。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'))
console.log('exports["./locale/*.json"] =', pkg.exports['./locale/*.json'])
console.log('icon =', pkg.icon, '| dsh.manifestVersion =', pkg.dsh.manifestVersion)
for (const lang of ['en', 'zh']) {
  const dict = JSON.parse(readFileSync(root + `locale/${lang}.json`, 'utf8'))
  console.log(`${lang}.json meta.title =`, dict.meta.title)
}

// ESM resolver 端到端：模拟宿主从 profile node_modules 解析包子路径（本包以 link: 软链安装）。
const parentURL = pathToFileURL(root + 'lib/index.mjs').href
const spec = 'dsh-whale-chan/locale/en.json'
const resolved = import.meta.resolve(spec, parentURL)
console.log('resolve(' + spec + ') =', resolved)
