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

## 当前状态

- 接管机制就位（git 身份 + junction 软链已验证）
- novel-storyboard 已完成 H3→Seedance 一镜一视频合并改造（commit 66b06ce / df1c981 / c4ad2bf / e58868c）
