# 鲸鱼娘桌宠 · 二期功能集成方案（phase2-plan）

> 编制：2026-10-02（方案规划师）。范围 = 《鲸鱼娘桌宠-开发计划.md》§4 Backlog 中的**八个可落地功能**；
> Live2D 路线与 Tauri 桌面伴侣壳为范围外（§13 说明）。
> **r2 修订（2026-10-02，评审后）**：§2.2/§2.3/§2.6/§9/§10.3/§10.4/§11/§14 按评审 blockers 1–3 与 risks/missing 逐条修订——
> 新增 apiKey 三态回传语义（§9/§10.3）、bbox 并行期自包含映射（§2.6）、idleOverlayVisual 增 balanceLow 通道（§2.3/§14）、
> client-graph 白名单断言撤回（§11，实测门禁现状即通过）。
> **r3 修订（2026-10-02，评审后）**：§2.2 counters 补游戏四字段 `gamePlays/gameWins/gameComboMax/gameHighscoreBreaks`
> 及 game-combo/game-highscore 的 ingest amount 语义（成就 #31–#34 谓词落点，r2 遗漏）；§2.6 链首解析改三段口径
> （一期 9 键实时 resolveStateChain / react 3 键 REACT_ASSETS——resolveStateChain 对 react 会头像回落，已核实
> assets-manifest.mjs:74-76 / 二期 15 键冻结映射）并规格化 **characters×bbox 自洽**（classic 角色链首 miss → 回退
> 静态热区，§2.6/§2.8/§11/§14）；§11 balance-low 气泡显式 ms:8000 与 balanceLowUntil 同值（气泡默认 5s，bubble.mjs:12）。
> **r4 修订（2026-10-02，修复工程师评审复核后）**：§12 补记第 4 点——「未知/缺码 weathercode + tempC≤0」
> 组合取 §6 口径（§2.4 与 §6 在该边界语义分裂，实现取 §6，test/weather.test.mjs 专项用例钉住）。
> 一期事实基线：仓库根 `D:/桌宠/whale-pet`（npm 包 `dsh-whale-chan@0.1.0`，Node 22.21），
> 本方案编制当日实测 `node --test "test/*.test.mjs"` **122/122 绿**。
> 本文是集成规格：新增模块作者按 §2–§9 实现，接线只由集成工程师按 §11 三步清单落；
> 全部决策均注明出处（文件:行 或 生成/实测命令）。

## 0. 红线与架构约定（全部沿用一期，逐条自查）

| 红线 | 二期落法 |
|---|---|
| 深夜静音段（`lib/client/care.mjs:31` `isNightMute`，主动推送静默） | 新功能分类：**主动推送**仅 balance-low 提醒（默认关 + 深夜段连轮询都暂停）；游戏/签到/成就解锁均为**用户操作触发的被动反馈**，深夜不受限；festival/weather/characters 是**视觉面**（同状态镜像语义，深夜不受限）。idle 兜底视觉链见 §2.3。 |
| 隐私/强主动项默认关 | `balanceLow.enabled` 默认 **false**（§9）；apiKey 不写日志、设置 GET 脱敏（§11 步骤 1）。 |
| 全部定时器/DOM/事件挂 dispose、幂等可重入 | game 棋盘 DOM、balance/weather 轮询定时器、meme 探测定时器全部进 `main.mjs` 的 timers/disposers 体系（`lib/client/main.mjs:62-76,559-573` 同款）；growth 存储适配器由 dispose flush。 |
| 素材缺失走降级链（占位头像兜底） | 新素材全部走 `assets-manifest.mjs` 链语义（缺失 → 链内次选 → `assets/classic/avatar.png`，`lib/client/assets-manifest.mjs:61`）；meme CDN 探测失败回退本地 30 张。 |
| 零 `@deepseek-ai` 导入；client 不外联（数据走 `/api/whale-pet/*` 代理） | weather/balance 全部经宿主路由代理；**唯一例外**：表情包 Supabase 公开桶 client 直链（详案 §2.4 明示，`meme-cdn.enabled` 可关）。 |
| 固定契约分工 | §2–§10 的 8 个新模块 + 8 个 test 文件由模块作者实现；`lib/index.mjs`、`settings.mjs`、`assets-manifest.mjs`、`main.mjs`、共享门禁（manifest/client-graph）与全部文档只由集成工程师改（§11）。**归属特例**：第 9 个测试文件 `test/settings-phase2.test.mjs` 测的是集成工程师独有的 settings.mjs 改动，归**集成工程师所有**（§9/§14），模块作者不碰。 |
| 并行期可落地图（8 人并行不互相阻塞） | 8 个新模块只允许 import **一期已存在**的导出（如 `assets-manifest.mjs` 的 `resolveStateChain`/`STATE_ASSETS` 现存导出）与同批新模块；任何对**集成工程师待建导出**（`EXTRA_STATE_ASSETS`/`setCharacter` 等）的依赖一律禁止——ESM 链接期缺导出即 SyntaxError，会挂死并行模块的加载与测试。bbox 的具体过渡口径见 §2.6。 |

## 1. 功能清单（8 项）与新文件总览

| # | 功能 id | 新模块（lib/client/） | 对应测试（test/） | 主要素材（已在库，本方案已逐一盘点核实） |
|---|---|---|---|---|
| 1 | game | `game.mjs` | `game.test.mjs` | `musume/dsh-whale-state-game-{happy,lose,think,win,cheat}.webp`、`webm/鲸鱼吐泡泡特效.webm` |
| 2 | growth | `growth.mjs` | `growth.test.mjs` | （气泡文案复用，无新素材） |
| 3 | festival | `festival.mjs` | `festival.test.mjs` | `musume/dsh-whale-state-festival-{spring,christmas,halloween,mid-autumn}.webp` |
| 4 | weather | `weather.mjs` | `weather.test.mjs` | `musume/dsh-whale-state-weather-{rain-happy,snow,thunder,umbrella,cold}.webp` |
| 5 | balance-low | `balance-low.mjs` | `balance-low.test.mjs` | `musume/dsh-whale-state-balance-low.webp` |
| 6 | bbox | `bbox.mjs` + `bbox-table.json`（生成物，已产出） | `bbox.test.mjs` | 表覆盖 `assets/musume/*.webp` 全部 92 张；**自包含**：不依赖集成工程师待建导出（§2.6） |
| 7 | meme-cdn | `meme-catalog.mjs` | `meme-catalog.test.mjs` | Supabase CDN 474 张（热链）+ 本地 `assets/memes/meme-001..030.webp` 兜底 |
| 8 | characters | `characters.mjs` | `characters.test.mjs` | musume 92 张 ↔ classic 15 张主备互换 |

新模块统一约定：ESM、零 DOM/零定时器/零 fetch（meme-catalog 的 fetch 注入除外）、`now`/`rng`/`fetch` 一律注入参数、中文注释头沿用现有风格（参照 `lib/client/care.mjs:1-4`）；相对导入一律 `./` 前缀（client-graph 门禁，`test/client-graph.test.mjs`）。工具：`tools/analyze-bbox.py`（已创建并实际运行）。

## 2. ① 模块 API（导出名 / 签名 / 纯函数边界）

### 2.1 `game.mjs` — 泡泡小游戏纯逻辑

数值与机制从 musume `assets/whale-moe-core.js:251-357` 原样适配（读源码核实，数值见 §7）。

```js
export const GAME                 // 冻结常量：DURATION_MS/GRID/SPAWN_INTERVAL_MS/BUBBLE_LIFE_MS/
                                  //   STAR_LIFE_MS/STAR_P/BOMB_P/COMBO_WINDOW_MS/WIN_SCORE/DRAW_SCORE/
                                  //   BASE/STAR_SCORE/BOMB_SCORE/COMBO_CAP/REWARDS_PER_DAY（§7 全表）
export function gameNewState(now, rng)          // → { board(4×4=null), score, combo, comboAt, comboMax,
                                                //    remainingMs, nextSpawnAt, lastAt, status:'playing' }
export function gameTick(state, now, rng)       // → { state, events[] }（expire/spawn；每间隔至多 1 泡、
                                                //    随机空格、自然消亡=泡泡自然消长）
export function gamePop(state, cell, now)       // → { state, hit, kind:'bubble'|'star'|'bomb', delta, combo }
                                                //    （炸弹 delta=−20 仅作展示、score 不变，清连击不加成——musume 原样；
                                                //      连击窗口 1200ms；加成 min(combo,CAP)*2）
export function gameGrade(score)                // → 'win'|'draw'|'lose'（≥300 / ≥150 / 其余）
export function gameResult(state)               // → { score, grade, comboMax }
export function gamePose(phase)                 // → 素材状态 id（§7 姿势映射表）
export function gameRewardAllowed(growthBlob, now) // 每日奖励局数上限（REWARDS_PER_DAY=3，跨日重置）
```

