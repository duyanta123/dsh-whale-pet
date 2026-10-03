# 新增角色指南（adding-a-character）

> 二期角色体系（2026-10-02）：`lib/client/characters.mjs` 提供角色注册表与「参数化链序主备互换」
> 纯函数 `swapChains`；`assets-manifest.mjs` 的 `setCharacter(id)` 以它为内核换表，
> `settings.character` 分区（默认 `'musume'`，非 `'classic'` 一律归一化回 `'musume'`）经设置卡
> 热应用。本文说明再加一个角色（如 fatfish 套完整化、或全新形象）的最低要求与接入步骤。

## 1. 互换规则（characters.mjs 的语义，先读再动手）

`swapChains(stateAssets, characterId)` 是纯函数：

- 归一化后非目标角色（`normalizeCharacterId`：仅 `'classic'` 原样通过，其余含脏数据一律回
  `'musume'`）→ **原样返回入参**（同一引用，零拷贝）——回默认角色零成本；
- 目标角色 → 逐状态检查链内是否存在 **`assets/classic/<状态名>.webp` 精确条目**：
  - 存在且不在链首 → 该条目整体提到链首（entry 对象原引用保留，motion/kind/playback 字段不动，
    其余条目相对顺序不变）；
  - 不存在或已在链首 → 该状态沿用原 def 引用；
- 返回冻结新映射、绝不改入参；同一入参的 classic 结果经 WeakMap memo 复用（幂等可重入：
  反复热应用 `f(f(S))` 深等 `f(S)`，不漂移。语义是「升主即稳」而非切换开关——回默认角色由
  musume 路径承担）。

**当前 classic 套实测结果**（`test/characters.test.mjs` 固化）：恰 9 个状态互换
（think/wait/celebrate/error/disappointed/sleep/eat/drag/idle）、5 个已链首不动
（welcome/wake/play/joy/walk）、3 个 musume 专属原链（working/night/struggling）。

三个易踩的口径：

1. **精确条目**：只认 `assets/classic/<状态名>.webp` 与状态键完全同名的条目。近名
   （`classic/<状态名>-x.webp`）与链内借用件（night 链里的 `classic/sleep.webp`）**不算**对应件。
2. **链内存在才互换**：`assets/classic/working.webp` 虽在盘上，但 working 链（pick:'random'
   的 webm 插曲池）未引用它 → 保持 webm 原链。若想让某状态被覆盖，先把该文件加进该状态链。
   注意 `pick:'random'` 的视频插曲链若加入 image 对应件并升主，会把 image 提到随机视频池之前、
   改变池语义——如需支持须先明确语义（characters.mjs 头注已记）。
3. **热区自洽免费获得**：classic 下 9 个基础状态链首变为 classic 文件后，`bbox.mjs` 按实时链首
   查 bbox 表自然 miss → 回退 `hitzone.mjs` 静态热区——热区跟随显示素材几何，**无需任何特判**。

## 2. 素材最低要求（新角色接入门槛）

| 要求 | 说明 |
|---|---|
| 命名规范 | `assets/<角色目录>/<状态名>.webp`——文件基名必须与状态键精确同名（互换规则按此识别对应件） |
| 覆盖面 | 一期 15 基础状态各一件（welcome/think/wait/celebrate/error/disappointed/sleep/wake/eat/play/joy/drag/walk/idle + 建议补 working）；night/struggling 与二期 game-×5/festival-×4/weather-×5/balance-low 为 musume 专属换装面，缺省自动回落 musume 原链（可接受） |
| 格式 | 动画 WebP（`kind:'image'`，时序内嵌）；整段动画、朝左基准（flip=±1 镜像由 renderer 处理） |
| 底部对齐 | 与现有套一致按画面底部对齐（`object-position: bottom`） |
| 许可 | 可商用许可或与 musume 套同级的明确授权声明（README 许可矩阵需加行） |

## 3. 接入步骤（以假想第三角色 `koi` 为例）

1. **素材入库**：`assets/koi/<状态名>.webp` ×15（命名规范见上），跑
   `python tools/analyze-bbox.py` 无需（bbox 表只覆盖 musume；koi 链首查表自然 miss 回退静态热区）。
2. **注册表**：`lib/client/characters.mjs` 的 `CHARACTERS` 加
   `koi: Object.freeze({ id: 'koi', label: '…' })`；`normalizeCharacterId` 从
   `v === 'classic' ? 'classic' : 'musume'` 扩展为三值归一（白名单外的仍回 `'musume'`）。
3. **互换参数化**：`swapChains` 目前把目标目录硬编码为 `assets/classic/`（模块内常量
   `CLASSIC_DIR`）——第三角色需把「对应件识别前缀」按角色参数化（如 `swapChains(stateAssets, characterId)`
   内按 `CHARACTERS[characterId].dir` 取前缀），并为 musume 路径保留「原样返回」快捷分支。
   这是本模块预留的扩展点（文件头注已注明）。
4. **换表接线**：`assets-manifest.mjs setCharacter(id)` 已按 `swapChains(STATE_ASSETS, id)` 通用化，
   第 3 步完成后无需再改；`settings.mjs` 的 `character` 分区纠正与设置卡下拉加一个
   `<option>` 即可。
5. **契约登记**：若 koi 素材也要进状态链的备选位（如 idle 链第三位），在
   `lib/client/assets-manifest.mjs` 对应链登记 `img('assets/koi/idle.webp')`，并同步
   `assets/manifest.js` 旧面（demo 预览页）——`test/manifest.test.mjs` 漂移守卫强制两者一致。
6. **回归**：`npm test` 全绿（characters/manifest/bbox/logic 门禁）+ 设置卡切角色实机看一遍
   各状态与热区。

## 4. 明确不做的

- REACT_ASSETS（react-head/belly/tail 热区反应）不参与互换：classic 套无对应件，二期亦未规划。
- 每状态多套表情变体、按情绪换肤：超出现有链语义（主备降级），需要时先扩展契约字段再动。
