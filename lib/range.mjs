// HTTP Range 请求头解析（RFC 7233 单区间；纯函数，node --test 覆盖 test/range.test.mjs）。
// 契约：
// - 返回 { start, end }（闭区间）＝可服务区间，调用方直接 206；
// - 返回 null ＝无 Range 头或语法非法，调用方回退 200 全量（RFC 允许忽略 Range）；
// - 语法合法但不可满足（起点越界 / bytes=-0 / end<start）也返回对象，由调用方按
//   start > end || start >= size 判 416——本函数不替调用方做响应决策。
// 陷阱备忘：Number('') === 0，开放端（'bytes=0-'）绝不能走 Number 空串路径。

/**
 * @param {string|undefined} header req.headers.range
 * @param {number} size 资源总字节数
 * @returns {{ start: number, end: number } | null}
 */
export function parseByteRange(header, size) {
  if (typeof header !== 'string') return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (m === null) return null // 多区间/非法单位/带空格 → 忽略，回 200 全量
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null // "bytes=-" 语法非法
  if (rawStart === '') {
    // 后缀区间 bytes=-N：取末尾 N 字节；N=0 不可满足（start>end → 调用方 416）。
    const n = Number(rawEnd)
    return { start: n === 0 ? size : Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(rawStart)
  // 开放端 bytes=N-：到文件尾；显式端 bytes=N-M：M 超界钳到 size-1（M<N 时由调用方 416）。
  return { start, end: rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1) }
}
