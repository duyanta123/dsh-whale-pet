# 鲸鱼娘桌宠 · 素材契约（sprites-spec）

> 素材全库 191 项**原地不动**（`assets/`：musume 92 / classic 15+avatar / webm 50 / fatfish 4 /
> memes 30）；本文件定义桌宠运行时如何消费它们。契约单源是 `lib/assets-manifest.mjs`
> （ESM）；`assets/manifest.js`（`window.PET_MANIFEST`）是 demo 预览页的旧面，保持不变，
> 由 `test/manifest.test.mjs` 守卫两者一致（每个契约文件真实存在、且能对上旧面清单）。

## 1. 字段含义

| 字段 | 类型 | 说明 |
|---|---|---|
| `file` | string | 包内根相对路径（`assets/…`）；client 拼接 `ASSET_BASE`（`/api/whale-pet/assets/`）取同源 URL |
| `kind` | `'image' \| 'video'` | image=动画 WebP（`<img>` 播放）；video=VP9 alpha WebM（双 `<video>` 双缓冲交叉淡入） |
| `playback` | `'loop' \| 'once'` | loop=循环到状态结束；once=播完一次（video `onended`）回底层状态 |
| `motion` | `null \| 'shake'` | 可选叠加表现（error 抖动，CSS 实现） |
| `pick` | `'first' \| 'random'` | 链首选择策略：first=按链序首个可加载者；random=链首连续 video 段随机抽一（working 插曲池） |

**frames/fps 字段的实测裁定（2026-09-29，附录 B 已记）**：计划 M1-2 原设想按 whale-girl
帧条 PNG 契约补 `frames/fps`；本库素材为整段动画 WebP/WebM（时序内嵌、浏览器原生解码），
排帧无意义——契约以 `kind/playback` 为准，不设 frames/fps。

## 2. 状态 → 素材链（15 状态，主备降级）

链序 = 降级序：首选缺失（404/解码失败）→ 次选 → … → 全部缺失 → 占位头像
`assets/classic/avatar.png`（可选插件失败隔离原则）。

| 状态 | 链 |
|---|---|
| welcome | classic/welcome → musume/state-daily-done |
| think | musume/state-thinking → classic/think |
| working（pick=random） | webm/偷吃Token · webm/东张西望 · webm/工作摸鱼（随机）→ musume/state-work-debug |
| wait | musume/state-waiting → classic/wait |
| celebrate | musume/state-work-celebrate → classic/celebrate → musume/state-game-win |
| error（motion=shake） | musume/state-angry → classic/error |
| disappointed | musume/state-meme-cry → classic/disappointed |
| sleep | musume/state-work-sleep → classic/sleep |
| wake | classic/wake → webm/睡眼惺忪（once）→ musume/state-daily-stretch |
| eat | webm/吃小鱼干（once）→ musume/state-eat → classic/eat |
| play | classic/play → musume/state-daily-stretch |
| joy | classic/joy → musume/state-meme-heart |
| drag | webm/被鼠标拖拽悬空反馈 → musume/state-pick-up → classic/drag |
| walk | classic/walk → webm/螃蟹走路 |
| idle | musume/state-idle-cute → classic/idle |

与计划 M1-2 映射表的差异（以素材清单实际文件为准，附录 B 记录）：
- drag 备选第二位用 `musume/dsh-whale-state-pick-up.webp`（"被拎起"，语义更贴切）替代 react-*；
- wake 备选第二位用 `webm/睡眼惺忪.webm`（清单实际段名），play 备选用 `daily-stretch`。

## 3. 命名规范与新增素材流程

1. musume 套：`assets/musume/dsh-whale-<语义>.webp`（源仓库命名保持原样）。
2. classic/fatfish 套：`assets/<套>/<状态名>.webp`。
3. webm 段：`assets/webm/<中文段名>.webm`（50 段清单见 `assets/_webm_list.txt`）。
4. 表情包：`assets/memes/meme-NNN.webp`（三位编号，30 张）。
5. 新增素材：放入对应目录 → 在 `lib/assets-manifest.mjs` 的状态链（或 REACT_ASSETS）登记 →
   跑 `npm test`（manifest 门禁校验文件存在与链完整性）→ 如 demo 需要展示，同步
   `assets/manifest.js` 旧面。

## 4. 渲染约束（renderer 实现规格）

- image（WebP）：单个 `<img>`；同状态重复切换不重载（src 复用浏览器缓存）。
- video（WebM）：双 `<video>` A/B 缓存，`loadeddata` 后交叉淡入（0.18s opacity 过渡），
  旧 video 暂停；竞态防护用切换代数（gen）丢弃过期回调——参照 dsh-whale-girl-pet 实测实现。
- 统一地面定位线：所有素材按画面底部对齐（`object-fit: contain; object-position: bottom`），
  宿主 stage 高度即素材高度。
- 朝向：素材统一**朝左基准**；`flip=-1` 时 `transform: scaleX(-1)` 镜像。
- `prefers-reduced-motion: reduce`：WebM 全部降级为该状态链中第一个 image 素材；
  video 元素不创建。
- 渲染帧率上限 30fps（M6-2）：requestAnimationFrame 节流；标签页隐藏暂停（visibilitychange）。
- webm 按状态懒加载：仅在状态首次命中时设置 src（全库 26MB 不预载）。

