---
name: novel-assets-ytdx
version: 1.5.0-ytdx.1
description: |
  给 AI 短剧出图的闭环阶段（五段管线后的第 6 段）：把 cast/art/storyboard 里已写好的
  image.sheet 与 frame 提示词打包成「出图包 zip」（整个发给 GPT），图回来归位，report 补图。
  不写提示词（上游五段已写好）、不生成图（GPT 网页版自动完成）、不改任何现有 JSON。
  脚本三个命令：run（产出 <剧名>-出图包.zip：说明.txt + 01_设定图提示词.txt + 02_分镜图提示词.txt，
  可选 --style-ref 样张图入包 style-ref.png 作画风锚 + --negative 负面词）、
  place（图归位）、render（转发各 skill 补 report）。人机配合：用户把 zip 整个丢给 GPT，
  GPT 自己按说明.txt 完成全部（设定图→记住→分镜图→打包交付），用户把交付 zip 丢回来，
  place 归位 + render 补图 = 闭环。run 依赖 python zipfile（UTF-8 文件名防中文乱码）。
  Use when asked to 出图、设定图、分镜图、出图闭环、assets、出图包。
allowed-tools:
  - Read
  - Write
  - Bash
  - Task
  - Glob
triggers:
  - novel-assets
  - 出图
  - 设定图
  - 分镜图
  - 出图闭环
  - 资产出图
  - 出图包
  - 打包图
metadata:
  license: Apache-2.0
  requires:
    bins:
      - node          # >= 18，只用标准库，无 npm 依赖
    optional:
      - python        # run 打包 zip 需要（zipfile，标准库；UTF-8 文件名标志）
  runtimes:
    - claude-code
---

## novel-assets

给 AI 短剧**出图的闭环阶段**。五段管线（outline → characters → art → script → storyboard）已经把提示词全写好了——`cast.json`/`art.json` 里的 `image.sheet`（设定图），`storyboard.json` 里的 `frame`（分镜图）。**novel-assets 不写一个字的新提示词**，它干的是把现成提示词**打包成"出图包 zip"（整个丢给 GPT，GPT 自己完成全部）**，图回来**归位**，report **补图**。

```
novel-outline → characters → art → script → storyboard → ★ novel-assets（本 skill）
                                                        ↑ 出图闭环在这
```

**核心原则：JSON 一点不动。** 现有五段的产出是唯一的提示词来源，novel-assets 只消费、不重写。

## 人机配合（本 skill 最特别的地方）

**图是 GPT 网页版生成的**——Claude 替代不了这个环节，因为 GPT Image 2 在用户的 Plus 账号里。**默认两阶段出图**（防资产错→分镜全废）：先出设定图→你审资产→确认后再出分镜图。每阶段用户操作两次：丢 zip 进去、丢 zip 回来。demo 想省事用 `--stage all` 一次到位（操作缩回 2 次）。

```
① run --stage assets 出「设定图包.zip」──→ ② 丢给 GPT → 出全部设定图 → 回传
③ 你审资产（不合适 → 只重出该张，不连累分镜）
④ 资产确认 → run --stage storyboard 出「分镜图包.zip」
   （分镜图包 + 确认的设定图一起丢给 GPT）→ 出全部分镜图 → 回传
⑤ place 归位图 ──→ ⑥ render 补 report → ✅ 闭环
```

| 环节 | 谁 | 干什么 |
|------|----|--------|
| ① run --stage assets | Claude | 产出 `<剧名>-设定图包.zip`（说明.txt + 01_设定图提示词.txt） |
| ② 丢给 GPT | 用户 | 把设定图包 zip 整个发给 GPT（不拆开、不复制文本） |
| ③ 审资产 | 用户 | 设定图回传后审资产，不合适只重出（GPT 会话直接改），不连累分镜 |
| ④ run --stage storyboard | Claude | 资产确认后出 `<剧名>-分镜图包.zip`；用户把分镜图包 + 确认的设定图一起丢给 GPT |
| ⑤ GPT 出分镜图 | GPT | 读说明.txt → 引用随附设定图 → 生成全部分镜图 → 打包交付 |
| ⑥ 丢回来 | 用户 | 把 GPT 交付的 zip 发给 Claude |
| ⑦ place | Claude | 按命名规则把图归位到 `images/` 和 `<段号>/` |
| ⑧ render | Claude | 重新生成 report，让图进报告 |

**给包分先后（执行纪律，硬规则）**：默认先 `--stage assets` 给设定图包 → 用户审完资产并确认 → 才 `--stage storyboard` 给分镜图包。**不一次给两个**（除非用户明确要 `--stage all` 或说"两个都给我"）。分镜图包技术上随时能生成，但给包的时机卡在资产确认之后——这是防"资产没审就出分镜→资产错全废"的硬纪律，不由执行者临场判断。

**验收标准**：place + render 之后，report 里每张图都显示出来 = 闭环成功。

## 脚本命令

