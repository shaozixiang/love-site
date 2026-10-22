# Love UI（LUI）设计规范 v1.0 — 两版页面与管理员后台唯一视觉基准

> 本文件是本次重设计的硬性约束。`index.html`、`index-v2.html`、`lib/app.js`、`lib/app-v2.js`
> 的所有界面渲染必须基于 `assets/love-ui.css` 与 `assets/icons.svg`，不得再自创一套配色/组件/图标。
> 页面内允许保留少量页面专属 CSS，但只能使用本文件定义的 token（`var(--...)`），禁止硬编码颜色。

## 1. 设计目标（"高档"的来源）
- **克制**：暖纸底色 + 玫瑰木莓单一强调色；全页彩色面积不超过 15%，主色只出现在关键操作、激活态、品牌瞬间。
- **质感**：大圆角（16–26px）、发丝描边（`--line`）、分层柔光阴影、毛玻璃浮层；禁止糖果色、高饱和渐变、重投影。
- **系统感**：字体走系统字体栈；大标题紧凑字距；数字用 `tabular-nums`；动效 160–340ms，按下有缩放反馈。
- **图标**：全部使用 `assets/icons.svg` 的 1.7px 线性图标（24 网格）。**UI 外壳严禁出现 emoji**（按钮、导航、标题、占位符、空状态、弹窗、toast、后台标签一律不允许）；用户自己发布的内容里的 emoji 原样保留。
- **双主题**：浅/深色自动跟随系统，token 已内置；任何新增颜色必须同时给深色值。
- **移动端铁律**：无横向滑动（除明确的 chip/标签条，且必须隐藏滚动条）；内容不被底部坞/弹窗/视频/图片遮挡；所有可点元素 ≥34px 高；安全区用 `env(safe-area-inset-*)`。

## 2. 引用方式（两个 HTML 都要加）
```html
<link rel="stylesheet" href="assets/love-ui.css">
```
图标用法（`href` 必须是相对路径 `assets/icons.svg#i-xxx`）：
```html
<svg class="lui-icon"><use href="assets/icons.svg#i-heart"/></svg>
```
图标尺寸类：`s14 s16 s18 s20 s24 s28 s32`；颜色继承 `currentColor`（给父元素设 color 即可）。

## 3. 图标映射（强制）
| 位置 | 图标 | 位置 | 图标 |
|---|---|---|---|
| 留言 tab | `i-message` | 相册 tab | `i-photo` |
| 回忆 tab | `i-sparkles` | 感动 tab | `i-heart` |
| 待办 tab | `i-check-square` | 行程 tab | `i-calendar` |
| 生气 tab | `i-heart-crack` | 地图 tab | `i-map-pin` |
| 后台·监控 | `i-gauge` | 后台·安全 | `i-shield-check` |
| 后台·用户 | `i-users` | 后台·内容 | `i-grid` |
| 后台·回收站 | `i-trash` | 后台·日志 | `i-clipboard` |
| 后台·设置 | `i-settings` | 新增 | `i-plus` |
| 发送 | `i-send` | 编辑 | `i-pencil` |
| 删除 | `i-trash` | 恢复 | `i-trash-restore` |
| 关闭 | `i-x` | 确认 | `i-check` |
| 点赞 | `i-thumbs-up` / 已赞 `i-heart-fill` | 评论 | `i-comment` |
| 图片 | `i-photo` | 视频 | `i-film` | 拍照 | `i-camera` |
| 提醒 | `i-bell` | 邮箱 | `i-mail` | 锁定 | `i-lock` |
| 退出 | `i-log-out` | 刷新 | `i-refresh` | 搜索 | `i-search` |
| 筛选 | `i-filter` | 警告 | `i-alert` | 信息 | `i-info` |
| 成功 | `i-check-circle` | 失败 | `i-x-circle` |
| GitHub | `i-github` | 数据库 | `i-database` | 服务器 | `i-server` |
| 存储 | `i-hard-drive` | 云 | `i-cloud` | 流量/活动 | `i-activity` |
| 外链 | `i-external` | 下载 | `i-download` | 复制 | `i-copy` |
| 地球/访问 | `i-globe` | 时钟 | `i-clock` | 历史 | `i-history` |
| 生日 | `i-cake` | 礼物 | `i-gift` | 气泡 | `i-bubble` |

图标库现有清单以 `assets/icons.svg` 内的 symbol 为准；若确需新增，往该文件追加 symbol，保持 24 网格、1.7 描边、round 端点。

## 4. 页面骨架

