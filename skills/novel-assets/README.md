**中文** · [English](README.en.md)

# novel-assets

五段管线（outline → characters → art → script → storyboard）之后的**第 6 阶段：出图闭环**。

前面五段已经把提示词全写好了——角色/场景/道具的 `image.sheet`（设定图）、每镜的 `frame`（分镜图）。novel-assets **一个字提示词都不写**，它干三件事：

1. **打包**：把现成提示词打成"出图包 zip"（整个发给 GPT）
2. **归位**：GPT 交付的图按命名规则放回 `images/` 和 `<段号>/`
3. **补 report**：图归位后重新生成报告，让图显示出来

## 为什么是"发 GPT"而不是直接生成

出图用的是 **GPT Image 2（用户 Plus 账号，网页版）**——比本地 Seedream 的排版/多视图一致性强，而且不走 API 计费。Claude 替代不了这个环节（图在用户的 GPT 账号里）。**用户只操作两次：丢 zip 进去，丢 zip 回来**——GPT 自己完成全部步骤：

```
Claude 产出出图包zip → 用户整个丢给 GPT → GPT 读说明.txt 自己完成
（设定图→记住→分镜图→打包交付）→ 用户丢回交付zip → Claude 归位 → Claude 补 report → ✅
```

## 三个命令

```bash
# ① 产出「出图包.zip」（整个发给 GPT 用；依赖 python zipfile）
node scripts/novel-assets.mjs run <剧名> \
  --cast <cast.json> --art <art.json> --storyboard <storyboard.json> \
  --ratio 9:16 --style "暗黑写实电影感" --out <输出目录>
# 可选：--style-ref <本地图>（样张图 → 入包 style-ref.png，画风锚；说明.txt 防抄长相）
#       --negative "avoid anime"（负面词 → 写进说明.txt；GPT 网页版无负面词栏）

# ⑤ 图归位（GPT 交付的 zip 解压目录 → 项目目录）
node scripts/novel-assets.mjs place <zip解压目录> --out <项目目录>

# ⑥ 补 report
node scripts/novel-assets.mjs render \
  --cast <cast.json> --art <art.json> --storyboard <storyboard.json> \
  --cast-script <novel-characters.mjs> --art-script <novel-art.mjs> --sb-script <novel-storyboard.mjs>
```

## 出图包 zip 里有什么

| 文件 | 内容 | 比例 |
|------|------|------|
| `说明.txt` | 给 GPT 的总指令：统一画风→先设定图→记住→再分镜图→打包交付 | — |
| `01_设定图提示词.txt` | 16 张设定图（角色 10 + 场景 3 + 道具 3），逐张 `image.sheet` + 命名 | 按 sheet 内部（16:9 资产图） |
| `02_分镜图提示词.txt` | 36 镜分镜图，逐镜"引用设定图"绑定 + `frame` + 命名 | **9:16**（跟视频一致） |
| `style-ref.png` | **可选**（传 `--style-ref` 才入包）：本剧画风的参考样张，只在设定图阶段作画风锚用一次 | — |

## 命名规则（place 按这个归位）

- 设定图：`林风-sheet.png` → `images/林风-sheet.png`
- 分镜图：`E01-01_f1.png` → `E01-01/f1.png`（段内从 1 数、无前导零）

## 边界

- **不写提示词**、**不生成图**（GPT 网页版）、**不接 API**、**不改 JSON**
- **依赖 python**：run 打包 zip 需要 python（zipfile，标准库；UTF-8 文件名标志防中文乱码）
- 出图契约的 codex 通路（`sheet.md`/`frame.md`）保留作参考，novel-assets 是主通路
