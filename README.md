# dsh-whale-pet · 鲸鱼娘桌宠

住进 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web 界面的鲸鱼娘桌宠插件：
状态镜像（干活/思考/等待审批/报错/庆祝/空闲）、分区热区互动、拖拽、喂食、表情包气泡、
Token/费用仪表板、XP/等级/称号养成、可全部关闭的主动陪伴。

> 宿主基线：`@deepseek-ai/dsh@0.1.7-rc.2`（npm next 标签）。任务清单见 `../鲸鱼娘桌宠-开发计划.md`。
> 本 README 为 M0 占位版；安装方式、功能开关说明与许可矩阵随 M6 补全。

## 安装（开发版）

```bash
npm i -g @deepseek-ai/dsh@0.1.7-rc.2
dsh plugin --profile web add <本仓库路径>
# 重启 dsh web 后，右下角出现鲸鱼娘；设置面板出现「鲸鱼娘桌宠」卡片。
```

git 源分发（无 npm 包时的等价方式）：

```bash
git clone <本仓库> && dsh plugin --profile web add ./whale-pet
```

## 开发

```bash
npm test          # node --test 单测（纯函数域）
npm run test:compat  # 隔离 profile 安装 + 配置 dump + 限时启动探活（锁定 0.1.7-rc.2）
node serve.js     # 素材回归预览页（demo/，与插件宿主无关）
```

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

- 官方桌面端（Electron `apps/desktop`）实测：0.1.7-rc.2 的 `dsh` CLI 尚无 desktop 应用（`dsh --help` 仅 web/tui/headless/rescue），窗口级能力（桌宠悬浮于应用窗口之外）待官方发布后实测。
- 周报完整闭环：`dsh-data-insight` 的 `skills/data-insight-runbook` 产物经 `/api/whale-pet/announce` 递送的调度编排。
- 二期 Backlog：泡泡小游戏 / 成就系统 / 节日换装 / 动态 bbox 逐帧热区 / Live2D / 多角色 / Supabase 表情包热链 / Tauri 伴侣壳（见开发计划 §4）。

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

## 许可矩阵（M6 收口前速览）

| 资产 | 许可 | 约束 |
|---|---|---|
| 本插件代码 | MIT | — |
| webm 50 段 | 来自 yanzwzz/dsh-whale-girl-pet（MIT） | 注明出处 |
| musume 92 张 | CC BY-NC-SA 4.0 | **非商用**，注明出处与相同方式共享 |
| classic / fatfish | 项目内重产素材 | 注明来源链 |
| memes 30 张 | 社区二创表情包 | 仅个人使用，商用需画师授权 |
