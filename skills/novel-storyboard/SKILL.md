---
name: novel-storyboard-ytdx
version: 1.4.0-ytdx.1
description: |
  给 AI 短剧出分镜（Seedance 一镜一视频版）：镜（每镜独立一次视频生成，时长固定 1–6 秒）是根，
  每镜带结构化元数据（空间/姿态/位置/情绪，@设定图绑定）→ 视觉描述 → 台词（原语言+语气）→ 无字幕约束，
  组装成一条 Seedance 提示词。段作为可选组织分组（15 秒情绪弧线单元，不跨场）。
  每镜一条分镜图提示词（frame，供 Seedream 出参考图）。产出 storyboard.json + Markdown + 单页评审报告
  （分镜节奏带/分集分镜表/批次单/配音对齐单，报告显示结构化元数据 + seedancePrompt + @绑定图）。
  内化导演层（directing-read/directing-engine/cinematography-shot-language，自 seedance-20-ytdx），
  切镜前强制导演读解，景别/运镜/表演有导演判断。
  17 道质量门全部由脚本确定性检查（+ 可选 shot-recipe 卡库第 18 道）；export 每镜出投产 prompt.md。
  零依赖、零 API key，用当前会话额度。
  Use when asked to 分镜、出分镜、镜头表、切镜、storyboard for AI short drama。
allowed-tools:
  - Read
  - Write
  - Bash
  - Task
  - Glob
triggers:
  - novel-storyboard
  - 分镜
  - 出分镜
  - 镜头表
  - 切镜
  - storyboard
  - shot list
metadata:
  license: Apache-2.0
  requires:
    bins:
      - node          # >= 18，只用标准库，无 npm 依赖
  runtimes:
    - claude-code
    - codex
---

## novel-storyboard

给 AI 短剧出**分镜**——管线里第一个直接面对视频模型的层。**前提刻在骨子里：一镜一视频，每镜独立生成、时长固定**。镜的时长就是下单给 Seedance 的生成参数，写死、可对账。

**核心机制：镜头认领节拍。** 每个镜声明它覆盖剧本某场的哪几个连续节拍（`sceneIndex` + `beats: [起, 止]`），镜不许跨场次——换景必换镜。这让分镜和剧本的关系变成可机械对账的：

| 交付 | 解决什么 |
| --- | --- |
| 节拍认领 | 每个节拍被恰好一个镜认领、顺序不乱——剧本改了重跑 validate，失效的镜当场点名 |
| 镜固定时长 | 每镜 `seconds` 1–6 秒，就是生成参数；台词秒数（÷5.5）必须装得下 |
| 结构化元数据 | 空间/姿态/位置/情绪四件套，全带 `@设定图` 绑定——角色/道具/场景图全参考 |
| 视觉描述 | 每镜一条 shotDesc：一个主运镜 + 光影 + 微动作 + 时间维度；景别是枚举、焦段可查表 |
| **Seedance 提示词（每镜一条）** | 模型照 seedance-prompt.md 手写：风格声明 + 镜号行（固定时长+元数据）+ 视觉描述 + 台词 + 无字幕约束，validate 逐字对账 |
| 台词 | `@说话人用中文[语气]地说道<台词>`——按剧本原始语言逐字 |
| 生成批次单 | 同场景 + 同光照的镜归一批，共用同一张环境参考图——AI 版顺场表，脚本自动汇总 |
| 配音对齐单 | 每句台词对到镜号——TTS 音频贴到哪一段视频，脚本自动汇总 |

`{baseDir}` = 本文件所在目录。脚本 `{baseDir}/scripts/novel-storyboard.mjs`，零依赖，`node` 直接跑。

**边界（不做的事）**：不写戏不改台词（`novel-script` 的活）、不出场景/角色/道具设定图（`novel-art` / `novel-characters` 的活）、不做视频生成与剪辑合成。口型/唇形同步暂不管——那是生成管线的事。

---

### Step 0 — 定输入与范围

**script.json 是硬前提**——分镜离开剧本没有意义，validate/render 都必须给 `--script`。其余上游按有则用：

- `--outline` / `--cast`：提示词禁人名检查（设定图名字白名单）+ 报告里 C01 显示成人名
- `--art`：报告里 S01 显示成场景名 + 批次单嵌场景设定图（`sceneImage` 从这来）
- `--shots <卡片目录>`：**可选**挂载 shot-recipes 的镜头配方卡库（指向 `shot-recipes/references/cards`），开第 18 道 `shot-recipe` 门。没装 shot-recipes 就别给——本 skill 自包含，不依赖它

