# dsh-whale-chan · 鲸鱼娘桌宠

住进 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web 界面的鲸鱼娘桌宠插件：
状态镜像（干活/思考/等待审批/报错/庆祝/空闲）、分区热区互动（二期起为逐状态 bbox 精确热区）、拖拽、喂食、
表情包气泡（本地 30 张 + CDN 474 张热链）、Token/费用仪表板、XP/等级/称号养成、可全部关闭的主动陪伴；
二期新增：泡泡小游戏、39 成就 + 每日任务 + 每周签到的成长系统、节日/天气换装、余额不足提醒（默认关）、
musume/classic 双角色。

> 宿主基线（双车道）：`@deepseek-ai/dsh@0.1.7-rc.2`（存量 web 车道）+ `0.2.0-rc.2`（npm latest/next，与官方桌面端 0.2.0-rc.2 内置 runtime 同版）。兼容门禁经 `peerDependencies: { "@deepseek-ai/dsh": ">=0.1.7-rc.2" }` 声明。开发任务清单（鲸鱼娘桌宠-开发计划）为本地策划文档，不随仓库分发。

## 安装（官方桌面端）

桌面端（`@deepseek-ai/dsh-desktop` ≥ 0.2.0-rc.2）自带 dsh runtime 与 Node/pnpm，无需另装任何 CLI：

1. 启动一次 DeepSeek Harness Desktop（初始化保留 profile `desktop`），然后**完全退出**（Windows 托盘图标 → Quit）。
2. 安装本插件（二选一）：
   - 应用内：设置 → 插件管理器，添加 npm 包名 `dsh-whale-chan`、git 源或本仓库路径；
   - CLI：经桌面端菜单 **Manage dsh Command…** 安装 dsh 命令后，在终端运行 `dsh plugin --profile desktop add dsh-whale-chan`（或 git 源/本地路径）。
3. 重新打开桌面端，右下角出现鲸鱼娘；设置面板出现「鲸鱼娘桌宠」卡片。

注意：`desktop` profile 由 Electron 应用独占——npm 全局安装的 `dsh` 会对它报错拒绝，必须在应用完全退出后用桌面自带 CLI 操作，或直接走应用内管理器。CLI 版本跟随桌面端 release。

## 安装（dsh web）

```bash
npm i -g @deepseek-ai/dsh@0.1.7-rc.2   # 或当前 npm latest（0.2.0-rc.2）
dsh plugin --profile web add dsh-whale-chan   # npm 源（版本随 GitHub push 自动发版）
# 重启 dsh web 后，右下角出现鲸鱼娘；设置面板出现「鲸鱼娘桌宠」卡片。
```

git 源 / 本地路径安装（等价方式）：

```bash
dsh plugin --profile web add github:duyanta123/dsh-whale-pet
# 或：git clone https://github.com/duyanta123/dsh-whale-pet && dsh plugin --profile web add ./dsh-whale-pet
```

## 开发

```bash
npm test             # node --test 单测（纯函数域）
npm run test:compat  # 双车道探活：0.1.7-rc.2 + 0.2.0-rc.2 各自隔离 npm 安装进临时目录（不动全局），
                     # 每车道走 init profile → add → dump → 限时启动探活；可传参跑单车道，如 node scripts/compat.mjs 0.2.0-rc.2
node scripts/desktop-probe.mjs <桌面端安装目录>  # 解包桌面端 app.asar，核对本插件宿主耦合面（零依赖）
node serve.js        # 素材回归预览页（demo/，与插件宿主无关）
```

### 宿主升级跟随（每次官方 release）

1. `node scripts/desktop-probe.mjs <桌面端安装目录>`——核对槽位/事件/注入/路由/兼容门禁等全部耦合面；
2. `npm run test:compat`——双车道探活；
3. 桌面端真机冒烟：装入 `desktop` profile 后核对状态镜像、热区/拖拽、设置卡、telemetry 融合气泡与深夜红线。

## 数据融合（M6-4，dsh-local-telemetry）