纯函数边界：全部接收 `now`/`rng`，不碰 DOM/定时器。**blob 所有权**：game 模块对 growth blob **只读**——`gameRewardAllowed(growthBlob, now)` 是读视图；`blob.game`（highscore/playsToday/playsDay）的全部写入与跨日重置（playsDay 换当日键、playsToday 归零）**由 growth.mjs 在 `ingest({metric:'game-play'|'game-highscore', ...})` 内维护**（§2.2/§4.3），game 模块作者不得直写 blob——两个模块的分界：game 出事件信号，growth 管全部持久化状态。棋盘 DOM（stage 上叠 4×4 格按钮，气泡/星/炸弹用字符 🫧/⭐/💣，零新素材）与开局特效（`webm/鲸鱼吐泡泡特效.webm`，once 播放）由集成工程师在 main.mjs 装配（§11 步骤 2）。结算时宿主调 `growth.ingest({metric:'game-play'|'game-win'|'game-draw'|'game-lose', ...})`（§4）。

### 2.2 `growth.mjs` — 39 成就 + 每日任务（3 槽）+ 每周签到（7 天）

```js
export const ACHIEVEMENTS            // 冻结 39 条 { id, icon, name, desc, test(blob, pet), reward:{affinity} }（§3 全表）
export const QUEST_POOL              // 冻结 6 条 { id, desc, metric, target, reward:{affinity}, always? }（§4.1）
export const AFFINITY_MAX = 10000    // 好感上限（musume whale-moe-core.js:476 同款）
export const LEVEL_STEP = 500        // 好感等级步长（同源 whale-moe-core.js:477）
export function affinityLevel(affinity)          // → max(1, floor(affinity/500)+1)
export function refreshQuests(prev, now, rng)    // 当日幂等：同日原样返回；跨日重抽 2 槽（signin-1 恒占 1 槽，
                                                 //   尽量避开昨日 picks；musume whale-moe-core.js:628-649 同款）
export function computeQuests(prev, signal, now) // ingest 单信号推进：命中槽 progress=min(target,+amount)
export function claimQuest(quests, id)           // 单次幂等领取；3/3 → newlyAll 边沿
export function weekKey(now)                     // 周一基准键 'YYYY-M-D'（musume whale-moe-core.js:691-696 同款）
export function computeWeekSignin(prev, now)     // 7 格签到板：days 集合 + 里程碑 1/3/7 各自动触发一次，
                                                 //   跨周整体重置（musume whale-moe-core.js:698-714 同款）
export function signinDaily(blob, now)           // 每日签到：当日幂等；连续日 streak+1，断签回 1
export function evaluateAchievements(blob, pet, now) // 幂等解锁：返回新解锁 id 数组（have 集合去重）；
                                                 // 第三参 now 必传——成就 #13–#15（day1/7/30）谓词需要
                                                 // 当前时刻（now − pet.stats.firstSeenAt），与 §1「now 一律
                                                 // 注入」约定一致（r2 修订：补签名，避免实现自行偏离冻结签名）
export function createGrowth({ storage, now, random }) // 组装层（唯一有副作用的导出）：
  // storage = { load(): blob|null, save(blob): void } 注入；main.mjs 默认接 localStorage
  //（key 'whale-pet-growth-v1'，musume 同款 client 本地持久化；typeof localStorage 守卫，缺席退内存态）。
  // 返回 { ingest({metric, amount}), signin(now), claimQuest(id), snapshot(), dispose() }
```

**指标喂入契约**：`ingest({ metric, amount })` 单一入口。metric 集合：`pat/belly/tail/feed`（本地热区与喂食事件）、`signin`（由 `signinDaily` 内部同步喂给 `computeQuests` 推进 signin-1 槽——外部无需也不应重复喂）、`game-play`（amount=1 → `counters.gamePlays`+blob.game 计数/每日 3 局上限）、`game-win`（amount=1 → `counters.gameWins`；评级 win ⇔ 单局得分 ≥ 300，与 musume #32「单局戳泡泡得分达到 300」等价）、`game-draw/game-lose`（amount=1，仅结算记录）、`game-combo`（**amount=本局 comboMax** → `counters.gameComboMax = max(旧值, amount)`，max 语义由 growth 维护）、`game-highscore`（**amount=本局得分** → growth 内判定 `amount > blob.game.highscore` 则更新 highscore 并 `counters.gameHighscoreBreaks += 1`——**破纪录边沿判定在 growth 内**，game 模块只发信号无需读 blob）、`meme`（表情包气泡弹出）、`balance-alert`（余额提醒命中）、`night-interact`（深夜段本地交互）、`night-work`（深夜段 thinking 边沿）、`comeback`（离开 ≥2h 回归）、`task/failure/session/activeMin/level/day`（main.mjs 对 `/api/whale-pet/state` 的 `pet` 快照做**差分**换算后喂入——`pet.stats.{tasksDone,failures,sessions,activeMs}`/`level`/`firstSeenAt` 来自 Node 账本 `lib/pet-state.mjs:10-17`，快照经 `lib/index.mjs:355-361` 的 `snapshot().pet` 下发，本方案已核实）。任务领取边沿不设独立 metric：`claimQuest` 成功即内部累计 `counters.questsClaimed`，三槽全清边沿累计 `counters.questAllDays`（成就 #35/#36 的谓词落点，r2 补定义）。

**存储 blob 形状**（JSON blob，version 1）：`{ version, affinity, achievements[], counters{pat,belly,tail,feed,gamePlays,gameWins,gameComboMax,gameHighscoreBreaks,meme,balanceAlert,nightInteracts,nightWorks,comebacks,questsClaimed,questAllDays}, signin{lastDate,streak}, quests{date,slots[3],allClaimed}, weekSignin{week,days[],rewarded1,rewarded3,rewarded7}, game{highscore,playsToday,playsDay}, updatedAt }`（r3：counters 补游戏四字段 `gamePlays/gameWins/gameComboMax/gameHighscoreBreaks`——成就 #31–#34 的谓词落点，evaluateAchievements 是无状态读 blob 的纯函数，承载字段缺一谓词即不可测）。**blob 唯一写方 = growth.mjs**（game/bbox 等模块只读；跨日重置——playsToday/playsDay 换键、quests date、weekSignin week——全部在 growth 的 ingest/signin 入口内按 dayKey/weekKey 比对触发，§4.3）。成就/签到/任务的三套状态机细节见 §3/§4。

### 2.3 `festival.mjs` — 节日换装纯函数 + idle 兜底覆盖合成

```js
export function festivalOf(date)      // Date|number|'YYYY-MM-DD' → { id:'spring'|'christmas'|'halloween'|'mid-autumn',
                                      //   label } | null；公历节日直判（10-31/12-25），农历查表（§5），表外 null
export const FESTIVAL_LUNAR_TABLE     // 冻结查表（§5，注释注明来源）
export function idleOverlayVisual(next, opts)  // idle 兜底视觉覆盖合成（纯函数，单测在 festival.test.mjs）：
  // next!=='idle' → 原样返回（不覆盖交互/镜像态——固定契约原文）
  // 优先级：gamePose（游戏会话中）> night（深夜兜底，沿用 care.mjs nightVisualState 语义）>
  //         balanceLowPose（余额提醒伴随姿势，r2 增补通道）> festival > weather > idle
  // opts = { nightMute, gamePose, balanceLowPose, festivalId, weatherId }；
  //   输出素材状态 id（'night'/'balance-low'/'festival-*'/'weather-*'）
  // balanceLowPose 说明：余额提醒只在非深夜触发（提醒面深夜静默），故与 night 实际互斥、
  //   排其后者不影响任何可达序列；且 festival > weather 的固定契约序在它之下保持不变。
```

要点：一期 `care.mjs:175` 的 `nightVisualState` **不修改**，main.mjs 调用点（`lib/client/main.mjs:480`）换成 `idleOverlayVisual`（§11 步骤 2）；`gamePose > night` 的理由是游戏会话属用户主动交互（被动反馈面），深夜红线只约束主动推送——如评审倾向保守可对调这两级（裁量点，§12）。

### 2.4 `weather.mjs` — 天气纯函数

```js
export function buildGeocodingUrl(city)   // → 'https://geocoding-api.open-meteo.com/v1/search?name=<encodeURIComponent(city)>'
                                          //   +'&count=1&language=zh&format=json'（无密钥，支持中文城市）
export function buildForecastUrl(lat, lon)// → 'https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..'
                                          //   +'&current=weather_code,temperature_2m&timezone=auto'
export const WEATHER_CODE_MAP             // weathercode（字符串键）→ id 冻结映射（§6 全表）
export function resolveWeatherId({ code, tempC }) // → 'clear'|'rain'|'snow'|'thunder'|'umbrella'|'cold'
                                          // 优先级：thunder > snow > rain > umbrella > cold(tempC≤0) > clear；
                                          //   未知/缺码 → 'clear'（=不换装）
export const WEATHER_POLL_MS = 30 * 60_000 // client 拉取 /api/whale-pet/weather 的节拍常量
```

