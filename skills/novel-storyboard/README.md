**中文** · [English](README.en.md)

# novel-storyboard

给 AI 短剧出**分镜**（Seedance 一镜一视频版）：把 novel-script 的节拍流切成可以直接下单给 Seedance 的生成任务单。这是管线里第一个直接面对视频模型的层，前提刻在骨子里：**一镜一视频，每镜独立生成、时长固定**。结构：

```
集（episode）
 └─ 段（segment）＝ 可选组织分组，≤ 15 秒情绪弧线单元，不跨场次
     └─ 镜（shot）× 2–4 ＝ 每镜独立一次生成，时长固定 1–6 秒（硬门），各自认领剧本节拍
         ├─ 结构化元数据：空间/姿态/位置/情绪（@设定图绑定）
         ├─ 视觉描述（shotDesc）：一个主运镜 + 光影 + 微动作 + 时间维度
         ├─ 台词：@说话人用中文[语气]地说道<台词>（原语言逐字）
         └─ 无字幕约束
```

- **每镜一图一提示词**——分镜图 `frame`（供 Seedream 出参考图）+ `seedancePrompt`（模型手写、validate 逐字对账，直接下单给 Seedance），独立生成
- **@绑定 = 设定图**——`@老张` `@蒲扇` 都是上传的设定图（角色/道具），+ 场景图（`sceneImage` 提示词外），全参考、文字只管构图动作情绪
- **固定时长写死**——镜号行 `c01,4s` 就是生成参数；台词秒数（÷5.5）必须装得下；长台词优先拆镜
- **分镜图是资产合成，不是凭空画** — 出图挂场景/角色/道具设定图当参考图。有图模型就真出图（可选）

产出 `storyboard.json` + Markdown + 一个双击就能开的 `storyboard-report.html`：

![storyboard-report.html](assets/report.webp)

## 质量门：17 道（+ 可选第 18），全是代码

与仓库里另外四个 skill 同一主张：**checklist 交给模型自觉是靠不住的**。

| 门 | 规则 |
| --- | --- |
| **节拍全覆盖** | 剧本每个节拍被恰好一个镜认领、按顺序、连续、不跨场 |
| 段时长 | 段 Σ镜 ≤ 15 秒（情绪弧线分组上限） |
| **镜时长** | 每镜 1–6 秒固定——短剧节奏是**硬门**不是建议；反应镜可 1s |
| 台词装得下 | 认领节拍的台词秒数（÷5.5，情绪系数联动）≤ 镜秒数，逐镜检查 |
| 每集总时长 | Σ段 落在剧本 `targetSeconds` ±15% 内 |
| 同框上限 | 单个镜 ≤ 3 人，超了必须带拆解说明 |
| 段号纪律 | `E01-01` 格式、按顺序连号 |
| 景别短语 | `close-up` 这类英文短语必须出现在分镜图提示词里 |
| 运镜词表 | 运镜用 Seedance 词表（`Push In` / `Tracking`…），落在自己的镜描述里 |
| **镜固定时长+段累加** | 每镜 `seconds` 与 `seedancePrompt` 镜号行逐字对账；段内镜累加 = 段时长 |
| **台词原语言逐字** | `@说话人用中文[语气]地说道<台词>`——按剧本原语言，改一个标点都过不去 |
| **无字幕约束** | 每镜 `seedancePrompt` 带「不出现任何文字字幕」 |
| **风格短语统一** | `style` 声明（如「写实向半厚涂」）出现在每镜 `seedancePrompt` 头部——同剧不许画风漂 |
| 分镜图提示词卫生 | 全英文非空 |
| 提示词不含角色名 | 分镜图提示词恒查 |
| **@绑定↔资产** | 元数据里的 `@X` 全部 ∈ 资产库（角色/道具设定图名字） |
| 引用对账 | 场次/人物/道具全部对账剧本该场 |
| **镜头配方**（可选第18） | 给了 `--shots <卡片目录>` 才查（同原逻辑） |

自测里每道门都有**击穿用例**——证明它真的会拦。

**镜头配方是可选挂载的语汇层**：shot 上可以写可选的 `recipe`（[shot-recipes](../shot-recipes) 的卡片 id）。没装 shot-recipes 照跑不误——本 skill 自包含。卡片的**建议景别与运镜刻意不设门**，只在报告提示偏离：配方是语汇不是法条，**误拦的门比没有门更糟**。

## 门失败会累积，`stats` 告诉你模型最常违反哪条规则

`validate` 与 `checkup` 每次都把门的结果追加到**当前目录**的 `.gates.jsonl`。积累几十次之后：

```bash
node scripts/novel-storyboard.mjs stats
```

回答三个问题：**哪道门最常响**（该改规则措辞，不是骂模型）· **哪道门从没响过**（死门/已内化）· **失败详情长什么样**（反复出现却无门的问题靠人看）。不想记加 `--no-log`。

## 报告长什么样

业内评审用的单页报告，页宽 1600：

