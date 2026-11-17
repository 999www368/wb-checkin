# WorkBuddy 每日自动签到（云端版）

不依赖电脑开机。签到跑在 GitHub Actions 上，手机打开网页就能看结果、也能手动补签。

**网页地址**：https://999www368.github.io/wb-checkin/

---

## 它是怎么跑的

```
每天 10:30（北京时间）
   ↓ GitHub Actions 定时触发
   ↓ checkin.mjs 读 state.enc 里的账号 token
   ↓ 查活动状态 → 没签就领
   ↓ 写回 state.enc（加密）和 docs/status.json（公开摘要）
   ↓ 自动 commit + push
   ↓ GitHub Pages 更新 → 手机打开网页就能看到
```

- 定时表达式 `30 2 * * *` 是 **UTC**，等于北京 10:30。
- 免费版定时任务可能被排队延迟 **5–40 分钟**，属正常。补签按钮可以立刻补。

---

## 手机页面能干什么

| 功能 | 要不要授权 |
|---|---|
| 打开就看今天签没签、连续几天、拿了多少分 | 不用 |
| 点「立即签到」让云端马上跑一次 | 要一次 GitHub 授权码 |

授权码只存在你手机浏览器的 localStorage 里，不上传任何地方。

**怎么生成授权码**（一分钟）：

1. 电脑或手机浏览器打开 https://github.com/settings/tokens
2. `Generate new token` → `Generate new token (classic)`
3. Note 随便写（如 `wb-checkin`），Expiration 选 `No expiration`
4. 勾选 **`workflow`** 这一项（其它都不用勾）
5. 生成后复制 `ghp_...`，粘到网页里点保存

> 这个 token 只用于「触发 workflow」，权限很小。不想用了点网页底部「清除本机授权码」。

---

## 账号 token 存在哪、安全吗

存在仓库根目录的 **`state.enc`**，是 AES-256-GCM 加密过的二进制：

```
WBC1(4) | salt(16) | iv(12) | authTag(16) | ciphertext
key = scrypt(STATE_KEY, salt, 32)
```

- `STATE_KEY` 和首次导入用的 `WB_ACCOUNTS` 都存在仓库的 **Actions Secrets** 里，不落明文。
- 仓库虽然是 public，但没有 `STATE_KEY` 谁也解不开 `state.enc`。
- `docs/status.json` 是唯一公开的数据，里面只有昵称（形如 `***qq`）、状态、连续天数，**没有 token、没有账号 id**。

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `checkin.mjs` | 签到主脚本，零依赖，只用 Node 内置模块 |
| `.github/workflows/checkin.yml` | 定时任务定义（cron + 手动触发 + 提交结果） |
| `state.enc` | 加密保存的账号与 token（自动维护，别手改） |
| `docs/index.html` | 手机页面 |
| `docs/status.json` | 页面读的数据（自动生成） |
| `.gitignore` | 挡掉本地明文账号文件 |

---

## 用到的三个接口

| 用途 | 接口 |
|---|---|
| 刷新 token | `POST https://copilot.tencent.com/v2/plugin/auth/token/refresh`（`X-Refresh-Token` 头） |
| 查活动状态 | `POST https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status` |
| 领取签到 | `POST https://www.codebuddy.cn/v2/billing/meter/daily-checkin` |

鉴权头：`Authorization: Bearer <accessToken>` + `X-User-Id: <uid>` + `X-Domain: www.workbuddy.cn`。

---

## 常见问题

**签到显示「今天已签到」但积分没涨？**
说明今天已经领过了（可能是电脑上的计划任务先跑的那次）。积分每天只能领一次，这是正常的。

**显示「当前没有签到活动」？**
国际区 `www.workbuddy.ai` 没有签到活动，脚本只处理国内区 `www.workbuddy.cn`。国内区如果活动结束（当前是 2026-12-31），也会显示这个。

**token 过期了怎么办？**
脚本每次运行前会检查剩余有效期，不足 10 分钟自动刷新，并把新 token 写回 `state.enc`。只要 refreshToken 没过期（约 60 天滚动续期），就一直能自己续上。

**长时间不跑会怎样？**
GitHub 对 60 天无提交的仓库会自动停用定时任务。本仓库每天都会提交 `state.enc`，所以不会触发这个限制。

**改了 `STATE_KEY` 会怎样？**
等于重置：`state.enc` 解不开，会走首次导入流程重新读 `WB_ACCOUNTS`。

---

## 手动跑一次

GitHub 网页：仓库 → Actions → `WorkBuddy 每日签到` → `Run workflow`。

命令行：

```bash
curl -X POST \
  -H "Authorization: Bearer <你的 GitHub token>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/999www368/wb-checkin/actions/workflows/checkin.yml/dispatches \
  -d '{"ref":"main"}'
```

---

## 和本地版的关系

本机还有一套 `D:\workspace\wb-checkin\`（Windows 计划任务 `WorkBuddyDailyCheckin`，每天 10:30）。两套可以共存：

- 谁先跑谁领，后跑的那次会看到「今天已签到」。
- 两边各自维护自己的 token 副本，refreshToken 轮转不会互相踢掉（已实测：旧 refreshToken 在轮转后仍能刷新）。

嫌重复的话，可以停掉本地那套，只留云端。
