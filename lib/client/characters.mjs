// 角色注册表（二期 ⑧）：musume（默认）/ classic 双角色，参数化「素材链主备互换」纯函数。
// 零 DOM / 零定时器 / 零 fetch / 零时钟——swapChains 只吃注入的状态素材映射（assets-manifest.mjs
// 的 STATE_ASSETS 形状：{ [state]: { pick, chain: [{ file, kind, playback, motion }] } }），
// 返回新映射、绝不改入参；同入参同角色经 memo 复用同一结果对象（幂等可重入）。
// 互换规则（即 docs/adding-a-character.md 的 classic 命名规范的同义编码）：某状态链中若存在
// `assets/classic/<状态名>.webp` 精确条目，则该条目提到链首（classic 升主、musume 降备，其余
// 条目保持相对顺序）；链内无对应条目的状态保持原链——night/struggling 链内借用的
// classic/sleep.webp 等非本状态语义条目不算对应件，working 与二期 game-*/festival-*/weather-*
// 等 musume 专属面同样原链不动（classic 套仅覆盖一期 15 基础状态）。
// 语义为「升主即稳」：对已互换结果再次 swap 不再变化（幂等，可随设置热应用反复调用不漂移）；
// 回默认角色走 musume 路径原样返回入参。classic 下基础状态链首变为 classic 文件后，
// bbox.mjs 按实时链首查表自然 miss → 回退 hitzone.mjs 静态热区（characters×bbox 自洽，plan §2.6）。
// 集成接线（plan §11-2）：assets-manifest.mjs 的 setCharacter(id) 以本模块为内核做 memo 化换表。

/** classic 素材目录前缀（对应件识别：<目录><状态名>.webp）。 */
const CLASSIC_DIR = 'assets/classic/'

/**
 * 角色注册表（冻结）：角色 id → 展示信息。musume 为默认角色
 * （settings.character 缺省/脏值一律回落 musume，见 normalizeCharacterId）。
 */
export const CHARACTERS = Object.freeze({
  musume: Object.freeze({ id: 'musume', label: '鲸鱼娘（musume）' }),
  classic: Object.freeze({ id: 'classic', label: '经典小鱼干（classic）' }),
})

/**
 * 角色 id 归一化：仅 'classic' 原样通过，其余（含脏数据/非字符串/大小写不符）一律回默认
 * 'musume'。与 settings.mjs 对 character 分区的逐字段纠正同语义（plan §9）。
 * @param {unknown} v 任意输入（设置项原值）
 * @returns {'musume'|'classic'}
 */
export function normalizeCharacterId(v) {
  return v === 'classic' ? 'classic' : 'musume'
}

/** swapChains memo：入参映射引用 → classic 互换结果（musume 路径直接原样返回，无需缓存）。 */
const swapMemo = new WeakMap()

/**
 * 参数化链序主备互换（纯函数）。
 * - characterId 归一化后非 'classic'（musume/脏值）→ 原样返回入参（同一引用，零拷贝）。
 * - 'classic' → 逐状态检查链中是否存在 `assets/classic/<状态名>.webp` 精确条目：
 *   存在且不在链首 → 该条目整体移到链首（entry 对象原引用保留，其余条目相对顺序不变）；
 *   不存在或已在链首 → 该状态沿用入参 def 原引用（原链原样）。
 * 返回全新顶层映射（冻结；互换状态的 def/chain 亦冻结，未互换状态与入参共享引用）。
 * 入参视为不可变：同一 stateAssets 引用的 classic 结果经 WeakMap memo 复用。
 * 注意：pick:'random' 的视频插曲链（working）如未来加入 classic 对应件，升主会把 image 提到
 * 视频池之前、改变 resolveStateChain 的随机池语义——现状无此场景（working 无 classic 条目），
 * 本函数按统一规则升主并在测试中固化行为，若要支持需先明确随机池语义。
 * @param {Record<string, {pick: string, chain: Array<{file: string, [k: string]: unknown}>}>} stateAssets 状态素材映射（不修改）
 * @param {unknown} characterId 角色 id（脏值按 normalizeCharacterId 归一）
 * @returns {Record<string, {pick, chain}>} musume/脏值 → 入参原样；classic → 互换后的新映射
 */
export function swapChains(stateAssets, characterId) {
  if (normalizeCharacterId(characterId) !== 'classic') return stateAssets
  // 非对象入参（null/标量）原样退回，不进 memo（WeakMap 键须为对象）。
  if (stateAssets === null || typeof stateAssets !== 'object') return stateAssets
  const memoHit = swapMemo.get(stateAssets)
  if (memoHit) return memoHit
  const swapped = {}
  for (const [state, def] of Object.entries(stateAssets)) {
    const chain = Array.isArray(def?.chain) ? def.chain : []
    // 仅认 assets/classic/<状态名>.webp 精确条目为对应件（<语义> 对齐状态键）；
    // 近名条目（classic/<状态名>-x.webp）与链内借用件（night 链的 classic/sleep.webp）不触发互换。
    const at = chain.findIndex((entry) => entry?.file === `${CLASSIC_DIR}${state}.webp`)
    if (at <= 0) {
      // 无对应件（at === -1）或已在链首（at === 0）：原 def 原引用，天然幂等。
      swapped[state] = def
      continue
    }
    const nextChain = Object.freeze([chain[at], ...chain.slice(0, at), ...chain.slice(at + 1)])
    swapped[state] = Object.freeze({ ...def, chain: nextChain })
  }
  const result = Object.freeze(swapped)
  swapMemo.set(stateAssets, result)
  return result
}
