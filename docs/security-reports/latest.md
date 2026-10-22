# 安全扫描摘要 2026-10-22T09:50:35.726Z

- 总分：**80** / 100　评级：**B**
- high: 1　medium: 1　low: 2　info: 1
- pass: 38　fail: 1　warn: 3　unknown: 5（共 48 项）

## 未通过项

- [low] **错误文案不应泄露管理员账号特征** — 命中 28 处：archive/private-test.html:23; archive/private-test.html:26; archive/private-test.html:982; archive/private-test.html:1022; functions/api/account.js:274（修复：错误文案统一为“无权操作/未登录”，不暴露管理员角色名）
- [low] **前端 innerHTML 使用数量** — app/lib/ 与 HTML 中共 204 处 innerHTML 赋值（需人工确认均不拼接用户输入）（修复：用户内容一律用 textContent，或做转义白名单）
- [medium] **CSP script-src 不应包含 unsafe-inline** — 当前 script-src 含 unsafe-inline，内联脚本可被注入执行（修复：把内联脚本抽到外部 js 文件，改用 nonce/hash 模式收紧 script-src）
- [high] **私密图仓必须为 private** — 图仓 private=undefined（HTTP 0）——私密照片不得放在公开仓！（修复：立即把仓库切换为 private，并轮换可能泄露的文件）

## 未知/未覆盖项

- [high] AUTH_SESSION_SECRET 独立配置（非复用 service key） — Actions 侧无法读取运行时环境（记 unknown）；若未配置会退化为复用 service_role 签发会话
- [high] 必需的运行时环境变量齐备 — supabaseUrl=✓ serviceRoleKey=✗（仅报告布尔值）
- [low] 上传/账号接口配置了 Origin 白名单 — 未配置白名单，当前仅靠同源判断兜底
- [low] 登录 Cookie 标志（HttpOnly/Secure/SameSite）人工复核 — 出于安全纪律，本扫描不尝试真实登录、不观察 Set-Cookie；请人工确认 couple_t 为 HttpOnly+Secure+SameSite=Lax
- [medium] Storage 桶公开情况 — Actions 侧不持有 service_role key，跳过（Function 侧扫描自动补检）
- [high] users 表不得残留明文 password 列 — Actions 侧不持有 service_role key，跳过