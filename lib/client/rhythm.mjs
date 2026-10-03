// working 随机插曲节奏器（纯函数，docs/state-machine.md §5-1）。
// working 不是任务指示灯：agent 思考阶段本无任务，由本节奏器在思考陪伴期间随机插入
// 工作插曲（12-30s 随机触发、2.5-6s 随机时长），其余时间保持 think 常态。
// 只做决策不碰 DOM/定时器：宿主（client/main.mjs armWorking）持有 working 状态并在定时器中推进。

/** 插曲间隔（think 常态持续多久后插入一次 working）。 */
export const WORKING_MIN_WAIT_MS = 12000
export const WORKING_MAX_WAIT_MS = 30000
/** 插曲时长（working 一次持续多久后回到 think）。 */
export const WORKING_MIN_DUR_MS = 2500
export const WORKING_MAX_DUR_MS = 6000

/**
 * working 插曲决策（whale-girl 文法：注入随机源，输出可单测）。
 * @param {{ now: number, thinking: boolean, working: { active: boolean, until: number }, random?: () => number }} input
 *   now=当前时刻；thinking=会话思考中（插曲只在该窗口内武装）；
 *   working=当前插曲状态 { active, until }（宿主持有）；random=随机源（测试注入）。
 * @returns {{ active: boolean, until: number }} active=目标是否为 working 激活；
 *   until=宿主应设 setTimeout/在 tick 中推进的目标时刻（now+dur 或 now+wait）。
 *   会话不活跃时返回 { active:false, until:0 }——插曲关闭，等下次思考再武装。
 */
export function nextWorkingRhythm({ now, thinking, working, random = Math.random }) {
  if (thinking !== true) return { active: false, until: 0 }
  if (working?.active) {
    // working 中：随机时长后回到 think。
    const dur = WORKING_MIN_DUR_MS + random() * (WORKING_MAX_DUR_MS - WORKING_MIN_DUR_MS)
    return { active: false, until: now + dur }
  }
  // think 中：随机间隔后插入 working（大部分时间 think，偶尔工作）。
  const wait = WORKING_MIN_WAIT_MS + random() * (WORKING_MAX_WAIT_MS - WORKING_MIN_WAIT_MS)
  return { active: true, until: now + wait }
}