纯函数边界：URL 组装与 code→id 映射零 IO；Node half 代理与 client 轮询定时器在 §11 步骤 1/2。`'umbrella'` 是对固定契约 5-id 集合的**有理由补充**（偏离说明见 §12-②）。

### 2.5 `balance-low.mjs` — 阈值判定 + 轮询节拍 + 提醒去重

```js
export const BALANCE_POLL_MS = 10 * 60_000        // 约 10 分钟（固定契约口径）
export const BALANCE_BACKOFF_MAX_MS = 60 * 60_000 // 失败退避封顶
export function nextPollAt(now, { ok, failStreak }) // 成功→now+10min；失败→now+10min×2^failStreak 封顶 60min；
                                                    //   成功即复位 failStreak
export function parseBalancePayload(payload)      // DeepSeek /user/balance 响应（{is_available, balance_infos:
                                                  //   [{currency, total_balance, ...}]}）→ { ok, currency, amount }
                                                  //   优先取 CNY 条目（musume pickBalanceAccount 语义，
                                                  //   whale-moe-core.js:143-151）；坏载荷 → { ok:false }
export function balanceLowDecision({ amount, thresholdCNY, alertedLow })
  // → { alert, alertedLow, tier }：low = amount < thresholdCNY；
  //   low && !alertedLow → alert=true, alertedLow=true（同一水位只提醒一次）；
  //   !low → alertedLow=false（水位回升重置，再次跌破可再提醒）；amount 无效 → 不提醒不重置
```

阈值 tier 分档文案沿用 musume `BALANCE_TIERS`（whale-moe-core.js:130-141：empty/critical/low/ok/good/rich）仅作气泡文案选择，判定只看 thresholdCNY。默认关由设置层落实（`balanceLow.enabled:false`，§9）；轮询与提醒双重深夜门控（`isNightMute` 命中 → 本轮跳过轮询，醒来自然恢复）。

### 2.6 `bbox.mjs` — 逐状态 bbox 热区解析

决策依据：refs/whale-girl `decisions/implemented/bug-fix/2026-08-09-hitarea-follows-state.md`（已通读）——热区跟随当前状态、逐状态 bbox 取代全状态并集、**只取首帧**、热区按内容实际位置对齐（flip 镜像）、click 在 bbox 外不可交互（walk 宽幅状态把并集撑大是原始动机）。

```js
import table from './bbox-table.json' with { type: 'json' }   // 生成物已入库（本方案当日实际生成）
export const BBOX_TABLE_VERSION     // = 1（表 _meta.version）
export const BBOX_STATE_FILES       // 冻结 27 键映射 state → assets/musume 文件 basename：
                                    //   一期 9（think/wait/celebrate/error/disappointed/sleep/night/struggling/idle）
                                    //   + react 3（react-head/belly/tail，实际文件名 dsh-whale-state-react-*.webp）
                                    //   + 二期 15（§8 覆盖清单第 3 行）。
                                    //   【r2 并行期口径 / r3 细化】自带该映射、**不 import assets-manifest 的新导出**
                                    //   （EXTRA_STATE_ASSETS 尚不存在，具名导入缺导出 = ESM 链接期 SyntaxError，
                                    //   模块会连加载都失败）。运行时链首解析分三段（防 characters×bbox 错位，见下）：
                                    //   ① 一期 9 键 → 读现存导出 resolveStateChain(state)[0].file 的 basename
                                    //      （实时链首：musume 角色下 === 本表键；classic 角色下变 classic 文件 →
                                    //      不在 bbox-table → null → 回退静态热区，**热区随显示素材几何自洽**）；
                                    //   ② react 3 键 → 读现存导出 REACT_ASSETS[zone][0].file（**不可用
                                    //      resolveStateChain**——react-* 不在 STATE_ASSETS，会走 `if (!def)
                                    //      return [img(AVATAR)]` 头像回落（assets-manifest.mjs:74-76，已核实），
                                    //      按字面实现 react bbox 恒 null）；react 无 classic 对应件，实时链首恒
                                    //      musume，与本表键一致；
                                    //   ③ 二期 15 键 → 用本冻结映射查表（classic 套无对应件，链首恒 musume）。
                                    //   本表同时是漂移守卫基线：集成工程师落地 EXTRA_STATE_ASSETS 时在
                                    //   test/manifest.test.mjs 增断言「EXTRA 链首 file === BBOX_STATE_FILES
                                    //   对应键；且默认角色下 resolveStateChain/REACT_ASSETS 实时链首 === 本表
                                    //   对应键」（§11 步骤 2.1）——防止「按 state id 推导文件名」的无守卫双源
                                    //   （weather-rain→weather-rain-happy 这类例外映射必须显式成表）。
export function resolveBBox(state, { chainHeadFile } = {})
                                    // state → 链首 basename（①/② 实时解析；③ 冻结映射；测试可注入
                                    //   chainHeadFile 覆盖实时解析——classic 角色用例由此构造）→ 查表归一化
                                    //   bbox {x0,y0,x1,y1} | null（链首不在表/未知状态/全透明 → null）
export function bboxHit(nx, ny, state, { flip = 1 })
  // 有表状态：flip===-1 时先镜像 x（x←1−x，§8 flip 语义），夹取 [0,1]；
  //   点在 bbox 外 → null（宿主不触发热区反应——消除「空白可点」，whale-girl 决策核心收益）；
  //   点在 bbox 内 → 按矩形高度三段分区（相对 y ≤0.45 head / ≤0.78 belly / 其余 tail，
  //   比例沿用 hitzone.mjs 静态 full 表 lib/client/hitzone.mjs:7-11）→ 'head'|'belly'|'tail'
  // 无表状态：回退 hitzone.mjs 现有静态表（hitZone(nx,ny,'full')，恒返回三区之一）；
  //   不修改 hitzone.mjs（固定契约原文）
```

生成工具 `tools/analyze-bbox.py`（本方案已创建）：PIL 逐张扫 `assets/musume/*.webp` **首帧**（`im.seek(0)`）`alpha ≥ 8` 不透明像素 bbox → 归一化 [0,1]（4 位小数）→ `lib/client/bbox-table.json`（`_meta` 记录工具/阈值/首帧口径）。支持 `--check`（现表与扫描结果比对，供 CI）。**本方案编制时已实际运行**：`python tools/analyze-bbox.py` 产出 92 文件全表（0 空帧），`python tools/analyze-bbox.py --check` 输出 `check ok: 92 files in sync`；抽样值合理（如 idle-cute x0=0.1484/x1=0.8516）。

### 2.7 `meme-catalog.mjs` — 474 表情包 CDN 目录

```js
export const MEME_CDN_BASE  // 'https://bjumymxtfpfswthiusfr.storage.supabase.co/storage/v1/object/public/ai-meme'
                            //  （详案 §2.4 核实 URL 模式）
export const MEME_CDN_COUNT = 474      // 编号 001–474
export const MEME_CDN_PROBE_TTL_MS = 10 * 60_000
export function cdnPreviewUrl(n)  // → `${BASE}/0_preview/meme/NNN.webp`（NNN 三位补零；越界抛错由调用前校验）
export function cdnRawUrl(n)      // → `${BASE}/meme/NNN.webp`
export function createMemeCatalog({ fetchImpl, random, now })
  // fetch 注入；探测降级：CDN 开 → 随机抽号探 preview（超时 3s）→ 成功 source='cdn'；任何失败 → source='local'
  //   回退本地 assets/memes/meme-001..030.webp 池（bubble.mjs MEME_POOL，lib/client/bubble.mjs:7-9）。
  // 返回 { pick(random) → { url, source }（**同步**：用最近已知 source 取号；探测在后台异步 refresh()，
  //   不阻塞、不 reject、失败静默——气泡面永不因 CDN 抖动受损）; source(); refresh(); dispose() }
```

同步 pick 设计原因：现有调用点 `bubble.say(text, { memeUrl: pickMeme() })`（`lib/client/main.mjs:120,208`）与 `bubble.mjs` API 均为同步，保持 bubble.mjs 不改。许可注记（README 必写）：474 张为社区二创，**仅个人使用，商用需画师授权**（详案 §2.4 原文）。

### 2.8 `characters.mjs` — 角色注册表

```js
export const CHARACTERS = Object.freeze({
  musume:  { id: 'musume',  label: '鲸鱼娘（musume）' },   // 默认
  classic: { id: 'classic', label: '经典小鱼干（classic）' },
})
export function normalizeCharacterId(v)   // 'classic' 之外（含脏数据）→ 'musume'
export function swapChains(stateAssets, characterId)
  // 纯函数：characterId==='musume' → 原样；'classic' → 每条状态链中若存在 `assets/classic/<语义>.webp`
  //   条目则提到链首（主备互换），无 classic 对应件的状态（night/struggling/game-*/festival-*/weather-*
  //   等 musume 专属）保持原链——classic 套仅覆盖一期 15 基础状态。返回新映射（不改入参），memo 化复用。
