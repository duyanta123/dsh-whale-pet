// 泡泡小游戏纯逻辑（二期功能 ① / phase2-plan §2.1、§7）：4×4 棋盘生成 / tick（泡泡自然消长）/
// 点击结算（普通·星·炸弹 + 连击加成）/ 30s 限时 / 评级 win-draw-lose / game-* 奖励姿势映射 /
// 每日奖励局数读视图。
// 数值与机制自 musume 参考实现（refs/dsh-whale-musume/assets/whale-moe-core.js:251-377）原样适配；
// 评级阈值 300/150 按「炸弹不真扣分」口径调校（musume 源测试 whale-moe-game.test.mjs:35-37 注记）。
// 全部纯函数：now/rng 一律注入参数，零 DOM/零定时器/零 fetch/零导入，node --test 直测（test/game.test.mjs）。
// 降级路径：非法 now / null 状态 / 已结束对局 / 棋盘满 / 脏 blob 一律「不动局面」地安全返回，不抛错。
// 姿势映射（phase2-plan §7，素材仅 game-{happy,lose,think,win,cheat} 五件，game-draw 姿势本库不存在）：
//   playing→game-think / combo→game-happy / bomb→game-cheat / win→game-win / draw→game-happy / lose→game-lose。
// 模块分界（§2.1 blob 所有权）：本模块对 growth blob 只读——gameRewardAllowed 是读视图；
// blob.game{highscore,playsToday,playsDay} 的写入与跨日重置全部由 growth.mjs 的 ingest 维护；
// 本模块只出信号：宿主在结算时把评级/连击/得分转成 game-play / game-win / game-draw / game-lose /
// game-combo（amount=本局 comboMax）/ game-highscore（amount=本局得分）喂 growth.ingest。
// 棋盘 DOM（stage 上叠 4×4 格，泡用字符 🫧/⭐/💣，零新素材）与开局特效（webm/鲸鱼吐泡泡特效.webm once）
// 由集成工程师在 main.mjs 装配（phase2-plan §11 步骤 2）。

/** 游戏数值单源（musume whale-moe-core.js:251-258 原样；phase2-plan §7 全表）。 */
export const GAME = Object.freeze({
  DURATION_MS: 30000,      // 一局时限；remainingMs 归零 → status='ended'
  GRID: 4,                 // 4×4 棋盘（16 格）
  SPAWN_INTERVAL_MS: 500,  // 生成节拍：每间隔至多 1 泡（tick 慢于节拍也只补 1 泡）
  BUBBLE_LIFE_MS: 1600,    // 普通泡自然寿命（自然消长，过期 event kind='expire'）
  STAR_LIFE_MS: 1200,      // 星星泡寿命
  STAR_P: 0.15,            // 星星概率
  BOMB_P: 0.10,            // 炸弹概率（其余为普通泡）
  COMBO_WINDOW_MS: 1200,   // 连击窗口：距上次命中 ≤ 窗口则连击 +1，否则重置为 1
  WIN_SCORE: 300,          // 评级 win 阈值（≥）
  DRAW_SCORE: 150,         // 评级 draw 阈值（≥；其余 lose）
  BASE: 10,                // 普通泡基础分
  STAR_SCORE: 30,          // 星星基础分
  BOMB_SCORE: -20,         // 炸弹 delta：仅作展示返回，不真扣分、清连击不加成（musume 原样）
  COMBO_CAP: 10,           // 连击加成封顶：min(combo, COMBO_CAP) * 2
  REWARDS_PER_DAY: 3,      // 每日发好感奖励的局数上限（跨日重置；重置动作在 growth.mjs）
})

/** 单次 tick 的时限扣减上限（ms）：正常决策节拍 250ms 远够不着；长停顿（标签页隐藏/定时器冻结——
 *  main.mjs 决策 tick 在 document.hidden 时停摆）恢复后的首个 tick 至多扣 2s——时限等效暂停，
 *  不把整段墙钟一口气扣完造成「一局没玩先强结、白耗每日奖励名额」。 */
const TICK_DT_CAP_MS = 2000

/** 时刻规整：Date → ms；非法输入回退 0（gameNewState 用；保证脏数据不抛错）。 */
function normNow(now) {
  if (now instanceof Date) {
    const ms = now.getTime()
    return Number.isNaN(ms) ? 0 : ms
  }
  return typeof now === 'number' && Number.isFinite(now) ? now : 0
}

/** 是否为可用时刻（有限 number 或合法 Date）。gameTick/gamePop 对非法时刻走「不动局面」降级。 */
function isValidTime(now) {
  if (now instanceof Date) return !Number.isNaN(now.getTime())
  return typeof now === 'number' && Number.isFinite(now)
}

/**
 * 本地日期键 'YYYY-M-D'（无前导零，musume dayKey 同款）。
 * 注意：必须与 growth.mjs 的 dayKey 同格式——这是 blob.game.playsDay 的比对基准（跨模块契约点）。
 */
