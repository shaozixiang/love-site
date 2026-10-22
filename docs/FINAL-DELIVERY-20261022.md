# 情侣纪念小站（love-site）· 结项交付说明

> 版本戳：**20261022o**（v1 `/`、v2 `/index-v2` 已同步部署）
> 仓库：`shaozixiang/love-site`（public，push main 自动部署 Cloudflare Pages）
> 图仓：`shaozixiang/couple-images`（private）
> 线上：https://love-site-2am.pages.dev/ （v1）· https://love-site-2am.pages.dev/index-v2 （v2）
> 备份：git tag/分支 `pre-final-overhaul-20261022`（已推 origin），离线包 `backup/love-site-pre-final-overhaul-20261022.tar.gz`

---

## 一、这次收尾做了什么（总览）

1. **两版 UI 全部重设计**：统一的高档设计系统（暖纸底 + 玫瑰木莓单色体系 + 约 70 个线性 SVG 图标），去掉了 emoji 堆砌，改为精致 SVG；新增 Toast、二次确认弹窗、骨架占位、空状态、失败重试等组件。**全部原有功能保留**，逐一走查未回归。
2. **管理员后台重设计**：控制台质感，7 个标签页——监控 / 安全 / 用户 / 内容 / 回收站 / 日志 / 设置。
3. **新增管理员监控仪表盘（真实取数，无假数据）**：
   - 网站总览：版本、服务器时间、当前在线、安全评分环、11 项内容统计。
   - GitHub 仓库：图仓/主仓容量、提交数、最近提交、Actions 运行结论、图片张数。
   - Supabase：连通性、数据库大小、各表大小/行数、出站流量（未配置则明确提示，不编造）。
   - 访问审计：最近记录、活跃用户、热门操作、近 7 天柱状图（超管账号名已脱敏）。
   - 安全状况：评分/等级/高中低/通过数。
4. **全面安全扫描（49 项检查）**：
   - 手动：后台「安全」标签 → 立即扫描（实测约 40–60 秒出报告）。
   - 自动：GitHub Actions 每 2 天（北京时间约 11:00）跑一次，报告自动提交到 `docs/security-reports/`。
5. **全项目源码逐行重读并修复**：审查报告见 `docs/CODE_REVIEW.md`（P0×2、P1×7、P2×8、P3×4），修复状态见该文档「附录 C」。
6. **备份与回退**：动工时已打 tag/分支与离线包，可随时整体回退。

---

## 二、你需要手动做的事（约 5 分钟，只做一次）

这三步**必须在 Supabase SQL Editor 执行**（本地没有 service_role 凭据，我无法代跑；三个文件都幂等，可重复执行）。
入口：https://supabase.com/dashboard/project/txeynuvttibnilvttieu/sql/new

按顺序执行仓库里的三个文件（复制全文粘贴 → Run）：

1. **`sql/final-maintenance-20261022.sql`**
   - 删除 `users` 表遗留的明文 `password` 列（安全扫描唯一 high 项）；
   - 把未使用的 `couple-media` Storage 桶改为私有（medium 项）。
2. **`sql/monitoring_rpcs.sql`**
   - 开启监控仪表盘「数据库大小 / 各表大小 / 访问统计」取数；不执行时这些卡片会显示「—」并提示去执行。
3. **`sql/rename-cascade-supplement.sql`**
   - 改名后历史评论作者名、生气模式开启者同步更新。

三步跑完后，回后台「安全」页点一次「立即扫描」，评分预期升到约 **94/A**（仅剩一项 CSP 已知取舍，见下）。

### 可选增强（不做也能用，缺哪项仪表盘就提示哪项）

- **Supabase 出站流量**：Cloudflare Pages → 环境变量补 `SUPABASE_ACCESS_TOKEN`（Supabase 头像 → Account → Access Tokens 生成）和 `SUPABASE_PROJECT_REF=txeynuvttibnilvttieu`。步骤见 `docs/security-monitoring-setup.md`。
- **图仓深度扫描**：GitHub Actions 加 secret `IMAGE_REPO_TOKEN`（fine-grained，只给 couple-images 的 Contents: Read-only）。
- GitHub token 统一存 Cloudflare env，**不会**出现在前端。

---

## 三、安全修复要点（已上线）