```

应用方式：`assets-manifest.mjs` 增 `setCharacter(id)`/按当前角色解析链（§11 步骤 2）；设置热应用链路复用 `applySettings`（`lib/client/main.mjs:254-258`）。**与 bbox 的交互（r3 规格）**：swapChains 使 9 个基础状态链首变为 classic 文件后，`bbox.mjs` 按实时链首查表自然 miss → 回退 `hitzone.mjs` 静态热区（§2.6 三段解析①）——classic 角色下热区跟随 classic 素材几何（静态表），不再按 musume bbox 计算，杜绝「显示 A 素材、热区按 B 素材算」的错位复现。新角色扩展指南落到新文档 `docs/adding-a-character.md`（§11 步骤 3）。

## 3. ② 39 条成就完整清单（id / 名称 / 谓词 / 奖励）

从 musume `whale-moe-core.js:486-526`（ACHIEVEMENTS 39 条，本方案已逐条读源）适配到本插件指标面：
**pet 快照指标**（`/api/whale-pet/state` → `pet.level/stats.{tasksDone,failures,sessions,activeMs}/stats.firstSeenAt`，Node 账本 `lib/pet-state.mjs`）、**本地交互计数**（pat=摸头 react-head 点击、feed=双击喂食、game=泡泡局）、**观察面计数**（深夜交互/深夜会话/回归/表情包/余额提醒）。奖励货币为 growth 层独立的**好感度 affinity**（`LEVEL_STEP=500` 派生好感等级；与 Node 侧资历 XP **互不干扰**——资历仍是事件驱动不可配置的 `pet-state.mjs`，好感是 client 互动层）。musume 的 `messages-*`（消息条数）、`keyword-master`（用户输入关键词）、`thanks`（说谢谢）在本插件无可观测输入，谓词按下表替换为可测等价物（替换理由列内注明）。

| # | id（沿用 musume） | 名称 | 谓词（本插件指标） | 奖励 affinity |
|---|---|---|---|---|
| 1 | first-pat | 初次摸头 | counters.pat ≥ 1 | +2 |
| 2 | ten-pats | 摸头十连 | counters.pat ≥ 10 | +8 |
| 3 | hundred-pats | 摸头百连 | counters.pat ≥ 100 | +30 |
| 4 | first-feed | 投喂成功 | counters.feed ≥ 1 | +5 |
| 5 | first-triple | 三区全触 | pat≥1 且 belly≥1 且 tail≥1（musume「比心彩蛋」无彩蛋机制 → 头/肚/尾各摸一次） | +10 |
| 6 | thanks | 鱼干常客 | counters.feed ≥ 10（原「说谢谢」不可测 → 投喂常客） | +20 |
| 7 | lv5 | 五级同行 | pet.level ≥ 5 | +50 |
| 8 | lv10 | 十级羁绊 | pet.level ≥ 10 | +150 |
| 9 | signin3 | 常客 | signin.streak ≥ 3 | +10 |
| 10 | signin7 | 一周之约 | signin.streak ≥ 7 | +30 |
| 11 | night-owl | 深夜陪伴 | 深夜静音段（isNightMute）内发生一次本地交互 ≥1 次（用户操作，被动反馈面，不触红线） | +8 |
| 12 | comeback | 欢迎回来 | 距上次交互 ≥2h 后回归交互（musume 同语义） | +8 |
| 13 | day1 | 一日之缘 | now − pet.stats.firstSeenAt ≥ 1 天 | +20 |
| 14 | day7 | 一周相伴 | ≥ 7 天 | +80 |
| 15 | day30 | 三十日契约 | ≥ 30 天 | +400 |
| 16 | first-tool | 开工啦 | pet.stats.sessions ≥ 1（原「看到工具运行」无计数 → 首次会话开工） | +5 |
| 17 | tools-10 | 会话十连 | pet.stats.sessions ≥ 10 | +20 |
| 18 | tools-50 | 会话五十连 | pet.stats.sessions ≥ 50 | +60 |
| 19 | tools-100 | 会话百连 | pet.stats.sessions ≥ 100 | +120 |
| 20 | first-code | 陪跑十小时 | pet.stats.activeMs ≥ 10h（原「代码块」无计数 → 陪伴时长阶梯） | +10 |
| 21 | code-20 | 陪跑五十小时 | pet.stats.activeMs ≥ 50h | +50 |
| 22 | first-success | 旗开得胜 | pet.stats.tasksDone ≥ 1 | +8 |
| 23 | success-10 | 任务十连 | pet.stats.tasksDone ≥ 10 | +25 |
| 24 | first-failure | 初次翻车 | pet.stats.failures ≥ 1（零负反馈：只解锁，不扣任何值） | +5 |
| 25 | fail-10 | 翻车十连 | pet.stats.failures ≥ 10 | +20 |
| 26 | messages-100 | 半百交付 | pet.stats.tasksDone ≥ 50（原「百条消息」不可测 → 交付阶梯） | +60 |
| 27 | messages-500 | 双百老搭档 | pet.stats.tasksDone ≥ 200 | +150 |
| 28 | keyword-master | 表情包达人 | counters.meme ≥ 10（原「关键词互动」不可测 → 表情包气泡弹出 10 次） | +8 |
| 29 | night-work | 深夜赶工 | 深夜段内 thinking 事实出现过 ≥1 次（夜间仍有会话在跑） | +12 |
| 30 | balance-low | 余额告急 | counters.balanceAlert ≥ 1（触发一次余额不足提醒；功能默认关，不解锁也不影响其他） | +10 |
| 31 | game-first | 初次开玩 | counters.gamePlays ≥ 1 | +5 |
| 32 | game-win | 泡泡之王 | counters.gameWins ≥ 1（评级 win ⇔ 单局得分 ≥ 300，等价 musume 原谓词） | +12 |
| 33 | game-combo10 | 连击达人 | counters.gameComboMax ≥ 10（ingest game-combo amount=本局 comboMax，growth 取 max） | +12 |
| 34 | game-highscore | 纪录刷新 | counters.gameHighscoreBreaks ≥ 1（ingest game-highscore amount=本局得分，growth 内判破纪录边沿） | +5 |
| 35 | quest-first | 任务初体验 | 完成领取第一个每日任务 | +8 |
| 36 | quest-all | 一日全勤 | 单日 3 槽全部领取（newlyAll 边沿） | +20 |
| 37 | week-signin7 | 周常满勤 | 本周签到板 7 格集满 | +30 |
| 38 | bond-action | 新动作解锁 | 好感等级（affinityLevel）≥ 3 | 0（达成即得，musume 同） |
| 39 | bond-badge | 称号首解锁 | 好感等级 ≥ 5 | 0（同上） |

解锁表现：气泡「解锁成就「名称」✨」（用户交互驱动的被动反馈，深夜可显示）；39 条谓词全部幂等（have 集合去重，musume `evaluateAchievements` whale-moe-core.js:593-603 同款）。

## 4. ③ 每日任务 3 槽与每周签到状态机

### 4.1 每日任务（3 槽，signin-1 恒在、当日幂等）

任务池 6 条（`QUEST_POOL`，结构对齐 musume whale-moe-core.js:607-614；`messages-*`/`tool-*` 适配为本插件指标）：

| id | 描述 | metric | target | 奖励 affinity |
|---|---|---|---|---|
| signin-1 | 今日签到 | signin | 1 | +6 |
| task-1 | 完成 1 次任务交付 | task | 1 | +8 |
| pat-3 | 摸头 3 次 | pat | 3 | +8 |
| feed-1 | 投喂一次 TOKEN 鱼干 | feed | 1 | +6 |
| active-15 | 陪伴 15 分钟 | activeMin | 15 | +8 |
| game-1 | 玩一局泡泡小游戏 | game-play | 1 | +8 |

```
状态机（每槽独立，dayKey = 本地 YYYY-M-D）：
  [refresh] date !== 今天 → refreshQuests：槽1 = signin-1（恒在）；槽2/3 = 其余池随机抽 2
            （尽量避开昨日 picks，池不足则放开——musume whale-moe-core.js:636-643 语义），
            progress=0, claimed=false；date=今天（当日幂等：同日重入原样返回）
  [progress] ingest({metric,amount}) → computeQuests：未领取且 metric 匹配的槽
             progress = min(target, progress + amount)（永不超 target）
  [claimable] progress ≥ target && !claimed
  [claim]    claimQuest(id)：单次幂等（重复领取无效果）；发奖一次；三槽全 claimed →
             allClaimed 边沿（newlyAll → 成就 quest-all + 气泡）
  [reset]    仅跨日 refresh 整体重置