**一次切几集**：跟剧本的批次走（剧本写到哪就分到哪），默认一批 ≤ 3 集。

### Step 1 — seed 工作底稿

```bash
node {baseDir}/scripts/novel-storyboard.mjs seed <script.json> --eps 1-3 > <workdir>/storyboard.json
```

确定性展开：每场的节拍清单（编号、动作/台词、每拍秒数、说话人）进 `seedScenes`，这就是切镜时的工作底稿。**每拍几秒是算出来的（台词字数 ÷ 5.5），不要让模型重新估。** shots 留空，切镜才是模型的活。

### Step 2 — 逐集切镜

每集一份任务，能并发就并发。每份任务拿到：

- `{baseDir}/references/storyboard-pass.md` 和 `{baseDir}/references/schema.md` 和 `{baseDir}/references/seedance-prompt.md`（读它们，照着做）
- **导演层（内化自 seedance-20-ytdx，切镜前必须读）**：`{baseDir}/references/directing-read.md`（这段戏要干什么→十字段判断）+ `{baseDir}/references/directing-engine.md`（场景怎么拍→意图/景别/表演/连贯性）+ `{baseDir}/references/cinematography-shot-language.md`（镜头手段怎么说→景别/运镜/机位）
- 该集的 seedScenes 底稿 + 场景卡（art.json 的锚点与光照提示词）+ 角色卡（cast.json 的形象要点）

流程：**先做导演读解**（读 directing-read：这一段戏的转折/视角/权力/潜台词是什么，读解不写进提示词，只指导切镜）→ **再按情绪弧线分组**（每段 ≤15 秒、不跨场，一段一个"起势→反转"单元）→ **段内切 1–6 秒的镜**（对话正反打、关键动作插入特写、反应镜可 1 秒——切镜语法都在 storyboard-pass.md）→ 每镜写结构化元数据 + 一条视觉描述。

**导演判断三原则（写每镜时对照）**：
1. **景别跟着情绪走，不是统一中景**——亲密对话用近景怼脸、反应用特写、关系变化用过肩/侧拍
2. **运镜有理由**——揭示戏该推近、灾难戏该升降/横移、权力戏该低机位；固定机位留给口型/身份/连贯锚点。不为动而动
3. **表演是动作不是情绪词**——"林风很期待"换成"林风把蝴蝶结举到眼前，眼睛跟着它慢慢发亮"；台词跟画面对上，画面在演谁，台词就是谁说

**每镜一条 `seedancePrompt`**，照 `{baseDir}/references/seedance-prompt.md` 写。要点：头部风格声明（全片统一）+ 无文字无BGM；镜号行 `c<镜号>,<秒数>s`（秒数 = `seconds` 字段，一个字符都不许漂）；元数据四件套（空间/姿态/位置/情绪）全带 `@设定图` 绑定；台词 `@说话人用中文[语气]地说道<台词>` 按剧本逐字；每镜带无字幕强调。

切完把 `seedScenes` 删掉。

### Step 3 — 校验 ⛔ 不能跳

```bash
node {baseDir}/scripts/novel-storyboard.mjs validate <storyboard.json> \
  --script <script.json> --outline <outline.json> --cast <cast.json> \
  [--shots <shot-recipes/references/cards>]
```

17 道质量门全是代码：节拍全覆盖（镜级，恰好一次、按顺序、连续）、段 ≤15 秒、**每镜 1–6 秒固定**、台词装得进镜（语速 5.5）、每集总时长在剧本目标 ±15% 内、同框 ≤ 3 人（超了必须带拆解说明）、段号 E01-01 格式连号、景别短语在分镜图提示词里、**风格短语统一**（`style` 自由文本，同剧画风不许漂）、运镜用 Seedance 词表且落在自己的镜描述里、**镜号行秒数 = seconds 字段**（每镜固定时长）、**台词按剧本原始语言逐字**、**每镜提示词带无字幕约束**、分镜图提示词全英文非空、分镜图提示词不含角色名、**@绑定全部 ∈ 资产库**（角色/道具设定图名字）、场次/人物/道具对账剧本、**镜头配方对账**（可选门，见下）。

**有违规逐条修，改完重跑，直到通过。**

