# 监控仪表盘与安全扫描 · 配置说明

本文档说明情侣小站「管理员监控聚合 API」与「自动安全扫描」上线后需要补的配置。
所有配置均可按步骤独立补，缺哪项哪项在仪表盘显示“未配置”，不影响其他卡片。

---

## 一、Cloudflare Pages 需要补的环境变量

位置：Cloudflare Pages → 项目 `love-site-2am` → Settings → Environment variables（Production）。

| 变量 | 是否必填 | 说明 |
|---|---|---|
| `SUPABASE_URL` | 已有 | Supabase 项目地址 |
| `SUPABASE_SERVICE_ROLE_KEY` | 已有 | service_role（仅服务端持有） |
| `AUTH_SESSION_SECRET` | 已有 | 会话 HMAC 密钥；**务必独立配置**，不要复用 service_role key |
| `GITHUB_TOKEN` | 建议补 | 读私有图仓用；见下文 scope 要求 |
| `GITHUB_OWNER` | 可选，默认 `shaozixiang` | |
| `GITHUB_REPO` | 可选，默认 `couple-images` | 图片仓 |
| `GITHUB_BRANCH` | 可选，默认 `main` | |
| `GITHUB_MAIN_REPO` | 可选，默认 `love-site` | 监控主仓提交/Actions 用 |
| `UPLOAD_ALLOWED_ORIGINS` / `ACCOUNT_ALLOWED_ORIGINS` | 已有 | CORS 白名单（逗号分隔） |
| `SUPABASE_ACCESS_TOKEN` | **可选新增** | Supabase Management API token，开通后 `management.configured=true` |
| `SUPABASE_PROJECT_REF` | **可选新增** | 项目 ref（URL 前缀 `txeynuvttibnilvttieu`） |

### GITHUB_TOKEN 的 scope 要求
1. GitHub → 头像 → Settings → Developer settings → **Personal access tokens → Fine-grained token**
2. Resource owner 选自己；仅授权仓库 `couple-images`（以及 `love-site` 若要监控主仓）
3. Permissions → **Contents: Read-only**（足够图仓读取/回收站与监控统计）
4. 生成后粘到 Cloudflare Pages 的 `GITHUB_TOKEN`

### SUPABASE_ACCESS_TOKEN 获取方式
1. supabase.com → 左下角头像 → **Account → Access Tokens**
2. Generate new token，名字随意，权限选默认 Organization read 即可
3. 粘到 Cloudflare Pages 的 `SUPABASE_ACCESS_TOKEN`；同时把项目 ref 填到 `SUPABASE_PROJECT_REF`
4. 说明：当前实现下 egress（出站流量）保持 `null` 并提示去 Dashboard → Project Usage 查看，**不会编造数字**；后续接用量 API 时再填充

---

## 二、执行一次 SQL（开启表大小/审计聚合 RPC）

位置：Supabase Dashboard → SQL Editor → New query → 粘贴 `sql/monitoring_rpcs.sql` → Run。

执行后：
- `get_table_sizes()`：仪表盘「数据库大小 / 各表大小」才有数据；未执行时这些字段为空，面板会在 `supabase.management.setupSteps` 里提示执行该 SQL
- `get_access_stats()`：访问审计卡片优先走 RPC；未执行时自动降级为 Function 内聚合最近 500 条 `admin_logs`
- 两个函数均 `SECURITY DEFINER`，已 `REVOKE` public/anon/authenticated，只 `GRANT` 给 `service_role`

---

## 三、GitHub Actions secrets

位置：仓库 `love-site` → Settings → Secrets and variables → Actions。

| Secret | 是否必填 | 说明 |
|---|---|---|
| `IMAGE_REPO_TOKEN` | 可选 | 若定时扫描需要验证图仓是否为 private，填入只读 PAT；不给则该项记 unknown |
| `SUPABASE_SERVICE_ROLE_KEY` | 可选 | 注入后 Actions 扫描会补检 Storage 桶与 `users.password` 列残留；不给则这两项记 unknown |

> 定时扫描只在仓库内使用内置 `GITHUB_TOKEN`（自动注入），无需额外配置。
> 发布的报告文件路径：`docs/security-reports/scan-YYYYMMDD-HHMM.json` 与 `docs/security-reports/latest.md`，由 workflow 自动 commit 回主分支。

---

## 四、定时频率与手动触发