```

签到入口（signin-1 的推进）= 用户点击签到按钮（设置卡「成长」区）；**不设主动「记得签到」推送**（保守于深夜红线：一切新增主动推送只有 balance-low 且默认关）。任务领取也是用户点击，均为被动反馈面。

### 4.2 每周签到（7 天）

```
状态机（weekKey = 本周一日期键，周一 0 点起算——musume whale-moe-core.js:691-696 同款）：
  [board]  { week, days[](日期键集合), rewarded1, rewarded3, rewarded7 }
  [signin] 用户点击签到 → signinDaily（当日幂等）→ computeWeekSignin：days 并入今天（去重）；
           里程碑按序自动结算（一次 tick 内只结一个）：
             days≥1 && !rewarded1 → rewarded1（+10 affinity）
             else days≥3 && !rewarded3 → rewarded3（+20）
             else days≥7 && !rewarded7 → rewarded7（+40，成就 week-signin7 + 气泡）
  [streak] 连续签到天数独立维护：昨日签过 → streak+1；断签 → 1（成就 signin3/signin7）
  [reset]  week 键变化 → 整板重置（新一周 days=[]、里程碑全 false）
```

### 4.3 growth 每日结算一致性

同一 dayKey 下的当日幂等覆盖三面：每日签到（只领一次）、任务槽进度/领取（date 相同不重抽）、游戏奖励（REWARDS_PER_DAY=3，跨日重置）。跨日刷新全部由 `refreshQuests`/`signinDaily`/`gameRewardAllowed` 的 dayKey 比对触发，不依赖定时器。

## 5. ④ 节日日期表（2026–2030）

`festival.mjs` 内冻结表 `FESTIVAL_LUNAR_TABLE`（id 对齐素材 `festival-{spring,christmas,halloween,mid-autumn}`）；公历节日直判规则：`MM-DD === '10-31' → festival-halloween`、`'12-25' → festival-christmas`（musume `festivalKey` whale-moe-core.js:1670-1680 同款，其 valentine 无素材不采用）。农历节日**只用查表**，表外年份回退 `null`（固定契约原文）。

| 日期（公历） | id | label | 来源 |
|---|---|---|---|
| 2026-02-17 | festival-spring | 春节 | musume 查表（whale-moe-core.js:1664）＋ Wikipedia/ChinaHighlights 双印证 |
| 2027-02-06 | festival-spring | 春节 | 同上（whale-moe-core.js:1665） |
| **2028-01-26** | festival-spring | 春节 | Wikipedia《Chinese New Year》/ ChinaHighlights / TravelChinaGuide（本次 Web 检索核实：2028-01-26，周三，猴年） |
| **2029-02-13** | festival-spring | 春节 | 同上（2029-02-13，周二，鸡年） |
| **2030-02-03** | festival-spring | 春节 | 同上（2030-02-03，周日，狗年；注意 RMG 一源把 02-02（除夕）误作初一，不采用） |
| 2026-09-25 | festival-mid-autumn | 中秋节 | musume 查表（whale-moe-core.js:1666）＋ Wikipedia《Mid-Autumn Festival》双印证 |
| 2027-09-15 | festival-mid-autumn | 中秋节 | 同上（whale-moe-core.js:1667） |
| **2028-10-03** | festival-mid-autumn | 中秋节 | Wikipedia《Mid-Autumn Festival》（本次检索核实：2028-10-03，周二，与国庆相连） |
| **2029-09-22** | festival-mid-autumn | 中秋节 | 同上（2029-09-22，周六） |
| **2030-09-12** | festival-mid-autumn | 中秋节 | 同上（2030-09-12，周四） |

来源链接：[Wikipedia – Chinese New Year](https://en.wikipedia.org/wiki/Chinese_New_Year)、[TravelChinaGuide](https://www.travelchinaguide.com/essential/holidays/new-year/dates.htm)、[China Highlights](https://www.chinahighlights.com/travelguide/festivals/when-chinese-new-year.htm)、[Wikipedia – Mid-Autumn Festival](https://en.wikipedia.org/wiki/Mid-Autumn_Festival)、[Time and Date](https://www.timeanddate.com/holidays/china/mid-autumn-festival)。表内写代码注释时必须注明「Wikipedia/ChinaHighlights 2026-10-02 检索 + musume 表 2026/2027 双印证」。

## 6. ⑤ weathercode → 素材 id 映射表

Open-Meteo WMO weather code（musume `WEATHER_MAP` whale-moe-core.js:1682-1715 为基础，适配为本插件素材 id）。id → 素材（`EXTRA_STATE_ASSETS` 键）：

| id | 素材状态键 | 素材文件 |
|---|---|---|
| clear | —（不换装） | — |
| rain | weather-rain | musume/dsh-whale-state-weather-rain-happy.webp |
| snow | weather-snow | musume/dsh-whale-state-weather-snow.webp |
| thunder | weather-thunder | musume/dsh-whale-state-weather-thunder.webp |
| umbrella | weather-umbrella | musume/dsh-whale-state-weather-umbrella.webp |
| cold | weather-cold | musume/dsh-whale-state-weather-cold.webp |

| weathercode | 含义 | id |
|---|---|---|
| 0 / 1 / 2 / 3 | 晴 / 大致晴 / 多云间晴 / 阴 | clear |
| 45 / 48 | 雾 / 雾凇 | clear（雾无素材语义，不做牵强映射——裁量点 §12） |
| 51 / 53 / 55 | 毛毛雨 / 小雨 | rain（小雨欢快，rain-happy） |
| 56 / 57 / 66 / 67 | 冻毛毛雨 / 冻雨 | umbrella（打伞挡冻雨） |
| 61 / 63 / 65 | 持续小/中/大雨 | umbrella（持续降雨打伞） |
| 80 / 81 | 小/阵雨 | rain |
| 82 | 强阵雨 | umbrella |
| 71 / 73 / 75 / 77 / 85 / 86 | 小/中/大雪、雪粒、阵/强阵雪 | snow |
| 95 / 96 / 99 | 雷雨 / 雷雨伴冰雹 / 强雷暴 | thunder |
| 其余/缺码 | 未知 | clear |

温度派生（musume `weatherFx` hot/cold 派生思路 whale-moe-core.js:1806-1816 的轻量版）：`tempC ≤ 0` 且未命中 rain/snow/thunder/umbrella → cold（结冰/严寒）。`resolveWeatherId` 优先级 thunder > snow > rain > umbrella > cold > clear。雨档 rain/umbrella 的边界（哪些 code 打伞、哪些淋雨开心）是文案级裁量（§12）。

## 7. ⑥ 泡泡游戏数值（棋盘/时限/分值/评级/game-* 姿势映射）

数值单源 `GAME` 常量（musume whale-moe-core.js:251-258 原样，源测试 `test/whale-moe-game.test.mjs:8-96` 已验证边界）：

| 项 | 值 | 说明 |
|---|---|---|
| 棋盘 | 4×4（GRID=4） | stage 内 DOM 网格覆盖层；开局播 `webm/鲸鱼吐泡泡特效.webm`（once） |
| 时限 | DURATION_MS=30000 | remainingMs 实时递减，归零 → status='ended' |
| 生成 | SPAWN_INTERVAL_MS=500 | 每 tick 至多 1 泡、随机空格；泡自然消亡（泡泡自然消长） |
| 泡寿命 | 普通 1600ms / 星 1200ms | 过期 event kind='expire' |
| 概率 | 星 15%（STAR_P）/ 炸弹 10%（BOMB_P） | 其余普通泡 |
| 分值 | 普通 +10（BASE）/ 星 +30（STAR_SCORE）/ 炸弹 −20（BOMB_SCORE，**仅作为返回 delta 展示，不实际扣分**） | musume 原样：炸弹分支不改 score（whale-moe-core.js:324-328，`state.score` 不变），测试注记 "bomb does not add score"（whale-moe-game.test.mjs:35-37）；另清零连击、不加连击加成。评级阈值 300/150 即按此口径调校，不得改成真扣分 |
| 连击 | 窗口 1200ms；加成 = min(combo,10)×2（COMBO_CAP=10） | musume whale-moe-core.js:330-333 逐行核实 |
| 评级 | ≥300 win / ≥150 draw / 其余 lose | musume gameGrade 149/150/299/300 边界 |
| 每日奖励 | 前 3 局发好感奖励（REWARDS_PER_DAY=3），超出只显示结算 | gameRewardAllowed 跨日重置 |
| 结算好感 | win +12 / draw +3 / lose +0 / 破纪录另 +5 | ingest 复用 §2.2 指标 |

**game-\* 姿势映射**（素材只有 5 个：`game-{happy,lose,think,win,cheat}`；musume 的 game-draw 姿势本库不存在，映射表为本方案裁定）：

| 游戏阶段 | 姿势（renderer 状态 id） | 素材 |
|---|---|---|
| 开局/进行中默认 | game-think | dsh-whale-state-game-think.webp |
| 进行中连击 ≥5 达成瞬间（下一泡命中后保持到连击断） | game-happy | dsh-whale-state-game-happy.webp |
| 点中炸弹瞬间（约 1.5s，此后回 game-think） | game-cheat | dsh-whale-state-game-cheat.webp |
| 结算 win | game-win | dsh-whale-state-game-win.webp |
| 结算 draw | game-happy（平局不气馁，复用 happy） | dsh-whale-state-game-happy.webp |
| 结算 lose | game-lose | dsh-whale-state-game-lose.webp |
| 结算面板关闭 / 游戏结束 | 回正常状态机 | — |

姿势对状态机的接入 = idle 兜底覆盖链最高位（§2.3 `idleOverlayVisual`），事件事实（wait/celebrate/error）与交互（drag/eat）仍按 STATE_TABLE 行序正常覆盖游戏姿势（棋盘 DOM 不受影响）。

## 8. ⑦ bbox 表覆盖清单与 flip 语义

**表**：`lib/client/bbox-table.json`（version 1，键 = `assets/musume/` 下文件 basename，值 = 首帧归一化 bbox；本方案当日由 `python tools/analyze-bbox.py` 实际生成 92 条全表，`--check` 同步通过）。**覆盖清单**（表 92 条全量入库；运行时 `resolveBBox(state)` 按 §2.6 三段口径解析链首文件后查表——一期 9 键实时 `resolveStateChain`、react 3 键 `REACT_ASSETS`、二期 15 键冻结映射；classic 角色下基础状态实时链首变 classic 文件 → 查表 miss → 回退静态热区；链首不在 musume 表内即回退静态热区）：

| 类别 | 状态 | 链首素材 | bbox 生效 |
|---|---|---|---|
| 一期 17 状态中链首为 musume webp 的 | think / wait / celebrate / error / disappointed / sleep / night / struggling / idle | state-thinking / state-waiting / state-work-celebrate / state-angry / state-meme-cry / state-work-sleep / state-night / state-meme-doubt / state-idle-cute | ✅ 9 个 |
| 热区反应 | react-head / react-belly / react-tail | musume react-\* | ✅ 3 个 |
| 二期新增 | game-think / game-happy / game-cheat / game-win / game-lose / balance-low / festival-spring / festival-christmas / festival-halloween / festival-mid-autumn / weather-rain / weather-snow / weather-thunder / weather-umbrella / weather-cold | musume game-\*/balance-low/festival-\*/weather-\* | ✅ 15 个 |
| 链首为 classic/webm，回退静态表 | welcome(classic) / working(webm) / wake(classic) / eat(webm) / play(classic) / joy(classic) / drag(webm) / walk(classic) | — | ⛔ 回退 `hitzone.mjs` 静态 full 表（行为与一期完全一致） |

**flip 语义**：素材统一朝左基准（`docs/sprites-spec.md` §4），flip=-1 时 stage 整体 `scaleX(-1)`（`lib/client/renderer.mjs:180-182`）。bbox 表存**素材原始坐标**；命中时 `flip===-1 → x ← 1−x` 再对矩形判定（等价于镜像矩形，取先镜像点实现）。这与 whale-girl 决策「热区按内容实际位置对齐（flip 镜像）」一致；转身/散步方向翻转后热区随内容镜像，不再出现「镜像后热区在空白侧」。矩形内三段分区比例（0.45/0.78）沿用静态表（`lib/client/hitzone.mjs:7-11`），保证 head/belly/tail 语义连续。

## 9. ⑧ 新增设置分区（键名与默认值）

写入 `settings.mjs` 的 `DEFAULT_SETTINGS`（`lib/client/settings.mjs:20-46`）与 `normalizeSettings`（:78-108，逐字段纠正 + LIMITS 钳制，两端共用同一校验——Node 路由 `lib/index.mjs:719-747` 与设置卡同源）：

| 分区 | 键 | 默认 | 校验 |
|---|---|---|---|
| `game` | `enabled` | `true`（用户主动游玩项） | asBool |
| `festival` | `enabled` | `true`（纯视觉面） | asBool |
| `weather` | `enabled` | `true` | asBool |
| | `city` | `''`（空=不查询不换装，dormant） | asStr |
| `balanceLow` | `enabled` | **`false`（固定契约指定；隐私/强主动项默认关红线）** | asBool |
| | `thresholdCNY` | `5` | asNum + 新 `LIMITS.balanceThresholdCNY = [1, 100]` |
| | `apiKey` | `''` | asStr；**回传语义三态（r2 修订，见 §10.3）**：POST 时 `undefined`/`''`=**保留现值**、`null`=**清除**、非空字符串=**覆盖**；GET 与 POST 响应一律脱敏；不写任何日志 |
| `memeCdn` | `enabled` | `true`（详案 §2.4 明示的 client 直链例外） | asBool |
| `character` | —（顶层标量） | `'musume'` | 非 `'classic'` 一律纠正回 `'musume'`（normalizeCharacterId 同语义） |

设置卡 UI 新分区（集成工程师）：泡泡小游戏 / 节日换装 / 天气换装（+城市输入框）/ 余额提醒（开关+阈值+apiKey 密码框：写入后不回显，placeholder 显示「已配置」来自 `apiKeySet`；提供显式「清除」动作发 `null`）/ 表情包热链 / 角色选择（musume/classic）。**设置卡 apiKey 字段不参与常规全量回传的语义由三态保证**：设置卡每次改任意开关都全量 POST（`lib/client/settings.mjs:148-166` 的 `patch()` 600ms 防抖全量提交，已核实），卡内持有的脱敏值 `''` 按三态语义 = 保留现值，**不会再清空已存 key**；仅当用户输入新 key（非空字符串）或点清除（`null`）时才改变服务端值。每个新分区补 normalizeSettings 单测（坏数据逐字段纠正、钳制、`character` 未知值回默认、**`resolveIncomingApiKey` 三态**），落 `test/settings-phase2.test.mjs`（**归集成工程师所有**，§0）。

## 10. 路由与素材链变更（集成工程师独占面，先列规格）

**路由（lib/index.mjs）**：
1. `GET /api/whale-pet/weather?city=<中文城市>`（新增）：geocoding（language=zh）→ 取首条 lat/lon → forecast `current=weather_code,temperature_2m` → `{ ok, code, tempC, city }`；无密钥；内存缓存 10 分钟；上游失败 → 502 `{ ok:false, reason }`；fetch 挂 dispose、超时保护。
2. `/api/whale-pet/balance` 升级（现为恒 stub，`lib/index.mjs:702-717`）：`settings.balanceLow.apiKey` 非空 → 代理 `https://api.deepseek.com/user/balance`（Bearer 鉴权）透传 `{is_available, balance_infos}`（+`ok:true`）；未配置 → **保持现有 stub 行为** `{ ok:false, reason:'balance-not-configured' }`。
3. 设置路由（**r2 修订**：补全回传语义，堵「任意开关保存清空 key」与「POST 响应泄明文」两个缺口）：
   - **GET 脱敏**：`balanceLow.apiKey` 恒回 `''`，附 `balanceLow.apiKeySet: true|false`（现 GET 全量回显，`lib/index.mjs:726`）。
   - **POST 三态合并**（现码 `lib/index.mjs:738-740` 是 `normalizeSettings(body)` 整体替换——必须先合并再归一）：`body.balanceLow.apiKey` 为 `undefined`/`''` → **保留已存 key**；为 `null` → 清除；为非空字符串 → 覆盖（trim）。合并决策抽成 `settings.mjs` 导出的纯函数 `resolveIncomingApiKey(currentKey, incoming) → string`（可 node --test 直测三态），路由层调用后把解析结果填回 body 再走 `normalizeSettings` + `saveSettings()`。**理由（实测链路）**：设置卡每次改任意开关都全量 POST（`lib/client/settings.mjs:148-166`），若 POST 空 key 按字面落盘，用户配好 key 后切一个「久坐提醒」开关余额提醒即静默失效。
   - **POST 响应与 GET 同规则脱敏**：现码 `lib/index.mjs:742` 回显全量 `settings`，刚写入的明文 apiKey 会泄回任意同源页面——响应必须走与 GET 相同的脱敏出口（apiKey→''+apiKeySet）。