- **KPI 带**：段数 / 镜数与平均秒数 / 总时长 vs 目标 / 生成批次数 / 台词段数
- **分镜节奏带**（招牌图）：每集一行色带，**粗分隔 = 段边界（情绪弧线分组）**，片宽 = 镜时长占比、颜色深浅 = 景别远近——深浅相间、长短相间就是好节奏；点一片跳到那张段卡
- **分集分镜表**：每段一张卡——**分镜图** 16:9（缺图显示提示词占位，**不装有**）、下方**五五分栏**：左列逐镜行（`c01,4s` · 景别 · 运镜 · **结构化元数据 chips（空间/姿态/位置/情绪）** · 画面摘要**从剧本认领的节拍自动带出**），右列 **seedancePrompt 面板**——等宽字体，一键复制
- **生成批次单**：同场景 + 同光照的镜归一批，共用同一张环境参考图——批次卡嵌场景设定图
- **配音对齐单**：每句台词对到**段号#镜序**——TTS 音频贴到哪一镜，全自动
- **质量门**面板 + 页眉徽章 + **导出 JSON**（下载的就是 `storyboard.json` 原样）
- 全部图形内联 CSS/SVG，零外部依赖，离线双击能开

## 五个 skill 的接力（管线到此闭环）

```
novel-outline    → outline.json    （什么：结构与分集）
novel-characters → cast.json       （谁：角色设定图）
novel-art        → art.json        （哪里：场景/道具设定图）
novel-script     → script.json     （戏：场次、节拍、台词）
novel-storyboard → storyboard.json （怎么拍：镜、结构元数据、提示词、批次）
```

- `seed <script.json> --eps 1-3` 确定性展开每场的节拍清单（编号、每拍秒数、说话人）当切镜底稿——**每拍几秒是算出来的（÷5.5），不让模型重新估**
- `validate --script` 是硬前提；`--outline` / `--cast` 查提示词人名（@绑定白名单），`--art` 让报告显示场景名并在批次单嵌设定图
- 分镜图出图走图模型，场景/角色/道具设定图当参考图；`seedancePrompt` + 整套分镜图直接下单给 Seedance

## 命令行直接用

```bash
node scripts/novel-storyboard.mjs seed script.json --eps 1     # 切镜底稿
node scripts/novel-storyboard.mjs validate sb.json \
     --script script.json --outline outline.json --cast cast.json
node scripts/novel-storyboard.mjs checkup sb.json --script script.json
node scripts/novel-storyboard.mjs validate sb.json --script script.json \
     --shots ../shot-recipes/references/cards                            # 可选：开第 18 道配方门
node scripts/novel-storyboard.mjs render sb.json --html \
     --script script.json --outline outline.json --art art.json > storyboard-report.html
node scripts/novel-storyboard.mjs export sb.json --script script.json   # 投产包
```

`export` 的投产结构固定：**每段一个文件夹** `E01-01/`——分镜图 `f1..fN.png` 和 `prompt.md` 同住（**每镜一条 seedancePrompt**），根部 `manifest.json` 带图清单、缺图标注。一个段文件夹 = 一镜一视频的全部材料。

## 边界

- 不写戏不改台词、不出设定图、不做视频生成与剪辑合成
- 口型/唇形同步暂不管——那是生成管线的事
- 秒数是**下给 Seedance 的生成时长**不是估算；镜上限、段时长都在 `params` 里按模型调
- 分镜图默认先出第一段的整套（3–5 张）看效果，确认画风再往后补

## 文件

```
SKILL.md                 给 agent 读的工作流
scripts/
  novel-storyboard.mjs   seed / validate / checkup / render / export / slug
  selftest.mjs           240+ 项断言，不调模型
references/
  schema.md              storyboard.json 结构 + 时长约束链
  seedance-prompt.md     Seedance 每镜提示词写法规范 + 摄影参考
  storyboard-pass.md     切镜：分组规则、定时长四步法、导演手感、常见病
  directing-read.md      导演读解：切镜前的戏判断（转折/视角/权力/潜台词）★内化自 seedance-20-ytdx
  directing-engine.md    导演引擎：场景怎么拍（意图/景别/表演行为化/连贯性）★内化自 seedance-20-ytdx
  cinematography-shot-language.md  镜头语言：景别/运镜/机位怎么说 ★内化自 seedance-20-ytdx
  frame.md               分镜图出图的调用契约
  report-style.md        报告的设计约定
examples/
  渡口-storyboard.json    《渡口》第 1 集完整分镜（新 schema），全部质量门通过，也是自测夹具
assets/
  report.webp            报告截图
```

## 自测

```bash
node scripts/selftest.mjs
```

240+ 项断言，覆盖节拍展开 / 元数据对账 / 统计与批次 / 质量门逐项击穿 / 配方卡库解析与挂载 / seed / 渲染（含中英界面）/ 导出。不调模型、不花额度、1 秒跑完。改完脚本先跑这个。

**只在 macOS + Node 24 上实测过（上游）；YTDX fork 在 Win11 + Node 24 验证。**