- 堵死普通用户越权写全站配置/气泡表（原任意登录用户可改通知邮箱）。
- 点赞、评论改为**服务端读-改-写**：只能增删自己的点赞/评论，他人无法清空或篡改；**管理员也走同一原子化逻辑**（E2E 实测曾覆盖他人赞的问题已修）。
- 登录会话统一 HMAC 校验（过期 + 账号存活），删号后旧令牌立即失效；CORS 预检也做白名单，恶意域名 403。
- 上传改 Git Data API（图片 10MB / 视频 30MB，MIME 白名单、拒绝 SVG）；图片代理私有回源、防路径穿越、支持视频拖动。
- 密码最小 8 位、PBKDF2-SHA256 12 万次哈希，旧 SHA-256 账号登录时**透明升级**，不影响使用。
- 头像 >500KB 拒绝；回收站单侧失败写补偿日志；Service Worker 不再缓存 /api；敏感目录（sql/docs/scripts）线上 404。
- 所有删除/高危操作两版都有二次确认弹窗，成功/失败有 Toast。

---

## 四、已知取舍（结项说明，非缺陷）

- **CSP 含 unsafe-inline**：全站用 inline onclick，彻底收紧需要整体改成事件绑定（工作量大）；已有同源策略、全量 HTML 转义、防 CSRF/越权兜底，安全评分中此项为 medium，已接受。
- **会话 Cookie 非 HttpOnly**：前端图片代理需读取该 cookie，属架构权衡；令牌 HMAC 签名、30 天有效。
- **图片/视频首次冷加载较慢**：私有图仓经 raw.githubusercontent 回源，跨太平洋带宽有限。已做——边缘分级缓存（图片 1 小时、视频 1 天，删除时主动失效）、命中缓存后视频 Range 拖动秒响应、相册骨架占位。**重复访问秒开；首次浏览大图/视频需要等几秒**。彻底解决要把媒体迁到 Cloudflare R2/CDN（可选，后续需要我可再加）。
- 图片代理删除/改名后，跨机房边缘最坏按 TTL 过期（图片 1 小时），本机房已主动 purge；两人小站、同一最近机房，实际影响极小。

---

## 五、测试数据清理与一处需你操作

- 我走查产生的临时留言/评论/记录**已全部物理删除**（逐条核对 id 后删除，回收站为空）。
- **一处需要你本人操作**：留言「我的漂亮笔全都是老婆给的」（id `0f29b5fb…`）原本有 **szxtest 的 1 个赞**，我在修复"管理员陈旧覆盖"漏洞前，用管理员账号测试时把该赞覆盖丢失了。服务端安全规则禁止代他人点赞，我无法替 szxtest 恢复。**请用 szxtest 账号登录后在该条留言重新点一次赞即可**（这是唯一一处无法用代码恢复的真实数据，特此如实说明）。

---

## 六、回退方式（如需要）

- 整体回退到改动前：
  ```bash
  git fetch origin
  git checkout pre-final-overhaul-20261022   # 或对该分支/tag 直接部署
  ```
- 或用离线包 `backup/love-site-pre-final-overhaul-20261022.tar.gz`。
- 数据/数据库结构本次改动均为幂等新增（RPC/触发器），未做破坏性 schema 变更；唯一的 DROP 是三步手动 SQL 里的明文 password 列（无业务依赖）。

---

## 七、账号与入口（仅供你本人知悉）

- 管理员账号与普通账号按原体系使用；UI、错误文案、JS 中均不暴露超管账号名（审计/在线列表已脱敏为「超管」）。
- 测试账号：doubaotest（管理员，走查用）、test（普通用户）。普通账号实测无「管理后台」入口，且服务端对监控/安全/日志接口一律 403。

---

## 八、主要文件

- 用户端：`index.html` + `lib/app.js`（v1）；`index-v2.html` + `lib/app-v2.js`（v2）
- 设计系统：`assets/love-ui.css`、`assets/icons.svg`、`docs/DESIGN_SPEC.md`
- 监控/安全：`functions/api/monitor.js`、`functions/api/security-scan.js`、`scripts/security-checks.mjs`、`scripts/run-security-scan.mjs`、`.github/workflows/security-scan.yml`
- 共享会话：`functions/_lib/session.js`
- 图片代理：`functions/api/img/[[path]].js`
- 待执行 SQL：`sql/final-maintenance-20261022.sql`、`sql/monitoring_rpcs.sql`、`sql/rename-cascade-supplement.sql`
- 报告/文档：`docs/CODE_REVIEW.md`（含修复状态附录 C）、`docs/security-monitoring-setup.md`、`docs/security-reports/`
