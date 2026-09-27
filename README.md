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

## 开发

```bash
npm test          # node --test 单测（纯函数域）
npm run test:compat  # 隔离 profile 安装 + 配置 dump + 限时启动探活（锁定 0.1.7-rc.2）
node serve.js     # 素材回归预览页（demo/，与插件宿主无关）
```

## 许可矩阵（M6 收口前速览）

| 资产 | 许可 | 约束 |
|---|---|---|
| 本插件代码 | MIT | — |
| webm 50 段 | 来自 yanzwzz/dsh-whale-girl-pet（MIT） | 注明出处 |
| musume 92 张 | CC BY-NC-SA 4.0 | **非商用**，注明出处与相同方式共享 |
| classic / fatfish | 项目内重产素材 | 注明来源链 |
| memes 30 张 | 社区二创表情包 | 仅个人使用，商用需画师授权 |
