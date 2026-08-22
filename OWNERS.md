# 接管说明

- 自 **2026-08-22** 起，本仓库由 **YTDX（仰天大笑）完全接管**，以后自己维护更新。
- 上游作者 eternityspring 仍在活跃更新，但已决定**不再跟进**，所有改动自己负责。
- git 身份：`YTDX-158 <YTDX-158@users.noreply.github.com>`

## 更新机制（改完即生效）

1. 改 `skills/` 下任意 skill 内容（如 `novel-storyboard/SKILL.md`、脚本、references）
2. `git add . && git commit`
3. **无需再装**——运行时 `~/.claude/skills/novel-*-ytdx` 与 `shot-recipes-ytdx` 是 **junction**，指向本仓库 `skills/`，改仓库即时生效

## 改名记录（8-22）

6 个 skill 全部改名加 `-ytdx` 后缀，与 GitHub 原版（eternityspring）区分（照 seedance-20-ytdx 先例）：

| skill | 新名 |
|---|---|
| novel-outline | `novel-outline-ytdx` |
| novel-characters | `novel-characters-ytdx` |
| novel-art | `novel-art-ytdx` |
| novel-script | `novel-script-ytdx` |
| novel-storyboard | `novel-storyboard-ytdx` |
| shot-recipes | `shot-recipes-ytdx` |

SKILL.md 的 `name`/`version` 已改，junction 外部名同步改名（仓库 `skills/` 内目录名**不动**）。触发词不变（中文"分镜/出分镜"等照常触发）。

## 管线规则：五段默认跑完（8-22 定）

**五段默认跑完**：`outline → characters → art → script → storyboard` 全跑，前段产物作为后段输入——后段禁止凭空造前段。

为什么：链条是链式的——characters 吃 outline 的人物表、art 吃 outline 的场景清单、script 吃 outline 的分集梗概、storyboard 吃 script 的剧本 + characters/art 的设定图（@绑定/分镜图参考）。跳过前段，后段的资产就是占位，分镜没有真设定图可绑、分镜图没有参考可挂。

**例外必须明说**（跳过哪段、为什么、拿什么替代，不静默跳）：
1. 用户点名只跑某段 / 只出某样东西
2. 上游产物**已存在**（如已有 cast.json 就不重跑 characters）
3. 素材类型**天然缺某段**（如"设计文档+剧本"没有小说 → outline 可不跑；但 characters/art 仍要从人物小传/诡域设计跑，不能一起跳）

## 当前状态

- 接管机制就位（git 身份 + junction 软链已验证）
- novel-storyboard 已完成 H3→Seedance 一镜一视频合并改造（commit 66b06ce / df1c981 / c4ad2bf / e58868c）
