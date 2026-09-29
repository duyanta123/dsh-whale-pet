# 鲸鱼娘桌宠 · 状态机（唯一权威）

> 本文件是 `lib/client/logic.mjs` 的实现规格：状态集合、优先级行序、触发条件与窗口时长、
> 负面情绪保护、交互醒觉规则全部以本文为准。改状态先改本文，再改代码与素材契约
> （`docs/sprites-spec.md`），`test/logic.test.mjs` 按本文行序覆盖。
> 宿主基线 DSH 0.1.7-rc.2；事件名以 0.1.7 为准（`agent/created`，禁用 `agent/session-start`）。

## 1. 双端分工

- **Node half（事实）**：把 agent 事件翻译成**事实窗口** `{ name, until }`（绝对截止时间，
  非消费式快照），经 `/api/whale-pet/state`（轮询兜底）与 `/api/whale-pet/events`（SSE 即时）下发。
- **client half（选择 + 渲染）**：`STATE_TABLE` 声明表遍历首个命中即返回；本地交互
  （拖拽/喂食/转身/睡觉）由 client 自持，窗口结束后重算底层派生状态，不硬编码回 idle。

## 2. 状态集合（15 agent 状态 + 3 热区反应）

| 状态 | 含义 | 素材主链（详见 sprites-spec） |
|---|---|---|
| idle | 兜底待机 | musume/state-idle-cute → classic/idle |
| think | 会话思考陪伴常态 | musume/state-thinking → classic/think |
| working | 随机工作插曲（非任务指示灯） | webm/偷吃Token·东张西望·工作摸鱼 → musume/work-debug |
| celebrate | 任务完成/升级庆祝 | musume/work-celebrate + classic/celebrate → musume/game-win |
| error | 请求错误惊吓（4s） | musume/state-angry → classic/error |
| disappointed | 失败失落尾段（6s） | musume/state-meme-cry → classic/disappointed |
| welcome | 新会话欢迎（6s） | classic/welcome → musume/daily-done |
| wait | 等待用户审批（持续） | musume/state-waiting → classic/wait |
| sleep | 空闲 ≥60s 入睡 | musume/work-sleep → classic/sleep |
| wake | 睡醒过渡（3s，once） | classic/wake → webm/睡眼惺忪 |
| eat | 喂食瞬发（once） | webm/吃小鱼干 → musume/state-eat → classic/eat |
| play | 玩耍瞬发（once） | classic/play → musume/daily-stretch |
| joy | 点赞/夸夸短喜（1.6s） | classic/joy → musume/meme-heart |
| drag | 被拖拽悬空 | webm/被鼠标拖拽悬空反馈 → musume/react-* → classic/drag |
| walk | 周期散步 | classic/walk → webm/螃蟹走路 |
| react-head/belly/tail | 分区热区点击反应（M2） | musume/state-react-{head,belly,tail} |

## 3. 优先级行序（STATE_TABLE，首个命中即返回）

```
R1  drag            本地拖拽按住
R2  idle(放下缓冲)   drag 松手后 1.5s 内（睡着被拖起让位 wake：transient==='wake' 时不吃缓冲）
R3  事件 burst       Node 事实窗口 {name≠idle, until>now}，resolve=name
                    （welcome / celebrate / error / disappointed）
R4  eat 瞬发         本地 transient==='eat'
R5  play 瞬发        本地 transient==='play'
R5.5 热区反应       本地 react（'head'|'belly'|'tail'，~2.2s 瞬发；低于投喂瞬发）
R6  wake 过渡        本地 transient==='wake'
R7  wait 等审批      Node 事实窗口 name==='wait'（持续到解除）
R8  celebrate 回合   本地 celebrateUntil（session running→false 边沿，6s）
R9  working 插曲     节奏器 workingActive（12-30s 随机触发，2.5-6s 随机时长）
R10 think 常态      Node 事实 thinking（任一会话 turn 活跃）
R11 joy             本地 joyUntil（1.6s）
R12 sleep           本地 sleeping（空闲 ≥60s）
R13 walk            本地 walking（18-40s 随机间隔）
R14 idle 兜底       恒真
```