```bash
# ① 产出「出图包.zip」——两阶段（默认，防资产错→分镜全废）：
#    先 --stage assets 出设定图包 → 你审资产 → 确认后 --stage storyboard 出分镜图包
#    demo 想一次到位用 --stage all（旧行为）
node {baseDir}/scripts/novel-assets.mjs run <剧名> \
  --cast <cast.json> --art <art.json> --storyboard <storyboard.json> \
  --style "暗黑写实电影感" --stage assets --out <输出目录>
# → <剧名>-设定图包.zip（说明.txt + 01_设定图提示词.txt）→ 丢 GPT 出设定图 → 回传审资产
# 资产确认后：--stage storyboard → <剧名>-分镜图包.zip（说明.txt + 02_分镜图提示词.txt；
#   说明.txt 提示「引用随附已确认设定图」——把设定图一起丢给 GPT）
# --ratio 可不传：默认取 storyboard.json 顶层 ratio（seed 时 --outline 带出的锁定比例），再兜底 9:16
# 依赖 python zipfile（UTF-8 文件名标志防中文乱码）

# 可选（前置询问选了飞书特化风格时）：
#   --style-ref <本地图>    样张图 → 打包进 zip 为 style-ref.png（画风锚）
#   --negative "avoid anime"  负面词 → 写进说明.txt（GPT 网页版无负面词栏）
# 说明：画风由 sheet 源头带（characters 写 sheet 时已含），style-ref 只在设定图阶段
#       作画风锚用一次；说明.txt 写死"参考画风不参考长相"防抄样张。

# ⑤ 图归位（GPT 交付的 zip 解压目录 → 项目目录）
node {baseDir}/scripts/novel-assets.mjs place <zip解压目录> --out <项目目录>

# ⑥ 补 report（图归位后调用；缺哪个 skill 脚本就跳过哪个）
node {baseDir}/scripts/novel-assets.mjs render \
  --cast <cast.json> --art <art.json> --storyboard <storyboard.json> \
  [--script <script.json>] [--outline <outline.json>] \
  --cast-script <novel-characters.mjs> --art-script <novel-art.mjs> --sb-script <novel-storyboard.mjs>
# → 自动落盘 cast-report.html / art-report.html / storyboard-report.html（捕获各 skill 的 render HTML 写文件）
#   （1.5.0 修复：原来只转发不落盘，report 不更新；现在自动写）
```

### run 命令产出什么

**`<剧名>-出图包.zip`**（整个发给 GPT）——zip 内三个文件：

**说明.txt**（给 GPT 的总指令，指挥它一步步完成）：
- **统一画风段**：画风由 sheet 源头带（配方已在各 sheet 提示词里，不重复）；若包内有 `style-ref.png` 样张，写明"参考光影/材质/上色质感，**角色长相严格按提示词、不要照搬样张**"；负面词转成"全局避免：…"
- 第 1 步：读 `01_设定图提示词.txt`，生成全部设定图，**记住每张形象**
- 第 2 步：读 `02_分镜图提示词.txt`，生成全部分镜图，**引用第 1 步生成的设定图**（不另造形象）
- 第 3 步：把全部图打包成 zip 交付
- 注意事项：中途停了说"继续"，别从头再来

**01_设定图提示词.txt**：
- 所有角色的 `image.sheet` + 场景 + 道具，逐张 `命名：<名>-sheet.png` + `提示词：`
- **全传，含第一集用不上的也传**——不筛选，简单统一
- 开头强调"记住这些设定图，后面分镜图要引用"

**02_分镜图提示词.txt**：
- 统一锁定比例（默认 9:16，取 storyboard.json 顶层 ratio——seed 时从 outline.json 带出的源头固化值）+ 引用上面生成的设定图 + 按 E01-01→E01-11 顺序
- **逐镜绑定**：`【E01-01 第01镜】命名 / 引用设定图：【场景】【角色】/ 画面：<frame>`
- A 方案每镜绑定前缀：GPT 照着引用对应设定图，不猜

## 命名规范（place 按这个归位）

| 类型 | 规则 | 归位到 |
|------|------|--------|
| 设定图 | `<名>-sheet.png`（如 `林风-sheet.png`） | `images/<名>-sheet.png` |
| 分镜图 | `<段号>_f<段内镜号>.png`（如 `E01-01_f1.png`，段内从 1 数、无前导零） | `<段号>/f<段内镜号>.png` |

## 打包规范（写进说明.txt，要求 GPT 遵守）

- 交付 zip 内文件名照提示词里给的命名，**不要改**
- 一个 zip 全装，不用它建目录结构（zip 内目录不可靠，扁平命名最稳）

## 边界（不做的事）

- **不写提示词**：设定图/分镜图提示词全在上游 JSON 里，novel-assets 一字不改
- **不生成图**：图由 GPT 网页版生成（用户丢 zip 给 GPT），Claude 只产出出图包
- **不接 API**：GPT 用 Plus 订阅额度，网页版手动，不走 API 计费
- **不改 JSON**：cast/art/storyboard 是消费端，novel-assets 是下游
- **依赖 python**：run 打包 zip 需要 python（zipfile，标准库）

## 关联

- 上游：`novel-characters`（cast.json 的 image.sheet）· `novel-art`（art.json 的 image.sheet）· `novel-storyboard`（storyboard.json 的 frame + binds + sceneImage）
- 出图契约（已被 novel-assets 取代为主通路，但保留作参考）：`novel-characters/references/sheet.md` · `novel-art/references/sheet.md` · `novel-storyboard/references/frame.md`
- 样例（出图包内容，可复现）：`examples/说明.txt` · `examples/01_设定图提示词.txt` · `examples/02_分镜图提示词.txt`