**第 18 道 `shot-recipe`（可选挂载）**：给了 `--shots` 才查，不给就明说跳过。规则同原：id 在卡库里、卡片的每条 `must_phrases` 出现在该镜的 `frame` 里、多格配方靠连续同 id 的镜表达。卡片的建议景别与运镜不设门，只在报告提示偏离。

### Step 4 — 出分镜图（可选）

一切一张 16:9 关键帧，走图模型（Seedream / 豆包视觉），读 `{baseDir}/references/frame.md` 照契约做。要点：

- **没有图模型就整步跳过**，只交提示词，报告显示占位不装有
- **参考图是命根子**：挂上该段场景设定图（`sceneImage`）+ 画内角色设定图 + 涉及道具设定图，提示词只负责取景和此刻的姿态
- 一格一次调用绝不批量；输出 `./<段号>/f<切序>.png`
- **默认先出第一段的整套分镜图给用户看效果**（3–5 张），确认画风再往后补
- 单个失败跳过不阻断，最后汇总说明

### Step 5 — 输出与汇报

```bash
cd <输出目录>
node {baseDir}/scripts/novel-storyboard.mjs render <剧名>-storyboard.json --md \
  --script <script.json> --outline <outline.json> --art <art.json> > <剧名>-storyboard.md
node {baseDir}/scripts/novel-storyboard.mjs render <剧名>-storyboard.json --html \
  --script <script.json> --outline <outline.json> --art <art.json> > storyboard-report.html
```

报告界面语言用 `--lang zh|en` 指定（只切界面标签，与提示词语言互相独立）。报告含：KPI 带、分镜节奏带（粗分隔 = 段边界、片宽 = 镜时长占比、颜色深浅 = 景别远近、点击跳段卡）、分集分镜表（**显示结构化元数据 + seedancePrompt + @绑定图** + 复制按钮）、生成批次单、配音对齐单、质量门、导出 JSON。Markdown 版每镜附完整 seedancePrompt，直接复制可用。

汇报一句话说清：几集几镜、总时长 vs 目标、几个生成批次、出了几张分镜图、报告路径；没过的门和没出的图明说。

最终落地：

```
<输出目录>/
├── <剧名>-storyboard.json
├── <剧名>-storyboard.md
├── storyboard-report.html         ← 双击就能开
├── manifest.json                  ← export 生成
└── E01-01/                        ← 一段一个文件夹
    ├── f1.png                     ← 分镜图（有图模型才有）
    ├── f2.png …
    └── prompt.md                  ← 每镜一条 Seedance 提示词（export 生成）
```

---

## 五个 skill 的接力（管线到此闭环）

```
novel-outline    → outline.json    （什么：结构与分集）
novel-characters → cast.json       （谁：角色设定图）
novel-art        → art.json        （哪里：场景/道具设定图）
novel-script     → script.json     （戏：场次、节拍、台词）
novel-storyboard → storyboard.json （怎么拍：镜、结构元数据、提示词、批次）
```

分镜是消费端：seed 吃 script.json，分镜图出图吃 art 和 characters 的设定图当参考，seedancePrompt 直接下单给 Seedance，配音对齐单接 script 台词本的 TTS 产物。五份 JSON 各自的报告都带导出按钮。

## 边界

- 报告界面内置中英（`--lang`，默认中文）；提示词语言：台词保留剧本原语言，其余中文
- 镜 `seconds` 是**下给 Seedance 的生成时长**不是估算——上限按你的模型改 `params.maxShotSeconds`
- 一镜一视频：每镜一次生成调用，段是组织分组不是生成单元
- 口型/唇形同步暂不管——那是生成管线的事
- 分镜图不追求一次到位——它是给视频模型的构图锚，构图对、资产对就够，微调交给重生成

## 门失败会累积

`validate` 与 `checkup` 每次都把门的结果追加到**当前目录**的 `.gates.jsonl`；跑 `stats` 汇总：

```bash
node {baseDir}/scripts/novel-storyboard.mjs stats
```

回答三件事：**哪道门最常响**、**哪道门从没响过**、**失败详情长什么样**。不想记加 `--no-log`。

## 自测

```bash
node {baseDir}/scripts/selftest.mjs
```

240+ 项断言，不调模型、不花额度。17 道质量门每一道都有击穿用例。改完脚本先跑这个。

## 自带样例

`{baseDir}/examples/渡口-storyboard.json`：《渡口》第 1 集完整分镜——已按新 schema 重构（镜级：结构化元数据 + 固定时长 + seedancePrompt）。当质量基准，也是自测夹具。