行序即优先级：**事件反馈 > 用户交互反馈（burst/eat/play） > wake > wait（需用户注意） >
回合庆祝 > working 插曲 > 陪伴（think） > 情绪（joy） > 生理（sleep） > 漫游（walk） > idle**。

## 4. 事实窗口时长（Node half）

| 事实 | 时长 | 来源事件 |
|---|---|---|
| welcome | 6s | `agent/created`（source=startup 新会话；resume 只 +XP 不欢迎） |
| celebrate | 6s | 任务完成（jobs events `settled` 且 status==='completed'，cause==='teardown' 除外）；升级/称号解锁复用 |
| error | 4s | `agent/request-error`（LLM 抖动，零负反馈：不计失败不写回忆） |
| disappointed | 6s（紧随 error 尾段） | 同上/任务失败（status==='failed'） |
| wait | 持续到解除 | turn/end reason 为 blocked（等待审批/权限），新回合开始即清除 |
| thinking | 持续 | turn/start…turn/end 之间（任一会话） |

窗口级联（Node 侧，负面优先）：`error > disappointed > welcome`——welcome 不打断进行中的
error/disappointed 尾段（失败失落不该被新会话欢迎盖掉）；并发完成不覆盖失败（error 窗口独立兜底）。

## 5. 细节规则

1. **working 不是任务指示灯**：agent 思考阶段无任务，由 client 节奏器随机插入工作插曲
   （`nextWorkingRhythm`：12-30s 随机触发、2.5-6s 随机时长），大部分时间保持 think 沉思。
   决策为纯函数（注入随机源，可单测）。
2. **负面情绪保护**：`error(4s) → disappointed(6s)` 总 10s 负面窗口；期间 welcome/celebrate
   不覆盖（Node 级联 + R3 burst resolve 权威）；同一窗口内多次错误取 max 延长、不叠加缩短。
3. **交互醒觉**：拖拽/喂食/玩耍/热区点击都重置空闲计时（交互后从交互时刻重新起算 60s）；
   仅当交互瞬间宠物**视觉上**处于 sleep 动画（`animState==='sleep'`）才播 wake 过渡
   （`wakeFromInteraction`）——会话活跃时视觉已离开 sleep 但 sleeping 标志仍 true，此时不播。
4. **放下缓冲**：drag 松手 1.5s 内保持 idle（避免放下即跳 think/working 的生硬切换）；
   睡着被拖起让位 wake（R2 排除 transient==='wake'）。
5. **随机转身**：静态陪伴态（idle/think/wait）每 10-25s 随机 flip 转身（`nextFacingAt`）；
   walk/drag 的方向写入朝向后，静态态沿用不无谓翻转。素材统一**朝左基准**，`flip=±1` 镜像。
6. **回合完成边沿**：session running true→false 翻转（client 本地检测）→ 6s celebrate 本地窗口，
   与 Node 任务完成 celebrate 并列、优先级更低（R8 < R3/R7）。
7. **零负反馈**：请求错误不计数不惩罚；失败任务只计 `stats.failures` 不扣 XP（养成系统语义，
   状态机只表达情绪）。
8. **多实例快照语义**：事实窗口按会话聚合（任一会话活跃即 thinking；wait 以当前待审批集合非空为准），
   不做跨会话单例缓存（0.1.6-alpha.2 多实例语义）。

## 6. 节奏参数（代码级常量，不可配置——L2 语义层）

| 参数 | 值 |
|---|---|
| WELCOME_MS / CELEBRATE_MS | 6000 |
| ERROR_MS / DISAPPOINTED_MS | 4000 / 6000 |
| DRAG_RELEASE_MS | 1500 |
| WAKE_MS | 3000 |
| TRANSIENT_MS（eat/play） | 3000 |
| JOY_MS | 1600 |
| IDLE_SLEEP_MS | 60000 |
| WORKING 插曲间隔 | 12000–30000ms |
| WORKING 插曲时长 | 2500–6000ms |
| 转身间隔 | 10000–25000ms |
| WALK 间隔 | 18000–40000ms |
| WALK 时长 | 4000–8000ms |