---

## 5. 二期换装链（EXTRA_STATE_ASSETS，2026-10-02）

二期 15 个换装/游戏姿势状态（game-×5 / balance-low / festival-×4 / weather-×5）以
**「按需入链」** 方式进契约：入 `lib/client/assets-manifest.mjs` 的 `EXTRA_STATE_ASSETS`
（image + loop 单链），`resolveStateChain` 先查当前角色表、再回落该映射；**不并入
STATE_ASSETS/STATE_NAMES**——17 状态唯一权威（`docs/state-machine.md` §2）与
`test/manifest.test.mjs` 长度断言不变。这些状态是 idle 兜底视觉覆盖层
（festival.mjs `idleOverlayVisual` 的输出域，见 state-machine.md 附录 A），不进状态机行序。

| 键 | 链首素材 |
|---|---|
| game-think / game-happy / game-cheat / game-win / game-lose | musume/dsh-whale-state-game-*.webp |
| balance-low | musume/dsh-whale-state-balance-low.webp |
| festival-spring / festival-christmas / festival-halloween / festival-mid-autumn | musume/dsh-whale-state-festival-*.webp |
| weather-rain（例外：素材名带 -happy）/ weather-snow / weather-thunder / weather-umbrella / weather-cold | musume/dsh-whale-state-weather-*.webp |

- 链首与 `bbox.mjs` 的 `BBOX_STATE_FILES` 二期段逐一对应——`test/manifest.test.mjs` 漂移断言
  单源回归（「按 state id 推导文件名」的无守卫双源防复发，weather-rain 例外映射必须显式成表）。
- classic 角色无对应件：EXTRA 面不参与 `characters.mjs swapChains` 互换，classic 下保持 musume 原链。
- 游戏开局特效 `assets/webm/鲸鱼吐泡泡特效.webm` 不在任何链内（main.mjs 直呼 `assetUrl` 播放一次），
  manifest 门禁单独断言其存在。

## 6. bbox 逐状态热区表（bbox-table.json，生成物）

`lib/client/bbox-table.json`（`_meta.version = 1`）覆盖 `assets/musume/*.webp` 全部 92 张：
**首帧**（多帧 sheet 只取第 1 帧）内 alpha ≥ 8 的不透明像素包围盒，归一化 [0,1]（4 位小数）。

- 生成与校验：`python tools/analyze-bbox.py`（重生成全表）/ `python tools/analyze-bbox.py --check`
  （现表与扫描结果逐文件比对，CI 守卫；该 `--check` 已作为子进程用例内置于 `test/bbox.test.mjs`，
  表过期即红）。
- 运行时入口：`bbox.mjs bboxHit(nx, ny, state, { flip })`（main.mjs 点击处理直呼，phase2-plan §11-2；
  **hitzone.mjs 零修改**）——
  **bbox 表优先**（点在矩形外 → null，宿主不触发反应，消除「空白可点」）；未知状态/链首无表
  （classic 角色下基础状态链首变 classic 文件、welcome/working 等 webm/classic 链首）在 bbox.mjs
  内部自动回退 `hitzone.mjs` 静态 full 表（行为与一期完全一致，热区随显示素材几何自洽）。
- 链首解析三段口径（`bbox.mjs`，防 characters×bbox 错位）：① 一期 9 键实时
  `resolveStateChain(state)[0].file`；② react 3 键 `REACT_ASSETS[zone][0].file`（react 不在
  STATE_ASSETS，不可走 resolveStateChain 否则命中占位头像回落）；③ 二期 15 键用 `BBOX_STATE_FILES`
  冻结映射。`flip=-1`（scaleX(-1) 镜像）先镜像点 x（x←1−x）再判定——热区按内容实际位置对齐
  （refs/whale-girl 决策 2026-08-09）。
- 矩形内三段分区沿用静态表比例（相对 y ≤0.45 head / ≤0.78 belly / 其余 tail），head/belly/tail
  语义连续。

## 7. 表情包热链（Supabase CDN 474 张，client 直链唯一例外）

- URL 模式（meme-catalog.mjs）：预览 `https://…supabase.co/…/ai-meme/0_preview/meme/NNN.webp`、
  原图 `…/meme/NNN.webp`（NNN 三位补零，001–474）；气泡 `<img>` 上限 180px 用预览图即可。
- 探测降级：CDN 开（`settings.memeCdn.enabled`，默认开）→ 后台随机抽号探 preview（3s 超时，
  10min TTL 节流）→ 成功 `source='cdn'`；**任何失败静默回退本地 30 张池**
  （`assets/memes/meme-001..030.webp`，即 bubble.mjs `MEME_POOL`）。`pick()` 同步取号、永不
  throw、永不阻塞气泡面；供应面由 main.mjs 调用点直呼 `catalog.pick().url`（bubble.mjs 零改动，
  plan §11-2；目录缺席/意外异常回退本地池 `pickMeme`）（实例生命周期
  归 main.mjs：启动首探 + 10min 重探定时器 + 设置热应用重建即探 + dispose）。
- **许可注记**：474 张为社区二创表情包，**仅个人使用，商用需画师授权**（与本地 30 张同源同许可，
  见 README 许可矩阵）。