### 4.1 用户端（两版一致）
```html
<body class="lui-glow">
  <div class="lui-shell">
    <!-- 解锁/登录页：居中卡片 .lui-card，主按钮 .lui-btn.primary.block -->
    <div class="lui-body">  <!-- 内容区，底部预留坞高度 -->
      <div class="lui-page-head">…</div>
      <section id="messageSection">… 全部用 .lui-card / .lui-list …</section>
    </div>
    <!-- 底部浮动坞：8 个 tab，结构见 4.2 -->
  </div>
</body>
```
### 4.2 底部坞
```html
<nav class="lui-tabbar">
  <button class="tab active" data-section="message"><svg class="lui-icon"><use href="assets/icons.svg#i-message"/></svg><span class="t-label">留言</span></button>
  … 8 个，顺序：留言/相册/回忆/感动/待办/行程/生气/地图
</nav>
```
### 4.3 管理员后台（控制台质感，全屏覆盖）
```html
<div id="adminPanel" class="lui-overlay show" style="align-items:stretch; padding:0; display:flex">
  <div class="lui-shell lui-shell-admin" style="padding-bottom: 30px;">
    <div class="lui-between" style="padding:16px 2px 0;">
      <div><h1 class="lui-h2">管理控制台</h1><div class="lui-mini">站点实时状态 · 安全与运维</div></div>
      <button class="lui-btn icon" onclick="closeAdminPanel()"><svg class="lui-icon"><use href="assets/icons.svg#i-x"/></svg></button>
    </div>
    <div class="lui-admin-tabs lui-hide-scrollbar" id="adminTabs">
      <button class="tab active">…监控…</button> …安全/用户/内容/回收站/日志/设置
    </div>
    <div id="adminContent"><!-- 各 tab 渲染到这里 --></div>
  </div>
</div>
```
后台在手机上必须可用：所有表格包 `.lui-table-wrap`（横向滚动仅限数据表区域，不允许整页横滑），统计卡片网格在手机自动 2 列。

## 5. 核心组件用法（类名即契约）
- 卡片：`.lui-card`；无边框填充：`.tint`/`.soft`；玫瑰渐变主视觉：`.hero`；卡头：`.lui-card-head` + `.lui-badge-icon`
- 按钮：`.lui-btn` + `.primary/.tonal/.ghost/.subtle/.danger/.danger-ghost/.text/.icon`；尺寸 `.sm/.lg/.xs/.block`；`.loading` 态自带转圈
- 表单：`.lui-field > label + .lui-input/.lui-textarea/.lui-select`；开关 `.lui-switch`；分段选择 `.lui-segmented`；筛选芯片 `.lui-chip`；标签 `.lui-tag(.rose/.green/.amber/.red/.blue/.gold)`；计数 `.lui-badge`
- 列表：iOS 分组 `.lui-list > .lui-list-row(.clickable)`（`.lui-row-icon` / `.lui-row-main` / `.lui-row-accessory`）
- 浮层：`.lui-overlay(.show/.center)` + `.lui-sheet`（底部抽屉，带 `.grabber`）或 `.lui-modal`（居中对话框）
- 反馈：`.lui-toast(.success/.error/.warn)`；`.lui-empty`（图标+标题+文案+`.e-action`）；`.lui-loading`/`.lui-spinner`；骨架 `.lui-skeleton(.line/.title/.avatar/.card)`；状态条 `.lui-notice(.success/.warn/.error)`；状态点 `.lui-status-dot.green/.amber/.red.pulse`
- 头像：`.lui-avatar.s24/.s32/.s40/.s48/.s64`（内放 img 或首字）
- 分割：`.lui-divider`；FAB：`.lui-fab`；搜索框：`.lui-search`
- 仪表盘：`.lui-stat-grid(.c3/.c4)` + `.lui-stat(.accent)`；`.lui-progress(.green/.amber/.red)`；`.lui-score-ring`；`.lui-data-table`；`.lui-check`；`.lui-timeline`；`.lui-bars`

## 6. 管理员"监控"Tab 布局（按顺序）
1. **顶部 hero 卡**：左侧「网站总览」标题 + 版本号 + 服务器时间 + 在线状态；右侧 `.lui-score-ring` 安全评分；点击「立即安全扫描」按钮（`.lui-btn.tonal.sm`，图标 i-scan）。
2. **网站统计** `.lui-stat-grid`：留言/相册/回忆/感动/待办/行程/倒计时/足迹/用户/气泡图 等数量（字段 `site.counts`）。
3. **GitHub 仓库** 一张 `.lui-card`：两个仓库各一行（`.lui-list-row`，i-github 图标），显示容量 `sizeKb`（自动换算 KB/MB/GB）、图片数、最近提交、Actions 状态；`configured=false` 或 `error` 时显示 `.lui-notice.warn`，内嵌 `<details><summary>配置步骤</summary><pre>setupSteps</pre></details>`。
4. **Supabase** 一张 `.lui-card`：健康状态点；`dbSizeMb`、各表 `.lui-progress` 容量条（`.lui-table-wrap` 或 `.lui-list`）、`egress`（为空则显示配置引导 `.lui-notice.warn`，字段 `management.setupSteps`）。
5. **访问审计**：`.lui-bars` 近 7 天趋势 + `.lui-list` 最近操作（`access.recent`，details 脱敏后展示）+ 按用户/动作聚合 `.lui-tag`；顶部提供与"日志"tab 一致的筛选能力（用户、时间）。
6. **安全状况**：评分环（无报告时显示"从未扫描"空状态 + 扫描按钮）；高/中/低计数 `.lui-stat`；最近扫描时间；「查看详情」跳到"安全"Tab。
- 卡片右上角统一放刷新按钮（`.lui-btn.icon.sm`，点击时图标加 `.rotate-spin`），整体支持「下拉刷新」或手动刷新按钮；自动刷新 60s 一次（后台打开期间），离开后台停止定时器。
- 所有数字必须来自接口，**严禁写死假数据**；`null` 显示 `—` 并给配置引导，不允许显示 0 充数。

