# storyboard.json 结构

两层：**集 → 镜（shot）**。段（segment）是**可选的组织分组**（一个情绪弧线单元），不跨场次，不再是一次生成的单元。

- **镜** = 一次视频生成调用（一镜一视频），时长固定 1–6 秒，各自认领剧本节拍、带结构化元数据（空间/姿态/位置/情绪）、一张分镜图、一条 Seedance 提示词
- **段** = 可选分组：段内镜累加 = 段时长（默认 15s 情绪弧线单元），段内同场不跨景
- **分镜图** = 每个镜一张关键帧：`frame` 提示词 → 图模型（Seedream）生成，供视频生成当参考

```json
{
  "source": "渡口",
  "style": "写实向半厚涂",
  "params": { "maxShotSeconds": 6, "minCutSeconds": 1, "maxSegmentSeconds": 15, "maxOnScreen": 3, "tolerance": 0.15, "charsPerSecond": 5.5 },
  "episodes": [ { "ep": 1, "segments": [ ... ] } ]
}
```

`style`：全片视觉风格声明（如「写实向半厚涂」「真人电影风格」），出现在每镜提示词头部，同剧画风统一。`charsPerSecond`：中文台词语速（默认 5.5 字/秒）。

`styleMode`（可选）：画风模式 `preset`（默认）/ `session`（外部风格库钉会话）。**novel-assets 以本文件的 styleMode 为主源**（D3）：`session` 时出图包说明.txt 顶部写守门句「若未在会话开头收到画风先停下提醒」，且不传 `--style-ref`（画风全信会话）。缺省按 `preset`，老 JSON 不回填。

## segment（段 · 可选分组）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 段号 `E01-01`：集号 + 两位序号，按顺序连号。作组织标签用 |
| `sceneIndex` | int | 这一段在剧本该集的第几场（1 起）。段内全部镜同场 |
| `shots` | shot[] | 段内镜，按时间顺序。段总秒数 = 镜秒数之和，不单独存 |
| `note` | string | 备注，可选 |

## shot（镜）— 根

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `beats` | [int, int] | 认领该场第几拍到第几拍（含两端），**节拍编号从 1 起**（该场第 1 拍 = `1`，validate 按 1-based 对账，写 0 会判不合法）。每个节拍必须被恰好一个镜认领，按顺序、连续 |
| `seconds` | number | 镜时长，1–6 秒固定。认领节拍的台词秒数必须装得下（语速 5.5 字/秒） |
| `size` | enum | 景别：`extreme-wide` 大远景 / `wide` 全景 / `medium` 中景 / `close` 特写 / `extreme-close` 大特写 |
| `camera` | enum | 运镜，用 Seedance 词表（见 seedance-prompt.md）：`Static` `Push In` `Pull Out` `Zoom` `Pan` `Truck` `Tilt` `Pedestal` `Arc` `Tracking` `POV` `Shake` `Roll` |
| `characters` | string[] | 画内人物（剧本 ID，如 `C01`；报告显示设定图名字），必须 ⊆ 剧本该场人物。> maxOnScreen 时带 `note` |
| `props` | string[] | 画内道具（设定图名字），必须 ⊆ 剧本该场道具。可省略 |
| `frame` | string | 分镜图提示词：这一格关键帧的样子。景别英文短语必须在里面；禁角色名 |
| `space` | string | 空间：本镜所在环境（如「昏暗狭小房间远端」） |
| `pose` | string | 姿态：全画内角色，`@角色-姿态描述; @角色-姿态描述`（分号分隔） |
| `position` | string | 位置：全画内角色，`@角色-位置、面朝@谁; ...`（含视线关系） |
| `mood` | string | 情绪：只写本镜主角，`@角色-情绪 程度/10` |
| `shotDesc` | string | 视频视觉描述（自然语言：运镜/光影/微动作/时间维度） |
| `sceneImage` | string | 场景图路径（提示词外单独绑定，环境参考图） |
| `seedancePrompt` | string | 每镜一条 Seedance 提示词，模型照 `seedance-prompt.md` 手写；validate 逐字对账（见下） |
| `recipe` | string | 镜头配方卡 id，可选（同原逻辑） |
| `note` | string | 备注，可选 |

## seedancePrompt 的结构（模型手写，validate 对账）

写法照 `references/seedance-prompt.md`。骨架：

```text
<style>，画面不要出现任何文字，生成视频无BGM；

c<镜号>,<seconds>s,(空间:<space>)(姿态:<pose>)(位置:<position>)(情绪:<mood>)
<shotDesc>
@说话人用中文[语气]地说道<台词>
【不出现任何文字字幕】
```

确定性检查：

1. **头部**：风格声明 + 无文字 + 无 BGM 约束齐全
2. **镜号行**：`c01,4s` 格式，秒数 = 本镜 `seconds`，与字段一致
3. **元数据四件套**：空间/姿态/位置/情绪字段齐全，`@绑定` 全部 ∈ 资产库（角色/道具设定图名字）
4. **台词**：按剧本原始语言，说话人 + 语气，`<台词>` 逐字保留
5. **无字幕**：每镜 prompt 带「不出现任何文字字幕」

## 时长约束链

台词秒数（字数 ÷ 5.5，情绪系数联动：紧张 ×1.1 / 温情 ×0.9）≤ 镜 `seconds` ≤ 6 秒；
长台词优先拆镜（拆不动可给到 6s）；
段 Σ镜 ≤ 15 秒；集 Σ段 落在剧本 `targetSeconds` ±15%。全部由 validate 逐级对账。