4. client 模块路由 allowlist 放宽 `.json`（现仅 `.mjs`，`lib/index.mjs:636`）服务 `lib/client/bbox-table.json`，**且响应 content-type 必须按扩展名从 MIME 表取（`application/json; charset=utf-8`，MIME 映射在 `lib/index.mjs:75`）——现码 `lib/index.mjs:646` 对所有 client 模块硬编码 `text/javascript`**，.json 若仍按该值下发，浏览器 `import … with { type: 'json' }` 会因 MIME 校验失败抛错、整条 client 模块链加载失败（与 §12-① 引用的 M6-2 前科同类）。**偏离说明见 §12-①**。

**素材链（assets-manifest.mjs）**：`game-*`(5)、`balance-low`(1)、`festival-*`(4)、`weather-*`(5) 共 15 键入 `EXTRA_STATE_ASSETS` 冻结映射（image/loop 单链），`resolveStateChain` 回落查该映射（`lib/client/assets-manifest.mjs:74-88` 扩展）；**不并入 STATE_ASSETS/STATE_NAMES**——保持 17 状态契约与 `test/manifest.test.mjs:20-30` 的长度断言、`docs/state-machine.md` §2 状态集合不变（说明见 §12-③）。旧面 `assets/manifest.js` 已含全部二期素材（本方案 grep 核实：balance-low:29、festival-*:109-122、game-*:125-142、weather-*:293-310、泡泡 webm:633），`test/manifest.test.mjs:38-53` 漂移守卫绿，旧面无需改动。