与自有插件 [dsh-local-telemetry](https://github.com/duyanta123/dsh-telemetry) **零导入松耦合**（只读其 `~/.dsh/telemetry/YYYY-MM-DD.jsonl` 产物 + 复用其 adapter 事件映射语义，互不依赖包安装）：

| 融合项 | 实现 |
|---|---|
| 状态机增强 | 工具失败 / 模型重试 / 错误收尾后 15s 内 → `struggling` 遇挫表情（盖过 working 插曲） |
| 实测费用 | 任务完成后用 telemetry 实测 usage × 本插件价目表替换估算气泡（`source: 'telemetry'`，无数据保持估算兜底） |
| 拟人化播报 | 缓存命中率 / 工具失败数 / 最慢工具 → 数据驱动台词混入随机短剧池 |
| 周报递送入口 | `POST /api/whale-pet/announce`，body `{"text": "...", "ms": 8000}` → 桌宠气泡（2s 限流，单条 ≤500 字） |

融合总开关在设置卡「数据融合」区（写 `fusion.enabled`）。

## 性能（M6-2）

webm 按状态懒加载（进状态才装载，全库 26MB 不预载）；标签页隐藏（`visibilitychange`）暂停决策 tick 与视频解码，恢复即续；`prefers-reduced-motion` / 低内存（≤2GB）/ 少核（≤2 线程）自动降级静态图链；帧率上限不适用（`<img>`/`<video>` 原生解码 + CSS 过渡，无 rAF 渲染循环可限，见附录 B）。纯决策层浸泡：`node scripts/soak.mjs`（20 万步 + 堆趋势断言）。

## Roadmap（M6 收口时点）

- 官方桌面端 M6-3 实测（进行中）：`@deepseek-ai/dsh-desktop@0.2.0-rc.2` 已于 2026-09-29 发布，本插件宿主耦合面已解包核验通过（`scripts/desktop-probe.mjs`）；**窗口级能力已裁定：官方未暴露悬浮窗 API**（桌面 preload 仅提供启动就绪/目录选择/路径桥/Browser 桥，无 alwaysOnTop/透明悬浮窗类 IPC）——桌宠仍限于应用窗口内，出窗待二期 Tauri 伴侣壳。剩桌面端真机冒烟（安装/状态镜像/热区/设置卡/telemetry 融合）。
- 周报完整闭环：`dsh-data-insight` 的 `skills/data-insight-runbook` 产物经 `/api/whale-pet/announce` 递送的调度编排（注意 0.2.0 起自动化任务改由可选插件包提供，编排需确认目标 profile 已启用 schedule 包）。
- ~~二期 Backlog~~：**2026-10-02 完成**（泡泡小游戏 / 成长系统 / 节日·天气换装 / 余额提醒 / bbox 热区 / 多角色 / 表情包热链，见「二期功能」节）；范围外遗留两项——Live2D 路线（无模型产物、需自行绑模）、Tauri 伴侣壳（桌面端未暴露窗口级悬浮 IPC），详见开发计划 §4。

## 主动陪伴（M5）功能开关

设置面板「鲸鱼娘桌宠」卡片内集中配置（写入 `~/.dsh/whale-pet/settings.json`，即改即生效）：

| 开关 | 默认 | 说明 |
|---|---|---|
| 久坐提醒 | 开 / 45 分钟 | 固定间隔，用户交互重置计时；每轮只提醒一次 |
| 喝水提醒 | 开 / 60 分钟 | 同上 |
| 番茄钟 | **关** | 25 分钟专注 + 5 分钟休息循环气泡 |
| 情景短剧 | 开 / 40–80 分钟 | 内置 32 条台词随机气泡，避免连续重复 |
| 深夜静音 | 开 / 23:00–07:00 | 红线：静音段内无主动气泡、无音效、无散步；空闲显示深夜困倦态 |
| 周期散步 | 开 | 18–40s 随机间隔的 idle 漫游 |
| 完成音效 | **关** | 任务完成时宿主进程播系统提示音（绕过浏览器静音），受深夜静音约束 |
| 数据融合 | 开 | 实测费用 / 洞察台词 / 遇挫表情（见「数据融合」节） |

## 二期功能（2026-10-02）

| 功能 | 入口 / 说明 |
|---|---|
| 泡泡小游戏 | 设置卡「🎮 泡泡小游戏」按钮；4×4 棋盘 30s 限时，普通 🫧 +10 / 星 ⭐ +30 / 炸弹 💣 惊吓不扣分，连击加成 min(连击,10)×2，评级 ≥300 胜 / ≥150 平；game-* 五种姿势随局切换 |
| 成长系统 | 设置卡「成长」区：好感等级（500/级，上限 10000）、39 条成就（解锁弹气泡）、每日任务 3 槽（signin-1 恒在）领取、每周签到 7 天板（1/3/7 里程碑 +10/+20/+40）、连续签到 streak；好感与 Node 侧资历 XP 互不干扰 |
| 节日换装 | 自动：春节/中秋（农历查表 2026–2030）、万圣 10-31、圣诞 12-25，idle 兜底时穿节日装；可关 |
| 天气换装 | 设置卡「换装」区填城市（如「上海」，空 = 不查询）；30min 轮询 Open-Meteo（经宿主代理，无密钥），雨/雪/雷/伞/严寒五种换装，晴与雾不换装；可关 |
| 余额提醒 | **默认关**。设置卡「余额提醒」区：开关 + 阈值（1–100 CNY）+ DeepSeek API Key（密码框不回显，可显式清除；仅存服务端、不进日志、接口响应恒脱敏）；配置后约 10min 轮询 DeepSeek 余额，跌破阈值气泡提醒一次（同水位不重复，回升重置）+ balance-low 姿势 8s；失败指数退避封顶 60min；深夜静音段连轮询都暂停 |
| 表情包热链 | 默认开：474 张社区二创表情包 Supabase 公开桶直链（许可见下），后台探测失败静默回退本地 30 张；可关 |
| bbox 精确热区 | 逐状态首帧包围盒（92 张全表 + CI 同步校验），点在形象轮廓外不再误触发热区反应；classic 角色自动回退静态热区 |
| 双角色 | 设置卡「角色」下拉：鲸鱼娘（musume，默认）/ 经典小鱼干（classic）；classic 下 9 个基础状态换 classic 素材，musume 专属状态保持原链。新增角色见 `docs/adding-a-character.md` |

二期视觉细节（idle 兜底覆盖链 gamePose > night > balance-low > festival > weather、game-* 姿势映射表）
见 `docs/state-machine.md` 附录 A；素材链与 bbox 表口径见 `docs/sprites-spec.md` §5–§7。

## 许可矩阵（M6 收口前速览）

| 资产 | 许可 | 约束 |
|---|---|---|
| 本插件代码 | MIT | — |
| webm 50 段 | 来自 yanzwzz/dsh-whale-girl-pet（MIT） | 注明出处 |
| musume 92 张 | CC BY-NC-SA 4.0 | **非商用**，注明出处与相同方式共享 |
| classic / fatfish | 项目内重产素材 | 注明来源链 |
| memes 30 张（本地池） | 社区二创表情包 | 仅个人使用，商用需画师授权 |
| 表情包 CDN 474 张（热链，2026-10-02 接入） | 社区二创表情包（与本地 30 张同源同许可） | **仅个人使用，商用需画师授权**；热链仅在 `memeCdn.enabled` 开启时使用，关闭即回本地池 |
