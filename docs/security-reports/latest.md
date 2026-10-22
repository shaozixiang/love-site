# 安全扫描摘要 2026-10-22T09:24:23.462Z

- 总分：**86** / 100　评级：**B**
- high: 0　medium: 4　low: 2　info: 2
- pass: 29　fail: 0　warn: 6　unknown: 12（共 49 项）

## 未通过项

- [low] **错误文案不应泄露管理员账号特征** — 命中 28 处：archive/private-test.html:23; archive/private-test.html:26; archive/private-test.html:982; archive/private-test.html:1022; functions/api/account.js:274（修复：错误文案统一为“无权操作/未登录”，不暴露管理员角色名）
- [low] **前端 innerHTML 使用数量** — app/lib/ 与 HTML 中共 204 处 innerHTML 赋值（需人工确认均不拼接用户输入）（修复：用户内容一律用 textContent，或做转义白名单）
- [medium] **CSP script-src 不应包含 unsafe-inline** — 当前 script-src 含 unsafe-inline，内联脚本可被注入执行（修复：把内联脚本抽到外部 js 文件，改用 nonce/hash 模式收紧 script-src）
- [medium] **OPTIONS 预检不得回显恶意 Origin** — 预检 204 回显 https://evil.example.com（后续真实请求虽不带 ACAO 仍被读响应，但应一并收紧）（修复：预检阶段同样做 Origin 白名单校验）
- [medium] **anon 不得列出 Storage 桶（空列表视为 RLS 生效）** — 状态 200（期望 401/403 或空列表）（修复：撤销 anon 对 storage buckets 的列出权限）
- [medium] **sql/ 迁移脚本不得被公开发布** — GET /sql/trash-columns.sql 直接返回了 SQL 源文件（暴露表结构/迁移逻辑，无密钥但属信息泄露）（修复：在 Cloudflare Pages 构建配置把 sql/、docs/ 移出发布目录，或用 Functions 拦截）

## 未知/未覆盖项

- [high] anon key 对全部业务表的只读探测 — 未配置 SUPABASE_ANON_KEY，跳过 RLS 探测
- [high] 无会话访问 /api/monitor 必须被拒绝 — 状态 200（期望 401/403），接口尚未部署（命中 SPA 回退页/405）
- [high] 无会话访问 /api/security-scan 必须被拒绝 — 状态 200（期望 401/403），接口尚未部署（命中 SPA 回退页/405）
- [high] 无会话访问 /api/security-scan 必须被拒绝 — 状态 405（期望 401/403），接口尚未部署（命中 SPA 回退页/405）
- [high] AUTH_SESSION_SECRET 独立配置（非复用 service key） — Actions 侧无法读取运行时环境（记 unknown）；若未配置会退化为复用 service_role 签发会话
- [high] 必需的运行时环境变量齐备 — supabaseUrl=✗ serviceRoleKey=✗（仅报告布尔值）
- [low] 上传/账号接口配置了 Origin 白名单 — 未配置白名单，当前仅靠同源判断兜底
- [low] 登录 Cookie 标志（HttpOnly/Secure/SameSite）人工复核 — 出于安全纪律，本扫描不尝试真实登录、不观察 Set-Cookie；请人工确认 couple_t 为 HttpOnly+Secure+SameSite=Lax
- [high] 私密图仓必须为 private — 未配置 GITHUB_TOKEN，无法读取仓库元信息
- [high] 主仓不得提交 .dev.vars/wrangler.toml 等密钥文件 — 未配置 GITHUB_TOKEN，无法抽查主仓文件树
- [medium] GitHub Actions 默认权限最小化 — 请人工确认 .github/workflows 已声明 permissions: contents: read（本扫描的静态检查项会补充）
- [medium] Storage 桶公开情况 — Actions 侧不持有 service_role key，跳过（Function 侧扫描自动补检）
- [high] users 表不得残留明文 password 列 — Actions 侧不持有 service_role key，跳过
- [medium] GoTrue 注册端点状态 — GET /auth/v1/signup 状态 200（本站账号体系在 /api/account，不使用 GoTrue；生产应保持拒绝开放注册）