## 7. 管理员"安全"Tab
- 顶部：评分环 + 等级（A–F）+ 扫描时间 + 「立即扫描」主按钮；扫描中显示进度态（按钮 loading + 文案"正在全面检查，约需 30–60 秒"）。
- 摘要统计：`.lui-stat-grid` 四格（通过 / 高 / 中 / 低）。
- 检查项：按分类分组（HTTP 安全头 / CORS / RLS 与数据面 / 服务端鉴权 / 会话与口令 / 静态代码 / GitHub / Supabase / 暴露面 / 图床代理），每条 `.lui-check`：状态图标（pass=check-circle、fail=x-circle、warn=alert、unknown=i-clock）、标题+严重级别 `.lui-tag`、详情、可展开修复建议（`.c-fix`）。
- 底部说明：定时扫描频率（每两天一次，北京时间约 11:00）+ 手动触发入口 + 历史报告在仓库 `docs/security-reports/`。

## 8. 接口契约（前端严格按此渲染）
- `GET /api/monitor`（管理员）：
  `{ generatedAt, site:{version,serverTime,usersOnline:[{username,lastSeenMinAgo}],counts:{feeds,messages,loves,memories,memos,schedules,countdowns,travelMarkers,users,bubblePhotos,images}},
   github:{configured,repos:[{name,private,sizeKb,imageCount,updatedAt,commitCount,recentCommits:[{sha,message,date}],actionsRuns:[{name,status,conclusion,createdAt}],error}],error,setupSteps},
   supabase:{configured,health:{status,db},dbSizeMb,tableSizes:[{table,totalSizeMb,rowsEstimate}],egress,management:{configured,setupSteps},error},
   access:{recent:[{action,user,details,createdAt}],byUser:[{user,count}],byAction:[{action,count}],day7:[{date,count}]},
   security:{status,score,grade,high,medium,low,passes,lastScanAt} }`
- `GET /api/security-scan`：最近一次报告；`POST /api/security-scan` body `{"action":"run"}`：
  `{ scannedAt, score, grade, summary:{passes,high,medium,low,info}, checks:[{id,category,title,severity,status,detail,fix}], config:{…布尔态…} }`
- 未登录/非管理员访问这些接口会 401/403：前端按 401 静默回到登录提示，不弹错误堆栈。

## 9. 交互与文案规范
- 所有删除/清空/彻底删除/改权限/重置密码：点击 → `.lui-modal` 二次确认（危险按钮 `.danger`，文案写明操作对象）→ 结果 `.lui-toast`；恢复/常规操作同样要有结果反馈。
- 文案统一为简体中文、克制、不撒娇、不暴露技术堆栈；**任何错误文案、注释、JS 字符串中不得出现管理员账号名**。
- 空状态必须用 `.lui-empty`（图标 + 一句话 + 主行动按钮），不允许只显示"暂无数据"四个字。
- 加载 >200ms 必须有骨架或 spinner；失败有重试按钮。
- 弹窗打开锁背景滚动（body overflow hidden），关闭恢复；Esc/点遮罩关闭（危险操作中的遮罩点击不关闭，防误触）。
- 图片/视频：`max-width:100%`、`border-radius`、懒加载；视频 controls；大图浏览左右滑切换（已有逻辑保留）；任何媒体不得压住底部坞与导航。
- 地图：Leaflet 容器显式高度（如 380px），z-index 低于弹层；tab 切换到地图时 `map.invalidateSize()`。

## 10. 不要做的事
- 不要糖果粉（#ff6b81/#ff4757 这类高饱和色）、不要彩虹渐变、不要 0 透明外的硬阴影、不要大面积深色底。
- 不要 emoji 当图标（💬📸✨💌📋📝😠🗺️🔧🏠👥📦🗑️⚙️ 全部替换为 SVG）。
- 不要横向滚动整页；不要固定 320px 宽度的死布局；不要内联写死颜色（用 `var(--…)`）。
- 不要在任何前端文件/控制台输出里放真实密钥、PAT、service_role、密码、管理员账号名。
- 不要改动任何功能逻辑的接口路径与数据结构（纯视觉重设计；逻辑 bug 修复由收尾环节按审查清单另行处理）。
- 不要引入第三方 UI 框架/字体/图标库。
