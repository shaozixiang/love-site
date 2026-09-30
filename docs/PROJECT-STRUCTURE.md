# 项目结构说明 · 我们的专属小站（love-site）

> 本文档说明 GitHub 仓库 `shaozixiang/love-site` 里每个文件夹/文件的用途。
> 更新时间：2026-09-30

---

## 一、项目是什么

一个只属于两个人的情侣小站：

- **网站**：`love-site-2am.pages.dev`（Cloudflare Pages 托管）
- **代码仓库**：`github.com/shaozixiang/love-site`（本仓库，代码 + 页面）
- **图片/视频仓库**：`github.com/shaozixiang/couple-images`（**独立仓库**，存放上传的照片/视频，经 jsDelivr CDN 加速访问）
- **数据库**：Supabase（匿名公钥直连，存储留言、相册、待办、行程、生气模式等所有业务数据）

部署方式：**GitHub 上传代码 → Cloudflare Pages 自动检测到仓库更新 → 自动发布上线**，所以平时更新网站只需要把文件推到 GitHub 的 `main` 分支。

---

## 二、仓库总览（文件树）

```
love-site/
├── index.html                  ← 原版网站（线上根路径 /）
├── index-v2.html               ← 优化版网站（线上 /index-v2）
├── index.txt                   ← 早期旧版本存档（已不再使用）
├── api/
│   └── upload-to-github.js     ← 旧版图片上传接口（已由 functions 版取代，存档）
├── functions/
│   └── api/
│       ├── account.js          ← 登录 / 用户管理 API（服务端）
│       └── upload-to-github.js ← 图片/视频上传 API（正式版，服务端）
├── app/                        ← PWA 应用（线上 /app/，可"添加到主屏幕"）
│   ├── index.html              ←   PWA 页面骨架
│   ├── style.css               ←   PWA 样式
│   ├── app.js                  ←   PWA 逻辑
│   ├── manifest.json           ←   应用清单（名称 / 图标 / 独立窗口）
│   └── sw.js                   ←   Service Worker（离线缓存策略）
├── docs/
│   ├── deployment-guide.md                 ← 小白部署指南
│   ├── change-report.md                    ← GitHub 上传与流量优化修改报告
│   ├── account-permission-audit-report.md  ← 账号权限跨设备同步检查报告
│   ├── supabase-permissions.sql            ← Supabase 数据库授权 SQL
│   └── PROJECT-STRUCTURE.md                ← 本文档
└── tests/
    └── verify-output.ps1       ← 上线前自检脚本（检查必需文件是否齐全）
```

---

## 三、每个文件是干什么的

### 1. `index.html` —— 原版网站（最重要，别动）

- 线上地址：`https://love-site-2am.pages.dev/`
- 单文件网站（约 3200 行），首页、登录、全部功能都在这一个文件里
- 包含：解锁门（点气泡）、登录、留言板、时光相册、回忆、感动、待办、行程、纪念日、生气模式、旅行地图
- **约定：这个文件保持原始版本不动**，所有新功能开发都在 `index-v2.html` 副本上进行
- 校验值（md5）：`b1d8b918f1bf71b69b72e9b0ff779ba4`（改过它说明出了问题）

### 2. `index-v2.html` —— 优化版网站（当前主力版本）

- 线上地址：`https://love-site-2am.pages.dev/index-v2`
- 在保留全部功能的前提下做的全新版本：
  - 移动端优先的浪漫新界面（粉渐变、圆角卡片、横滑胶囊导航、朋友圈式九宫格）
  - **图片默认直接显示**（不用再点"查看图片"）
  - **离线缓存 + 增量同步**：第一次登录把数据下载到手机本地，以后打开秒开、只拉新增数据，省流量不卡
  - 修复了原版的一批逻辑问题（板块假空白、刷新跳顶、生气模式云端不生效、道歉记录丢失、地图/日志报错等）
- 标题、解锁门、登录页、页脚都显示"专属优化版"字样

### 3. `index.txt` —— 早期旧版本存档

- 第一次拖拽上传时的旧版网站文件（与现在的 `index.html` 不同）
- **仅存档，不再使用**，留着以防哪天想对比旧代码

### 4. `api/upload-to-github.js` —— 旧版上传接口（存档）

- 最早写的"把图片上传到 GitHub 仓库"的接口（CommonJS 写法）
- 已被 `functions/api/upload-to-github.js` 取代，**不再被线上使用**，保留存档

### 5. `functions/api/` —— 服务端接口（Cloudflare Pages Functions）

这是**运行在 Cloudflare 边缘的服务端代码**，浏览器直接访问不了源码，只有部署后通过 `/api/xxx` 调用。