## 11. ⑨ 集成工程师三步接线清单

**第 1 步 · 宿主路由 + 设置**
1. `lib/client/settings.mjs`：按 §9 扩 DEFAULT_SETTINGS/LIMITS/normalizeSettings（逐字段纠正）+ 新导出纯函数 `resolveIncomingApiKey(currentKey, incoming)`（三态：''/undefined→保留、null→清除、非空→覆盖）+ 设置卡 UI 六分区（apiKey 密码框不回显、显式「清除」发 null、常规开关改动回传的 `''` 依三态=保留）+ apiKey 脱敏约定；`character` 变更经 `onSettingsChange` 热应用。**`test/settings-phase2.test.mjs`（本文件归集成工程师）：六分区 normalizeSettings + resolveIncomingApiKey 三态 + apiKeySet 出入两向。**
2. `lib/index.mjs` 落点清单（按 §10）：① weather 路由；② balance 升级（apiKey 非空才代理）；③ settings GET 脱敏 + **POST 三态合并（先 `resolveIncomingApiKey` 再 normalizeSettings）+ POST 响应同规则脱敏**；④ client 路由 `.json` 放宽（:636）**且 content-type 按扩展名取 MIME（修 :646 的 text/javascript 硬编码，否则 JSON import 因 MIME 校验失败挂整条 client 链）**；全部定时器/子进程挂 dispose、幂等可重入（沿用 `lib/index.mjs:822-846` dispose 模式）。
3. 回归：`npm test` 全绿（含 `test/settings-phase2.test.mjs`）；`dsh web` 冒烟——设置卡六分区可存可读，`/api/whale-pet/weather?city=上海` 200，未配 apiKey 时 balance 仍 stub；**专项：配好 key 后切换「久坐提醒」开关再 GET，确认 key 仍在（apiKeySet 仍 true）且任何响应不含明文 key**。

**第 2 步 · client + 素材链**
1. `lib/client/assets-manifest.mjs`：`EXTRA_STATE_ASSETS` + `resolveStateChain` 回落 + `setCharacter(id)` 角色变体（swapChains memo）；`test/manifest.test.mjs` 增补断言：EXTRA 键文件存在 + **漂移守卫——`EXTRA_STATE_ASSETS` 各键链首 file === `bbox.mjs` 的 `BBOX_STATE_FILES` 对应键，且默认角色下 `resolveStateChain`/`REACT_ASSETS` 实时链首 === 本表对应键**（§2.6 三段口径在此回归单源）。
2. `lib/client/main.mjs` 接线（全部 dispose、幂等可重入）：
   - **game**：设置卡/结算面板入口 → game 控制器（棋盘 DOM + gameTick 驱动 + gamePose 写入 overlay 状态）+ 开局泡泡特效 once；结算经 growth.ingest game-\* 指标（blob.game 由 growth 维护，§2.1）。
   - **growth**：`createGrowth`（localStorage 适配器）；交互 hook——`onPointerUp` 热区命中后按区 ingest pat/belly/tail、`onDblClick` 喂食 ingest feed、签到按钮（signinDaily，signin-1 槽内部推进）、快照差分（pet.stats 每轮 POLL_MS 对比）ingest task/failure/session/activeMin/level/day、深夜 thinking 边沿 night-work、回归 comeback、meme 弹出计数；解锁/领奖气泡。
   - **festival/weather**：日期与天气每 tick/30min 解析 festivalId/weatherId → `idleOverlayVisual` 替换 `main.mjs:480` 的 `nightVisualState` 调用点（care.mjs 不改）。
   - **balance-low**：enabled 且非深夜才武装轮询定时器（nextPollAt 节拍）→ fetch `/api/whale-pet/balance` → parseBalancePayload → balanceLowDecision → 提醒气泡（**必须显式 `bubble.say(text, { ms: 8000 })`**——气泡默认 5s（`lib/client/bubble.mjs:12` BUBBLE_SHOW_MS=5000，已核实），不显式传则姿势比气泡多挂 3s）+ ingest balance-alert + **置 `balanceLowUntil = now + 8000`（与上述气泡 ms 同值）**；250ms tick 每帧计算 `balanceLowPose = now < balanceLowUntil ? 'balance-low' : null` 传入 `idleOverlayVisual`——**禁止直接 `renderer.show('balance-low')`**（`main.mjs:493-497` 仅在状态变化时调用 show，直呼会被下一 tick 立即回翻；经 overlay 决策通道则窗口内稳定呈现、到期自然回落，logic.mjs 零改动——`local.transient` 仅支持 'eat'|'play'|'wake'（`lib/client/logic.mjs:46-50`），不借用）。深夜静默、失败退避。
   - **bbox**：`main.mjs:191` 的 `hitZone(nx,ny,'full')` 换成 `bboxHit(nx,ny,当前animState,{flip:facing})`（链首解析在 bbox.mjs 内按 §2.6 三段口径走实时 `resolveStateChain`/`REACT_ASSETS`——classic 角色下基础状态自动回退静态热区，无需 main 侧特判）；null 不触发反应。
   - **meme-cdn**：`createMemeCatalog` 替换 `pickMeme` 供应面（`main.mjs:120,208`）；后台探测、同步 pick、失败静默。
   - **characters**：启动与设置热应用时 `setCharacter(settings.character)`。
   - **仓库卫生（r2）**：`tools/` 遗留产物 `check-0/1/2.png`、`v-avatar.png`、`v-classic.png`、`v-fatfish.png` 未被 `.gitignore` 覆盖（本次 ls 证实）——顺手删除或补 `.gitignore` 规则，避免与 bbox 表提交混入无关产物。
3. `test/client-graph.test.mjs` **无需改动（r2 撤回原断言）**：该门禁（`test/client-graph.test.mjs:19-27`）只检查相对导入 `./` 前缀 + `existsSync`，`bbox-table.json` 已在 `lib/client/` 且现状即通过；真正必需的只有第 1 步落点 ④ 的 lib/index.mjs allowlist + MIME 修正。
4. 回归：`npm test` 全绿；`test/cdp-whale-pet.mjs` 手测脚本补二期场景（可裁量）；素材路由对新状态 200。

**第 3 步 · 文档（集成工程师独占）**
1. `docs/state-machine.md`：附录「二期视觉覆盖」——game-*/festival-*/weather-*/balance-low 是 idle 兜底视觉覆盖（idleOverlayVisual），**不进 STATE_TABLE 行序**，状态集合仍 17+3 热区。
2. `docs/sprites-spec.md`：EXTRA_STATE_ASSETS 契约、bbox-table.json 生成工具与口径（tools/analyze-bbox.py --check）、474 表情包热链模式与许可注记。
3. `docs/adding-a-character.md`（新增）：characters.mjs 互换规则 + 新角色素材集最低要求（15 基础状态各一件 + 命名规范）。
4. `README.md`：功能清单/设置项更新 + 474 表情包许可注记（社区二创，**仅个人使用，商用需画师授权**）+ 许可矩阵表加行。
5. `demo/index.html` 保持可用（旧面已含二期素材，可选加展示项）。
6. `D:/桌宠/鲸鱼娘桌宠-开发计划.md`：§4 Backlog 逐项标注 **2026-10-02 完成**（Live2D/Tauri 除外，标注范围外）+ 附录 B 追加二期条目。

## 12. 固定契约符合性与偏离说明（逐条）

契约内：8 个新模块文件名/职责/纯函数边界、`balanceLow.enabled=false`、festival 表外回退 null、festival>weather 覆盖序、REWARDS_PER_DAY、localStorage 适配器、hitzone.mjs 零修改、care.mjs/logic.mjs 零修改、共享文件分工——均与固定契约逐字对齐。