- **定时**：cron `0 3 */2 * *`（UTC 03:00 = 北京时间约 11:00，每两天一次）
- **手动触发**：仓库 Actions → 「定时安全扫描（每两天）」→ Run workflow
- **Function 手动跑**：管理员登录后 `POST /api/security-scan`，body `{"action":"run"}`，同步返回完整报告并落库
- **失败码**：扫描发现 high 级别问题时脚本退出码为 1，workflow 标记失败；报告照常生成

---

## 五、仪表盘各卡片数据来源与“未配置”表现

| 卡片 | 数据来源 | 未配置/失败时 |
|---|---|---|
| 站点版本 | 现场 fetch 首页 HTML，解析 `<meta name=version>` 或 `<!-- v... -->` | `version=null` |
| 服务器时间 | Function 当前时间 | 不依赖外部 |
| 在线用户 | `users` 表 `is_online`/`last_active`（口径见 `site.usersOnlineNote`） | 空数组 |
| 各表行数 | service_role `HEAD /rest/v1/{表}` + `Prefer: count=exact` | 该表计 0 |
| 图片总数 | GitHub trees API 递归统计图仓内图片/视频（不含 trash/） | `counts.images=null` |
| GitHub 仓库 | `GITHUB_TOKEN` 调 repos/commits/actions runs | `configured=false` + `setupSteps` 中文步骤 |
| Supabase 健康 | `/auth/v1/health` + REST 探活 | `health.status='error'` |
| 表大小/DB 容量 | RPC `get_table_sizes()`（见第二节） | `tableSizes=[]` 并提示执行 SQL |
| 出站流量 | Management API（可选 env） | `egress=null` |
| 访问审计 | RPC `get_access_stats()` 或最近 500 条 admin_logs（details 自动脱敏） | 空数组 |
| 安全总览 | `site_config.last_security_report` | `security.status='never'` |

---

## 六、当前基线扫描发现（首次线上只读探测记录）

1. `/sql/trash-columns.sql` 等 `sql/` 迁移脚本被 Pages 当作静态资源公开发布（无密钥，但暴露表结构，建议发布目录排除 `sql/`、`docs/`）
2. `/api/db` 的 OPTIONS 预检会回显任意外域 Origin（实际 GET 不回显，风险有限，建议后续收紧）
3. 其余基线项：安全头齐全、anon 对业务表返回空数组、各写接口未登录 401、img 代理路径穿越 400

---

## 七、收尾阶段需要手动在 Supabase 执行的 SQL（DDL 无法通过 PostgREST 执行）

> 以下 SQL 均为幂等脚本（可重复执行）。PostgREST 只做 DML，DDL 必须到 SQL Editor 手动跑。

1. **监控 RPC（如未执行过）**：`sql/monitoring_rpcs.sql`（见第二节）。
2. **改名级联补丁（P1-06，2026-10-22 新增）**：`sql/rename-cascade-supplement.sql`。
   - 整段粘贴到 SQL Editor → Run；它以 `CREATE OR REPLACE` 重写 `change_username(text,text)`，
     在原逻辑基础上补齐：comments jsonb 内 `authorName` 与各表 `by` 列（如 `angry_mode.by`）随改名更新。
   - 执行后无需重启任何服务；下一次改名即生效。display 名直接存新用户名（emoji 前缀丢失，属已知 cosmetic 限制）。

## 八、本轮后端安全修复后的部署后实测清单（只读 GET 已覆盖，写路径需人工验证）

1. 普通账号（test/0000）`POST /api/db/rest/v1/site_config` → 应 403；`POST bubble_photos` → 应 403。
2. 普通账号对他人动态 `PATCH {likes:[]}` → 应 403；正常点赞/取消点赞 → 成功且不丢赞。
3. 删除一条评论（本人/管理员）→ 成功；删他人评论 → 403。
4. 删除账号后，其旧 token 访问 `/api/db`、`/api/img`、`/api/trash` → 均 401（幽灵令牌统一校验）。
5. 上传 2MB 图片与 2MB 视频 → 成功；`/api/img/<path>` 能打开、视频可拖动（Range）。
6. 把图片移入回收站后，原路径在 ≤5 分钟内返回 404。
7. 超大 base64 头像（>500KB）→ 400；新注册密码 <8 位 → 400；老短密码账号（如 doubaotest）登录不受影响，且首次登录后自动升级为 PBKDF2。