function dayKeyOf(at) {
  const date = at instanceof Date ? at : (Number.isFinite(at) ? new Date(at) : null)
  if (date === null || Number.isNaN(date.getTime())) return null
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/**
 * 开新一局。
 * @param {number|Date} now 当前时刻（注入时钟；非法值回退 0，调用方应传真实时刻）
 * @param {() => number} [rng] 随机源（预留签名，与冻结契约一致；开局棋盘为空，不消耗随机源）
 * @returns {{ board: Array<null|{kind:'bubble'|'star'|'bomb', bornAt:number}>, score:number, combo:number,
 *   comboAt:number, comboMax:number, remainingMs:number, nextSpawnAt:number, lastAt:number, status:'playing' }}
 */
export function gameNewState(now, rng) {
  const t = normNow(now)
  const board = new Array(GAME.GRID * GAME.GRID).fill(null)
  return {
    board,
    score: 0,
    combo: 0,
    comboAt: 0,
    comboMax: 0,
    remainingMs: GAME.DURATION_MS,
    nextSpawnAt: t + GAME.SPAWN_INTERVAL_MS,
    lastAt: t,
    status: 'playing',
  }
}

/**
 * 步进一帧：先结算过期（泡泡自然消长），再按节拍生成（每 tick 至多 1 泡、随机空格、随机种类），
 * 最后按真实时间扣减 remainingMs（单次至多扣 TICK_DT_CAP_MS——长停顿等效暂停；归零 → status='ended'）。
 * @param {object|null} state gameNewState 产出的对局状态（不 mutate 入参）
 * @param {number|Date} now 当前时刻；非法时刻 → 原样返回（降级：不扣时、不生成、不消亡）
 * @param {() => number} [rng] 随机源；缺省 Math.random。每次生成按序消耗两次：先格子、后种类
 * @returns {{ state: object, events: Array<{kind:'expire',cell:number}|{kind:'spawn',cell:number,bubble:string}> }}
 */
export function gameTick(state, now, rng) {
  if (!state || state.status !== 'playing' || !isValidTime(now)) return { state, events: [] }
  const t = normNow(now)
  const lastAt = typeof state.lastAt === 'number' ? state.lastAt : t
  const dt = Math.min(Math.max(0, t - lastAt), TICK_DT_CAP_MS) // 长停顿钳制：单次至多扣 2s（时钟回拨负差值仍钳 0）
  const events = []
  let board = state.board
  let changed = false
  if (Array.isArray(board)) {
    board = board.slice()
    // 过期消亡（自然消长）：寿命按种类取（星短命）；t - bornAt ≥ 寿命即消失。
    for (let i = 0; i < board.length; i += 1) {
      const bubble = board[i]
      if (!bubble) continue
      const life = bubble.kind === 'star' ? GAME.STAR_LIFE_MS : GAME.BUBBLE_LIFE_MS
      if (t - bubble.bornAt >= life) {
        board[i] = null
        changed = true
        events.push({ kind: 'expire', cell: i })
      }
    }
    // 生成：到点且有空格时至多 1 泡——随机空格 + 随机种类（先抽格、后抽种，rng 注入确定性）。
    if (t >= state.nextSpawnAt) {
      const empties = []
      for (let e = 0; e < board.length; e += 1) if (!board[e]) empties.push(e)
      if (empties.length > 0) {
        const random = typeof rng === 'function' ? rng : Math.random
        const cell = empties[Math.floor(random() * empties.length) % empties.length]
        const roll = random()
        const kind = roll < GAME.BOMB_P ? 'bomb' : (roll < GAME.BOMB_P + GAME.STAR_P ? 'star' : 'bubble')
        board[cell] = { kind, bornAt: t }
        changed = true
        events.push({ kind: 'spawn', cell, bubble: kind })
      }
    }
  }
  const remaining = Number.isFinite(state.remainingMs) ? state.remainingMs : GAME.DURATION_MS
  const remainingMs = Math.max(0, remaining - dt)
  const next = {
    ...state,
    board: changed ? board : state.board,
    remainingMs,
    lastAt: t,
    nextSpawnAt: events.some((e) => e.kind === 'spawn') ? t + GAME.SPAWN_INTERVAL_MS : state.nextSpawnAt,
    status: remainingMs <= 0 ? 'ended' : 'playing',
  }
  return { state: next, events }
}

/**
 * 点击结算一格。
 * - 普通/星：delta = 基础分 + 连击加成 min(新连击, COMBO_CAP)*2；连击窗口 1200ms 内 +1、窗外重置为 1。
 * - 炸弹：delta=−20 仅作展示返回，score 不变（评级阈值按此口径调校），清当前连击、不加成、不清纪录。
 * - 空格/越界/已结束/非法时刻：miss（hit=false），局面原样。
 * @param {object|null} state 对局状态
 * @param {number} cell 棋盘格下标（0–15）
 * @param {number|Date} now 当前时刻
 * @returns {{ state: object, hit: boolean, kind: 'bubble'|'star'|'bomb'|null, delta: number, combo: number }}
 */
export function gamePop(state, cell, now) {
  const combo = state && Number.isFinite(state.combo) ? state.combo : 0
  if (!state || state.status !== 'playing' || !isValidTime(now)) {
    return { state, hit: false, kind: null, delta: 0, combo }
  }
  const bubble = Array.isArray(state.board) ? state.board[cell] : null
  if (!bubble) return { state, hit: false, kind: null, delta: 0, combo }
  const t = normNow(now)
  const board = state.board.slice()
  board[cell] = null
  if (bubble.kind === 'bomb') {
    // 炸弹：不真扣分（musume whale-moe-core.js:324-328 原样）；清连击、清窗口锚点、纪录 comboMax 不动。
    return {
      state: { ...state, board, combo: 0, comboAt: 0 },
      hit: true,
      kind: 'bomb',
      delta: GAME.BOMB_SCORE,
      combo: 0,
    }
  }
  const nextCombo = t - state.comboAt <= GAME.COMBO_WINDOW_MS && state.combo > 0 ? state.combo + 1 : 1
  const base = bubble.kind === 'star' ? GAME.STAR_SCORE : GAME.BASE
  const bonus = Math.min(nextCombo, GAME.COMBO_CAP) * 2
  const delta = base + bonus
  const score = (Number.isFinite(state.score) ? state.score : 0) + delta
  const comboMax = Math.max(Number.isFinite(state.comboMax) ? state.comboMax : 0, nextCombo)
  return {
    state: { ...state, board, score, combo: nextCombo, comboAt: t, comboMax },
    hit: true,
    kind: bubble.kind,
    delta,
    combo: nextCombo,
  }
}

/**
 * 评级：≥ WIN_SCORE → 'win'；≥ DRAW_SCORE → 'draw'；其余 → 'lose'。
 * @param {number} score 单局得分
 * @returns {'win'|'draw'|'lose'}
 */
export function gameGrade(score) {
  if (score >= GAME.WIN_SCORE) return 'win'
  if (score >= GAME.DRAW_SCORE) return 'draw'
  return 'lose'
}

/**
 * 结算聚合：{ score, grade, comboMax }（脏状态/null 降级为 0 分 lose）。
 * @param {object|null} state 对局状态
 */
export function gameResult(state) {
  const score = state && Number.isFinite(state.score) ? state.score : 0
  const comboMax = state && Number.isFinite(state.comboMax) ? state.comboMax : 0
  return { score, grade: gameGrade(score), comboMax }
}

/** 游戏阶段 → 素材状态 id 映射（phase2-plan §7 裁定表；draw 复用 happy——无 game-draw 素材）。 */
const POSE_BY_PHASE = Object.freeze({
  playing: 'game-think', // 开局/进行中默认
  combo: 'game-happy',   // 进行中连击 ≥5 达成后保持到连击断（何时传 'combo' 由宿主按 state.combo 判定）
  bomb: 'game-cheat',    // 点中炸弹瞬间（约 1.5s 后回 'playing'）
  win: 'game-win',       // 结算 win
  draw: 'game-happy',    // 结算 draw（平局不气馁，复用 happy）
  lose: 'game-lose',     // 结算 lose
})

/**
 * 奖励姿势映射：游戏阶段 → renderer 素材状态 id（idle 兜底覆盖链最高位，经 idleOverlayVisual 接入）。
 * 未知阶段 / null → null（无姿势覆盖，回正常状态机——对应「结算面板关闭/游戏结束」行）。
 * @param {'playing'|'combo'|'bomb'|'win'|'draw'|'lose'|null} phase 游戏阶段
 * @returns {'game-think'|'game-happy'|'game-cheat'|'game-win'|'game-lose'|null}
 */
export function gamePose(phase) {
  return Object.prototype.hasOwnProperty.call(POSE_BY_PHASE, phase) ? POSE_BY_PHASE[phase] : null
}

/**
 * 每日奖励局数读视图（REWARDS_PER_DAY=3）：blob.game.playsDay 是当日键且 playsToday 已达上限 → false。
 * 只读不写：跨日重置（playsDay 换当日键、playsToday 归零）由 growth.mjs 的 ingest 入口维护；
 * 这里对「playsDay 还是旧日键」直接视为未消耗（凌晨跨日、growth 尚未刷新时也正确放行）。
 * @param {object|null} growthBlob growth 存档 blob（version 1，见 phase2-plan §2.2）
 * @param {number|Date} now 当前时刻
 * @returns {boolean} 本局是否还发好感奖励
 */
export function gameRewardAllowed(growthBlob, now) {
  const game = growthBlob && typeof growthBlob === 'object' ? growthBlob.game : null
  if (!game || typeof game !== 'object') return true // 无成长存档 → 视为未消耗
  const today = dayKeyOf(now)
  if (today === null || game.playsDay !== today) return true // 跨日 / 无法判定当日 → 放行
  const played = Number.isFinite(game.playsToday) ? game.playsToday : 0
  return played < GAME.REWARDS_PER_DAY
}
