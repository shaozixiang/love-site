# 安全扫描摘要 2026-10-29T09:22:55.453Z

- 总分：**95** / 100　评级：**A**
- high: 0　medium: 1　low: 2　info: 1
- pass: 38　fail: 0　warn: 3　unknown: 6（共 48 项）

## 未通过项

- [low] **错误文案不应泄露管理员账号特征** — 命中 32 处：archive/private-test.html:23; archive/private-test.html:26; archive/private-test.html:982; archive/private-test.html:1022; functions/api/account.js:277（修复：错误文案统一为“无权操作/未登录”，不暴露管理员角色名）
- [low] **前端 innerHTML 使用数量** — app/lib/ 与 HTML 中共 221 处 innerHTML 赋值（需人工确认均不拼接用户输入）（修复：用户内容一律用 textContent，或做转义白名单）
- [medium] **CSP script-src 不应包含 unsafe-inline** — 当前 script-src 含 unsafe-inline，内联脚本可被注入执行（修复：把内联脚本抽到外部 js 文件，改用 nonce/hash 模式收紧 script-src）

## 未知/未覆盖项

- [high] AUTH_SESSION_SECRET 独立配置（非复用 service key） — Actions 侧无法读取运行时环境（记 unknown）；若未配置会退化为复用 service_role 签发会话
- [high] 必需的运行时环境变量齐备 — supabaseUrl=✓ serviceRoleKey=✗（仅报告布尔值）
- [low] 上传/账号接口配置了 Origin 白名单 — 未配置白名单，当前仅靠同源判断兜底
- [low] 登录 Cookie 标志（HttpOnly/Secure/SameSite）人工复核 — 出于安全纪律，本扫描不尝试真实登录、不观察 Set-Cookie；请人工确认 couple_t 为 HttpOnly+Secure+SameSite=Lax
- [high] 私密图仓必须为 private — Token 无权访问 couple-images（HTTP 404）；内置 GITHUB_TOKEN 无法跨仓读取，需配置 IMAGE_REPO_TOKEN
- [medium] Storage 桶公开情况 — Actions 侧不持有 service_role key，跳过（Function 侧扫描自动补检）
- [high] users 表不得残留明文 password 列 — Actions 侧不持有 service_role key，跳过