- **`upload-to-github.js`**（正式版上传接口）
  - 地址：`/api/upload-to-github`
  - 作用：接收图片/视频 → 压缩后通过 GitHub API 写入 `couple-images` 仓库 → 返回 jsDelivr CDN 链接
  - 需要的环境变量：GitHub Token、目标仓库名（默认 `shaozixiang/couple-images`）、允许的域名白名单

- **`account.js`**（登录与用户管理接口）
  - 地址：`/api/account`
  - 作用：账号体系（**不用 Supabase 的 auth，用自己写的这套**）
  - 支持的指令（POST body 里带 `action`）：`login`、`logout`、`me`、`listUsers`、`createUser`、`deleteUser`、`toggleUserRole`、`setUserPermission`、`setUserPassword`、`changePassword`、`updateAvatar`、`updateActivity`、`onlineStatus`
  - 登录态：Session 有效期 30 天，存在浏览器 localStorage，**除非手动退出，否则不用重新登录**
  - 需要数据库表：`users`（存账号、密码哈希、头像、权限、角色、在线状态）

### 6. `app/` —— PWA 应用（线上 /app/）

- 线上地址：`https://love-site-2am.pages.dev/app/`
- 用手机浏览器打开后，可以"添加到主屏幕"，用起来像 App（全屏、独立窗口）
- 四个文件分工：
  - `manifest.json`：告诉手机"这个网页是个应用"（名字叫"我们的小站"，粉色图标，竖屏独立窗口）
  - `sw.js`：离线缓存管家。策略：页面代码"每次检查新版、失败用缓存"；图片视频"优先用缓存、离线也能看"；登录/上传"不过缓存"
  - `index.html` / `style.css` / `app.js`：PWA 的页面结构、样式、逻辑

### 7. `docs/` —— 文档

- `deployment-guide.md`：**小白部署指南**——怎么把网站部署到 Cloudflare Pages、连 GitHub、配环境变量、建 Supabase 表
- `change-report.md`：**修改报告**——GitHub 上传与流量优化那次改了什么
- `account-permission-audit-report.md`：**检查报告**——账号、权限、跨设备同步的问题与修复
- `supabase-permissions.sql`：**数据库授权 SQL**——在 Supabase SQL Editor 里跑，给数据库表开权限（匿名读、公开写等）
- `PROJECT-STRUCTURE.md`：本文档

### 8. `tests/verify-output.ps1` —— 上线前自检脚本

- Windows PowerShell 脚本
- 作用：检查上面那些必需文件是否都还在仓库里（防止误删导致网站白屏），跑一遍能列出缺什么

---

## 四、数据存哪里（重要）

| 数据类型 | 存放位置 | 说明 |
| --- | --- | --- |
| 账号、权限、在线状态 | Supabase `users` 表 | 由 `/api/account` 读写 |
| 留言、点赞、评论 | Supabase `messages` 表 | 匿名公钥直连读写 |
| 相册动态（含图片地址） | Supabase `feeds` 表 | 图片本体在 couple-images 仓库 |
| 回忆、感动 | Supabase `memories` / `loves` | |
| 待办、行程、纪念日 | Supabase `memos` / `schedules` / `countdowns` | |
| 生气模式、道歉 | Supabase `angry_mode` / `apologies` | |
| 旅行地图标记 | Supabase `travel_markers` | |
| 气泡相册 | Supabase `bubble_config` / `bubble_photos` | |
| 操作日志 | 本机 localStorage（重要操作尝试写 Supabase `admin_logs`，默认表权限不开则不写） | 换设备只保留本机日志 |
| **图片/视频本体** | **GitHub `couple-images` 仓库** | 上传后通过 jsDelivr CDN 链接访问 |

> 注意：`index.html` 和 `index-v2.html` 里都写着 Supabase 的**匿名公钥**，这是故意的——前端直连数据库必须用它。真正的安全靠 Supabase 的 RLS 行级权限 + 表权限设置（见 `docs/supabase-permissions.sql`），不要把它当成秘密。

---

## 五、日常更新网站的步骤（以 index-v2 为例）

1. 本地改好 `index-v2.html`
2. `git add index-v2.html` → `git commit` → `git push origin main`
3. Cloudflare Pages 自动部署（约 20~40 秒）
4. 用浏览器打开 `https://love-site-2am.pages.dev/index-v2` 验证

**三个线上入口**：

| 入口 | 地址 | 用途 |
| --- | --- | --- |
| 原版 | `https://love-site-2am.pages.dev/` | 一直保留的原始站 |
| 优化版 | `https://love-site-2am.pages.dev/index-v2` | **推荐使用**，快、省流量、好看 |
| PWA | `https://love-site-2am.pages.dev/app/` | 可添加到主屏幕当 App 用 |
