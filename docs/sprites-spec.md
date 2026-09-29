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