必须偏离/裁量的三点（逐条理由）：
1. **client 路由 allowlist 放宽 `.json` + 响应 MIME 按扩展名取值**（固定契约路由清单只列 weather/balance 两项）：`bbox-table.json` 按契约落在 `lib/client/` 且被 `bbox.mjs` 静态 import，现路由只服务 `.mjs`（`lib/index.mjs:636`）会 403，且现码对所有 client 模块硬编码 `text/javascript`（`lib/index.mjs:646`）——.json 放行后若 MIME 不符，浏览器 `import … with { type: 'json' }` 校验失败、整条 client 链加载失败（M6-2 附录 B 同类前科）。两处同为 lib/index.mjs 一处 handler 内的邻接修正。替代方案（表内联进 bbox.mjs）违背「运行 python 实际生成、不许只写脚本不产出表」的可再生性，弃。
2. **weather id 集合在契约的 clear/rain/snow/thunder/cold 之上补 `umbrella`**：素材 `weather-umbrella.webp` 在库（项目事实清单列明），缺 id 则该素材永远不可达；musume 源 WEATHER_MAP 无伞细分（kind 只有 rain），umbrella 是本插件对自家素材库的必要适配。
3. **二期素材不并入 STATE_ASSETS/STATE_NAMES（以 EXTRA_STATE_ASSETS + resolveStateChain 回落实现「按需入链」）**：并入会破坏 17 状态唯一权威（`docs/state-machine.md` §2）与 `manifest.test.mjs:20-30` 长度断言、并把非状态机语义（换装/游戏姿势）混入状态机域；回落实现满足「入链」（可解析、可降级、可渲染）的字面与意图。
4. **「未知/缺码 weathercode + tempC≤0」组合取 §6 口径（r4 评审复核补记）**：§2.4 写「未知/缺码 → 'clear'（=不换装）」，§6 又写「tempC ≤ 0 且未命中 rain/snow/thunder/umbrella → cold」——两处在该组合上语义分裂；实现取 §6（`weather.mjs` 表外/缺码先落 clear，再经温度派生可得 cold，严寒不因上游发码扩展丢失换装），边界已由 `test/weather.test.mjs` 专项用例钉住。

## 13. 范围外（不做，报告说明）

- **Live2D 路线**：需自行绑模，无鲸鱼娘 Live2D 模型产物（详案 §1.3/§6.8 明示），无素材基础，二期不排。
- **Tauri 桌面伴侣壳**：独立 Rust 工程；官方桌面端未暴露窗口级悬浮 IPC（M6-3 裁定，README roadmap），出窗需求整体延后，不在本方案八个模块内。
- 游戏内购/账号体系、 achievements 云同步（localStorage 即契约口径）、语音/TTS。

## 14. ⑩ 测试清单（每功能）

统一口径：`node --test "test/*.test.mjs"`；新模块 now/rng/fetch/storage 全注入；新增用例后总量预期 122 → 约 200。

| 测试文件 | 必测项 |
|---|---|
| `test/game.test.mjs` | 评级边界 149/150/299/300；pop 普通 +10+连击加成 / 星 +30 / 炸弹 delta −20 但 score 不变（musume 原样）且清连击不加成；连击 1200ms 窗口内递增、窗外重置；加成封顶 min(combo,10)×2；tick 单间隔至多生成 1 泡、落空格、过期消失；remainingMs 实时递减归零 ended；gameResult 聚合；gameRewardAllowed 每日 3 局上限/跨日重置；gamePose 全分支（含 draw→game-happy、bomb→game-cheat）；rng 注入确定性（同种子同序列） |
| `test/growth.test.mjs` | 39 成就逐条谓词真/假 + 首解锁 + 幂等不重复（day1/7/30 用注入 now 构造 firstSeenAt 差值；**游戏四条用 #31 gamePlays/#32 gameWins/#33 gameComboMax max 语义/#34 gameHighscoreBreaks 边沿各测真假两向**）；affinity 累加/封顶 10000/等级 500 步进/反函数；refreshQuests（signin-1 恒在、3 槽无重复、当日幂等、跨日刷新避开昨日槽）；computeQuests 累计/不超 target/claimed 不再累计；claimQuest 单次幂等/未满不可领/3-3 newlyAll **且边沿累计 counters.questsClaimed/questAllDays（成就 #35/#36 谓词落点）**；每周签到里程碑 1/3/7 各一次、跨周重置；streak 连续/断签归 1；当日幂等（同日重复 ingest/签到不重复发奖）；**blob.game 字段（highscore/playsToday/playsDay）由 game-play/game-highscore ingest 维护且跨日重置；game-combo 取 max 不回退；同分重复上报不计数 gameHighscoreBreaks**；内存存储适配器全流程；localStorage 缺席退内存态 |
| `test/festival.test.mjs` | §5 表 10 个农历日期全命中；公历 10-31/12-25 直判；表外年份（2031 春节等）→ null；闰/非法日期 → null；idleOverlayVisual 优先级矩阵（gamePose > night > **balanceLowPose** > festival > weather；非 idle 原样；含 balanceLowPose 与 festival 同现时 balanceLowPose 胜出、nightMute 下 balanceLowPose 不生效的组合） |
| `test/weather.test.mjs` | URL 组装（中文城市 encodeURIComponent、language=zh、无密钥参数面）；WEATHER_CODE_MAP 全码覆盖（0-3/45/48/51-57/61-67/71-77/80-86/95-99 + 未知码）；resolveWeatherId 优先级 thunder>snow>rain>umbrella>cold>clear；tempC 边界 0/0.5/−0.5 |
| `test/balance-low.test.mjs` | parseBalancePayload（CNY 命中/非 CNY 优先回退/坏载荷 ok:false）；balanceLowDecision（正常→低 alert 一次→持续低不重复→回升重置→再低再提醒；无效金额不动水位）；nextPollAt 成功 10min/失败 2^n 退避封顶 60min/成功复位 |
| `test/bbox.test.mjs` | 表加载 92 文件全有 bbox；**BBOX_STATE_FILES 27 键逐一存在于 `assets/musume/`（并行期即可全测，不依赖集成工程师导出）**；resolveBBox 已知状态（idle/think/game-win/festival-spring，react-head 经 REACT_ASSETS 链首）返回矩形、未知状态 null；**注入 chainHeadFile='assets/classic/idle.webp'（模拟 classic 角色）→ 基础状态链首查表 miss → null → bboxHit 回退静态热区（characters×bbox 自洽用例）**；bboxHit 矩形内三段 head/belly/tail、矩形外 null；flip=−1 x 镜像对称性（同点 flip=±1 结果对偶）；无表状态回退 hitzone.hitZone 静态语义（恒返回三区之一）；`python tools/analyze-bbox.py --check` 子进程同步校验（或断言表 _meta 与工具参数一致）；**EXTRA 链首 === BBOX_STATE_FILES 的漂移断言落 test/manifest.test.mjs（集成工程师，§11 步骤 2.1），不在本文件** |
| `test/meme-catalog.test.mjs` | URL 模式（001/474 边界、3 位补零）；探测成功走 CDN（注入伪 fetch 200）、失败回退本地 30 张池；TTL 内不重复探测、过期重探；pick 同步永不 throw（fetch 注入为恒 reject 也回本地）；dispose 清理 |
| `test/characters.test.mjs` | swapChains classic 优先互换（有 classic 对应件链首翻转、musume 专属状态保持）；musume 原样返回；normalizeCharacterId 未知值回 musume；互换幂等（swap 两次 == 原表） |
| `test/settings-phase2.test.mjs`（**集成工程师所有**，§0） | 六新分区逐字段 normalizeSettings（坏数据纠正/钳制/character 未知回默认/balanceLow.enabled 默认 false）；**`resolveIncomingApiKey` 三态（''/undefined→保留、null→清除、非空→覆盖）+ 脱敏出口（GET/POST 响应 apiKey 恒 ''+apiKeySet）** |
| 共享门禁回归 | `test/manifest.test.mjs`（EXTRA 文件存在 + 旧面漂移守卫 + **EXTRA 链首 === BBOX_STATE_FILES 漂移断言**）、`test/client-graph.test.mjs`（新模块 ./ 导入——**现状规则即覆盖 bbox-table.json，无需改门禁**）全绿 |

## 15. 验收门禁（汇总）

1. `npm test` 全绿（基线 122/122，本方案编制当日实测复核）；`npm run test:compat` 双车道绿（涉 lib/index.mjs 变更后必跑）。
2. `python tools/analyze-bbox.py --check` 同步通过。
3. 深夜红线自查：balance-low 默认关且深夜不轮询不提醒；无任何新增主动推送类功能；game/growth 交互面深夜可用的理由已记录（用户操作触发的被动反馈）。
4. 素材全缺失场景：EXTRA 链缺失降级占位头像、CDN 失败回退本地 30 张、geocoding 失败 502 静默——三降级路径人工验证。
5. 文档三件套 + README + 开发计划标注完成。
