# 情侣纪念小站（love-site）结项只读代码审查报告

> 审查方式：逐行通读全部业务源码（vendor 的 supabase/leaflet 除外）+ 线上只读 GET 验证。
> 审查日期：2026-10-22。审查对象：原版 `/`（index.html + lib/app.js）与优化版 `/index-v2`（index-v2.html + lib/app-v2.js），以及全部 Cloudflare Pages Functions、SQL、文档。
> 约束：全程只读，未做任何写/删/改/注册；线上仅做 GET 健康检查与未登录边界探测。
> 说明：本站为**私密两人小站**，用户基数极小、彼此信任；下列"可被外部利用"的前提是"有人注册了一个 comment 权限的账号"。严重级别按"一旦发生的危害"定，不按"攻击者多罕见"打折。

---

## 0. 总览

| 等级 | 含义 | 数量 |
|---|---|---|
| **P0** | 安全/数据丢失，必须修 | **2** |
| **P1** | 功能 bug，应当修 | **7** |
| **P2** | 健壮性/性能，建议修 | **8** |
| **P3** | 坏味道/重复，结项取舍 | **4** |

**整体质量判断：中上。**
- 架构方向是对的：所有数据走 `/api/db` 代理 + service_role、前端拿不到 service key、HMAC 会话带过期、未登录一律 401（线上已实测）、安全头/CSP/HSTS 齐全、路径穿越与图片代理做了白名单、上传做了 MIME 白名单与 SVG 拒绝、管理员二次校验贯穿各管理动作、登录有失败限流。这些是这个体量项目里少见地做对了的地方。
- 真正的硬伤集中在 **一处写权限模型的漏网**（P0-01）和 **点赞/评论整列覆盖**（P0-02），以及 **上传链路的容量假设与 GitHub API 限制不符**（P1-01，v2 受影响更重）。
- 结项前建议至少把 2 个 P0 + P1-01/P1-02/P1-03 修掉，其余可排入"已知问题"清单，不影响安全交付。

---

## P0 安全 / 数据丢失（必须修）

### P0-01  `/api/db` 写策略放行任意登录用户写 `site_config` / `bubble_*`，可篡改全站配置并劫持通知邮箱
- **位置**：`functions/api/db/[[path]].js:119-155`
- **证据**：
  ```js
  const SHARED_TABLES = new Set([
    'bubble_config', 'bubble_photos', 'admin_logs', 'site_config', 'users', 'logs'
  ]);
  ...
  // POST：归属表必须用当前用户身份发布，防止冒充他人
  if (method === 'POST') {
    if (OWNER_TABLES.has(table)) { ...校验 author===session.username... }
    return;   // ← 其它表（含 site_config/bubble_config/bubble_photos）直接放行，不查角色
  }
  ```
  `site_config` 不在 `OWNER_TABLES`，POST 直接落到 `return` 放行。而请求头 `Prefer` 是被原样转发的（同文件 `:82-83`），客户端可自行带 `Prefer: resolution=merge-duplicates` 做 upsert。
- **影响**：任何**已登录、最低 comment 权限**的自助注册用户，都能直接 `POST /api/db/rest/v1/site_config` upsert：
  - `{key:'register_open', value:'1'}` 偷偷开放注册；
  - `{key:'signup_code', value:'自己设的邀请码'}`；
  - **最严重**：`{key:'email_boy', value:'attacker@example.com'}` 覆盖对方收件邮箱（`sendNotify` 读的就是 `email_<recipient>`，见 account.js:519），此后 boy/girl 的新动态通知邮件全部发到攻击者邮箱。
  同理可 `POST bubble_config` / `bubble_photos`。这是一处真实的越权提权，而非理论问题。
- **修复建议**：在 `enforceWritePolicy` 的 POST 分支里，对 `SHARED_TABLES` 一律先 `requireAdmin`（或对 `site_config`/`bubble_config` 强制管理员）。最小改法：
  ```js
  if (method === 'POST') {
    if (table === 'site_config' || table === 'bubble_config' || table === 'bubble_photos' || table === 'logs') {
      if (!(await checkAdmin(config, session.username))) throw new Error('该表不允许普通用户写入');
      return;
    }
    if (OWNER_TABLES.has(table)) { ...原 author 校验... }
    return;
  }
  ```
  更稳妥：把"哪些表允许普通用户写"做成显式白名单，而不是"默认放行、只拦 OWNER"。
- **v1/v2 是否都受影响**：是（漏洞在服务端代理，两版前端共用）。

### P0-02  feeds/messages 的 `likes`/`comments` PATCH 不校验归属且为整列覆盖，可被任意登录用户清空/篡改
- **位置**：`functions/api/db/[[path]].js:167-173`；前端读改写 `lib/app.js:647-666`、`lib/app-v2.js:647-650`
- **证据**：服务端对"评论/点赞交互"开了一个归属豁免：
  ```js
  // 评论/点赞交互：对他人内容更新 comments / likes 数组放行
  if (method === 'PATCH' && (table === 'feeds' || table === 'messages')) {
    const payload = JSON.parse(bodyText || '{}');
    const keys = Object.keys(payload);
    if (keys.length && keys.every(k => k === 'comments' || k === 'likes')) return; // 不查作者、不查内容
  }
  ```
  PostgREST 的 PATCH 是**整列替换**（不是数组 append）。前端虽然用"先 select 再 push 再整列写"的友好写法，但代理对 `{likes: []}` 这种请求同样放行。
- **影响**：任意 comment 权限用户可向别人的动态发 `PATCH {likes: []}` 清空全部点赞，或 `PATCH {comments: [{...伪造内容...}]}` 整列覆盖评论（伪造别人留言）。属于对他人数据的破坏/篡改。
- **修复建议**：
  1. 服务端不要放行"整列替换"。改用 PostgREST 的数组操作语义，或在服务端 read-modify-write：真的读取原 `likes`/`comments`，在服务端做 append/remove 当前用户项后再写，前端只发 `{op:'like'}` / `{op:'unlike'}`。
  2. 至少在豁免里校验：`likes` 只能增删"自己"这一项、`comments` 只能增删"自己写的"评论（按数组元素 author 判断），不能整列重写。
  3. 短期兜底：代理对该豁免只接受 `Prefer`/数组追加语法，拒绝裸整列赋值。
- **v1/v2 是否都受影响**：是。

---

## P1 功能 bug（应当修）

### P1-01  上传/回源走 GitHub `/contents/` API，单文件 ~1MB 硬上限，与前端 10/50/95MB 假设严重不符
- **位置**：上传 `functions/api/upload-to-github.js:92-106`；回源 `functions/api/img/[[path]].js:63-70`；前端限额 `lib/app.js:119-120`、`lib/app-v2.js:354-356`
- **证据**：
  - 上传用 `PUT /repos/:owner/:repo/contents/:path`（base64），GitHub 该端点**单文件硬上限约 1MB**（>1MB 必须走 Git Data blobs 多段）。
  - 但 `MAX_UPLOAD_BYTES = 95MB`，且前端：v1 允许图 10MB / 视频 50MB（app.js:119-120），v2 直接放到 95MB 并**关掉了图片压缩**（app-v2.js:357 `原图直传，不再压缩`）。
  - 回源 `/api/img` 同样用 `/contents/...raw`（img/[[path]].js:63），>1MB 的文件拉不回来。
- **影响**：但凡图片 >1MB（手机原图很常见）或任意视频，**上传接口直接报 GitHub 错误**；即使侥幸传上去，`/api/img` 也播不出来。v2 因为取消压缩、放开 95MB，踩中概率最高。这是当前最影响"能不能传视频"的现实 bug。
- **修复建议**：
  1. 短期：把前端限额下调到 900KB 以内，并在 v2 恢复图片压缩（2MB/1280px）；视频明确提示"暂不支持"。
  2. 正确做法：改用 Git Data API（create blob → create tree → create commit，trash.js 的 `commitTree` 已经是这套，可以复用）上传 >1MB 文件。
  3. 回源 `/api/img` 对大文件改用 raw 下载或 jsDelivr（私仓不行），或接受"视频放 R2"。
- **v1/v2 是否都受影响**：是，v2 更严重（已关压缩、限额 95MB）。

### P1-02  `escapeHtml` 不转义引号，属性上下文可被注入（存储型 XSS）
- **位置**：`lib/app.js:2730-2732`、`lib/app-v2.js:99`；注入点 `lib/app.js:785`、`lib/app-v2.js:609,611`
- **证据**：
  ```js
  function escapeHtml(str){ return String(str||'').replace(/[&<>]/g, m => ...); }  // 只转义 & < >，不转义 " '
  ```
  但渲染时把转义后的值放进了**带引号的属性**：
  ```js
  // app-v2.js:611
  `<img src="${imgProxy(url)}" data-author="${escapeHtml(feed.authorName||feed.author)}" data-desc="${escapeHtml((feed.desc||'').slice(0,40))}" ...>`
  ```
  留言内容若含 `"`，例如 `x" onmouseover="alert(1) x="`，转义后引号仍在，直接 breakout 属性，挂上 `onmouseover` 即执行脚本。
- **影响**：存储型 XSS。同 `app/app.js` 的 PWA 版 `esc()` 已经正确转义 `[&<>"']`（app/app.js:16），主站两版漏了引号。
- **修复建议**：把两版的 `escapeHtml` 改成和 PWA 一致：`/[&<>"']/g` 映射到 `&amp;&lt;&gt;&quot;&#39;`。一处函数改动即可。
- **v1/v2 是否都受影响**：是。

### P1-03  道歉信 `author_name` 与生气模式 `mode.by` 未转义直拼 innerHTML；公开注册不限制用户名字符集
- **位置**：`lib/app.js:1283,1289`、`lib/app-v2.js:1092`；注册 `functions/api/account.js:253-258`
- **证据**：
  ```js
  // app.js:1283 生气状态
  document.getElementById('angryStatus').innerHTML = '😠 生气模式已开启（开启者：' + mode.by + '）';
  // app.js:1289 道歉列表（apologies 是直查，没过 sanitizeContentRows）
  `...<div class="card-meta">${a.fromName || a.from} · ...`
  ```
  而 `publicRegister` 只做 `cleanUsername()`（account.js:254，仅 trim+截断），**不校验字符集**（只有改名字 `changeUsername` 在 account.js:380 校验了正则）。于是自助注册一个用户名为 `<img src=x onerror=alert(1)>` 的账号，再开生气模式/写道歉，即可在对方页面执行脚本。
- **影响**：存储型 XSS（条件：开放注册或拿到邀请码）。
- **修复建议**：
  1. `mode.by` / `a.fromName` 渲染前一律 `escapeHtml(...)`。
  2. 服务端 `publicRegister`/`createUser` 复用 `changeUsername` 同款正则 `^[A-Za-z0-9_.-]{1,64}$`，从源头杜绝 HTML 用户名。
- **v1/v2 是否都受影响**：是。

### P1-04  点赞/评论"读—改—写整列"存在并发丢赞/丢评论
- **位置**：`lib/app.js:647-666`、`lib/app-v2.js:647-650`
- **证据**：`select likes` → 本地 push → `update({likes: 整个数组})`。两人几乎同时点赞时，后写覆盖先写，先写者的赞丢失；评论同理。
- **影响**：偶发点赞数/评论数对不上。与 P0-02 是同一根因，服务端改原子操作可一并解决。
- **修复建议**：见 P0-02（服务端原子 append/remove）。
- **v1/v2 是否都受影响**：是。

### P1-05  软删除/改名后，图片边缘缓存仍保留最长 24 小时
- **位置**：`functions/api/img/[[path]].js:88-101`
- **证据**：`cache.put(cacheKey, withTtl(cacheClone, 86400))`，缓存 key 只按仓库路径、不按会话；文件被 `gitMove` 到 `trash/` 后，原路径边缘节点在 TTL 内仍返回旧字节。
- **影响**：刚移入回收站的私密照片/视频，在 CDN 边缘最长还能被已登录用户拉到（会话每次都校验，但内容是缓存的旧内容）。删除的"即时性"不成立。
- **修复建议**：删除/恢复/改名时无法主动 purge CF 缓存的话，把 `ttl` 降到 5 分钟量级；或在 `gitMove` 成功后，对受影响路径发 `cache.purge`（CF 有 purge by URL API）。
- **v1/v2 是否都受影响**：是（同一条 img 代理）。

### P1-06  改名级联漏改 `comments[].authorName` 与 `angry_mode.by`
- **位置**：`docs/change-username-function.sql`（PL/pgSQL）；客户端评论结构 `{author, authorName, content, time}`
- **证据**：改名函数遍历更新了 `author`、`deleted_by`、`likes`、`comments->author`，但：
  - 评论对象里的展示字段 `authorName`（前端写入时是"emoji+旧用户名"）**没有被更新**；
  - `angry_mode.by` 列不在遍历更新的列清单里（它既不叫 author 也不叫 deleted_by）。
- **影响**：用户改名后，历史评论仍显示旧昵称；生气状态里的"开启者"仍显示旧名。纯展示不一致，不影响登录（登录用新 token）。
- **修复建议**：改名函数补两段——`comments` jsonb 里同时 `jsonb_set(e,'{authorName}', to_jsonb($1_display))`（display 名需要前端约定或直接存新名）；并对 `angry_mode` 单独 `update ... set by=$1 where by=$2`。
- **v1/v2 是否都受影响**：是（DB 函数层）。

### P1-07  "幽灵令牌"防护不一致：account 接口校验账号存活，db/img/trash 不校验
- **位置**：`functions/api/account.js:706-708`（有 `fetchUser` 存活校验）vs `functions/api/db/[[path]].js:315-325`、`functions/api/trash.js:282-292`、`functions/api/img/[[path]].js:128-138`（都不校验）
- **证据**：account.js 明确注释"防幽灵令牌：账号被删除后旧 token 立即失效"，但 db/trash/img 三处 `requireSession` 只验 HMAC+过期，不查 users 表。
- **影响**：管理员删掉一个账号后，该账号的旧 token 在 30 天 TTL 内仍能通过 `/api/db` 读写业务数据、通过 `/api/img` 看图。与设计意图不符。
- **修复建议**：把"验签 + 查 users 存活"收敛成一份共享实现，四个入口统一调用。
- **v1/v2 是否都受影响**：是。

---

## P2 健壮性 / 性能（建议修）

### P2-01  `updateAvatar` 无大小/真实类型校验，可写超大 base64
- **位置**：`functions/api/account.js:414-418`
- **证据**：`if (!value.startsWith('data:image/')) throw ...;` 之后直接落库，没有长度上限。前端也只是从 `<input accept=image>` 读。
- **影响**：可把 users.avatar 写成几 MB 的 base64，膨胀 users 表与每次 `/api/account me` 的响应（listUsers 已特意不返回头像，但 `me`/sanitizeUser 仍返回）。
- **修复建议**：限制 `data:` URL 长度（如 ≤ 500KB），必要时服务端转码压缩。
- **v1/v2**：共用。

### P2-02  密码哈希强度弱、最小长度 4、登出不失效、cookie 非 HttpOnly
- **位置**：`functions/api/account.js:655-659,756-758,609-612`；前端 `lib/app.js:268`
- **证据**：`SHA-256(salt:password:sessionSecret)` 是快速哈希（非 bcrypt/argon2）；`PASSWORD_MIN_LENGTH=4`；`logout` 只置 `is_online=false`，不撤销 token（30 天有效）；cookie `couple_t` 由 JS 写入、非 HttpOnly。
- **影响**：离线爆破门槛低；退出登录后 token 仍可用。对两人小站风险可控，但属应知。
- **修复建议**：换 PBKDF2/argon2（CF Workers 有 WebCrypto PBKDF2）；密码最小长度提到 8；登出可在 site_config 记一个 `token_invalid_before` 时间戳，requireSession 校验 `iat > 它`。
- **v1/v2**：共用。

### P2-03  回收站"文件 + 数据库"非事务，单侧失败会不一致
- **位置**：`functions/api/trash.js:80-130`
- **证据**：软删除"先 gitMove 再 PATCH deleted_at"，若 PATCH 失败，文件已进 trash 但记录仍可见；purge"先删文件再 DELETE 行"，若 DELETE 失败则留下指向已删文件的孤儿行。
- **影响**：偶发"图裂了但记录还在"或"回收站里点恢复没图"。
- **修复建议**：失败时写入一个待补偿队列（或在 admin_logs 记一条"需人工核对"），或改为先打 DB 标记、文件异步移动（接受短暂双份）。
- **v1/v2**：共用。

### P2-04  db/trash/img 的 CORS 反射任意 Origin，且 trash/img 接受 cookie 自动附带
- **位置**：`functions/api/db/[[path]].js:342-346`、`functions/api/trash.js:316-320`（均 `if(origin) ACAO=origin`，无白名单）；`functions/api/account.js:744-750` 才有白名单。
- **影响**：img 代理已修回同源回显（`:152-156`），但 db/trash 仍反射任意 Origin。好在鉴权走 `X-Couple-Token` 头（跨站读不到 localStorage），实际 CSRF 面小；但 trash/img 同时认 cookie `couple_t`，叠加 SameSite=Lax 已能挡住大部分跨站 POST。
- **修复建议**：db/trash 也套用 account 的 Origin 白名单。
- **v1/v2**：共用。

### P2-05  PWA 的 Service Worker 会把 `/api/db` 的 GET 响应当媒体缓存（数据 stale）
- **位置**：`app/sw.js`（fetch 处理），`app/app.js:171` 注册
- **证据**：sw.js 只对 `/app/*` 走 network-first，**其余所有 GET（含 `/api/db/rest/v1/...`）走 cache-first**。
- **影响**：PWA 里数据更新后仍读 SW 缓存的旧列表。主站 `/`、`/index-v2` 未注册 SW，不受影响——仅限 `/app/` PWA。
- **修复建议**：sw.js 里显式跳过 `/api/` 前缀（直接 `return` 不缓存），只缓存静态壳与 `/api/img/` 媒体。
- **v1/v2**：不影响主站，仅 PWA。

### P2-06  前端全表拉取 500 行、点赞/评论各发一次 select（N+1）
- **位置**：`lib/app.js:244`（PAGE_LIMIT=500）、`:585,647`；v2 `lib/app-v2.js:315`
- **影响**：数据量上来后首屏重；点赞/评论各一次往返。v2 的本地增量缓存（getCachedRows/mergeRowsById）已显著缓解，v1 仍是每次全量。
- **修复建议**：v1 可考虑同步 v2 的增量缓存；或至少分页。
- **v1/v2**：v1 更明显。

### P2-07  软删除/可见性依赖"服务端注入 + 出口过滤"双写，用户名含点号会绕过入口过滤
- **位置**：`functions/api/db/[[path]].js:238`（`safeName = /^[A-Za-z0-9_-]{1,32}$/`，不含 `.`）
- **证据**：改名字符集允许 `.`（account.js:380），但入口 `safeName` 正则不允许 `.`。一旦出现含点的用户名，`users`/`loves` 的入口注入条件会被跳过。
- **影响**：目前出口过滤 `applyReadFilter`（`:207,223`）仍兜底，暂不漏数据；属"防线不一致"，将来谁改坏出口过滤就会真漏。
- **修复建议**：两处正则统一为 `^[A-Za-z0-9_.-]{1,64}$`。
- **v1/v2**：共用。

### P2-08  本地日志/离线缓存只写不控量
- **位置**：`lib/app-v2.js:292-325`（每表全量快照进 localStorage）、`LOG_LOCAL_LIMIT=300`
- **影响**：v2 把每表 ≤500 行快照存 localStorage，用户数据多了会逼近 5MB 配额，偶发写失败被静默吞掉（`writeLocalJSON` catch）。
- **修复建议**：给 localStorage 总占用设软上限，超限先清最老的 section 缓存。
- **v1/v2**：v2 为主。

---

## P3 坏味道 / 重复（结项取舍）

### P3-01  `app.js`(3181行) 与 `app-v2.js`(2351行) 大量重复——结项阶段不建议强行抽公共文件
- **重复函数清单（同名/近义）**：`dbProxyFetch / imgProxy / setSession / clearSession / getSessionToken / accountApi / trashApi / escapeHtml / normalizeVisibility / isCoupleAccount / canViewRecord / sanitizeContentRows / selectContentRows / compressImage / uploadToBucket / addFeedComment / deleteComment / toggleFeedLike / addMessage* / toggleMessageLike / renderLoves / renderMemories / renderMemos / renderSchedules / renderCountdowns / loadMarkers / loadAngryData / submitApology / reviewApology / requirePermission / requireAdmin / hasPermission / canDeleteRecord / updateTogetherDays / addDanmaku / formatPrettyDate / trackEvent / flushTrack`。
- **v2 砍掉**：QQ 同步全家桶（`renderQqSyncPanel`/`collectQqSyncQueue`/`buildQqSyncItem` 等 ~14 个函数）、`loadFeedMedia/loadMessagePhoto/shouldUseHeavyMedia`（懒加载媒体）、`uploadToGitHubFromBrowser`。
- **v2 新增**：通知/邮箱面板（`renderNotifyConfigPanel/saveNotifyConfig/openEmailModal/saveMyEmail/testNotifyEmail`）、离线增量缓存（`getCachedRows/mergeRowsById/readLocalJSON/writeLocalJSON/sectionCacheKey`）、`toast`、`authorAvatarHtml/authorDisplay/bestImgSrc/tryFallback`、`exportAdminLogs/clearAdminLogs`。
- **结论**：两版已独立演进、交互与数据层都分叉（v2 改了渲染为九宫格+本地缓存，v1 是点按钮懒加载）。**结项阶段不建议抽公共 JS 文件**——回归测试成本高于收益。建议只把"安全敏感的小函数"收敛成一份 `lib/common-security.js`：至少 `escapeHtml`（补引号）、`imgProxy`、`setSession/clearSession/getSessionToken`、`accountApi/trashApi`。改完两版各引一次，顺便修掉 P1-02。
- **v1/v2**：—。

### P3-02  死代码 / 历史包袱
- **位置**：`api/upload-to-github.js`（旧 CommonJS/Express 写法，Cloudflare 不加载，且**无任何鉴权**，若被误部署即匿名上传）；`lib/app.js:51-54,167-203` `GITHUB_DIRECT_UPLOAD_TEST_MODE` 直传分支（开关已 false）；`index.txt`（164KB 早期存档）；`private-test.html`（384KB 打包测试页）。
- **建议**：结项前删除或移到 `archive/`，尤其 `api/upload-to-github.js` 这种"无鉴权旧版"不该留在部署根。
- **v1/v2**：—。

### P3-03  硬编码个人信息 / 魔法数字 / 残留 console
- **位置**：`functions/api/upload-to-github.js:54-55`、`lib/app.js:52-54` 硬编码 owner `'shaozixiang'`；`console.log/warn/error` 遍布两版（如 app.js:397,673,2913）；魔法常量 `PAGE_LIMIT=500` 等散落。
- **建议**：owner 走环境变量（已有 env 兜底，删默认值即可）；生产 build 去掉 console。
- **v1/v2**：是。

### P3-04  五份重复的"会话验签"样板
- **位置**：account.js / db/[[path]].js / trash.js / img/[[path]].js / upload-to-github.js 各自复制了 `requireSession/hmac/base64UrlDecode/constantTimeEqual/arrayBufferToHex/getConfig`。
- **建议**：抽到 `functions/_lib/session.js`（Pages Functions 可用 `import` 共享），顺手统一 P1-07 的"账号存活校验"。
- **v1/v2**：—。

---

## 修复顺序建议（先做什么后做什么）

1. **先堵越权（半天）**：P0-01（site_config/bubble_* POST 加管理员校验）+ P0-02（likes/comments 改为服务端原子操作或限本人项）。这两个是唯一"会被一个普通账号用来破坏/劫持"的洞。
2. **再修上传/回源容量（1 天）**：P1-01。否则传视频/大图一直失败。改前端限额 + v2 恢复压缩，中期上 Git Data blobs。
3. **统一转义与会话（半天）**：P1-02（escapeHtml 补引号）+ P1-03（注册用户名正则 + 道歉/生气状态转义）+ P1-07（四处 requireSession 合并、加存活校验）。借这次顺手把 P3-04 一起抽了。
4. **数据一致性收尾（按需）**：P1-05（图片缓存 TTL/purge）、P1-06（改名函数补 authorName/by）、P2-03（回收站补偿）。
5. **结项清理（半天）**：P3-02 删死代码、P2-01 头像大小限制、P2-05 SW 跳过 /api。

---

## 附录 A：v1 / v2 功能对照表

| 功能 | v1（/） | v2（/index-v2） | 一致性 |
|---|---|---|---|
| 登录 / 注册 / 改密 / 改名 / 头像 | ✅ | ✅ | 一致（共用 /api/account） |
| 留言板（图文/评论/点赞） | ✅ | ✅ | 一致 |
| 时光相册 | ✅（点"Load media"懒加载） | ✅（九宫格直显，含图直拉） | 交互不同，功能一致 |
| 回忆打卡 | ✅ | ✅ | 一致 |
| 感动的话（public/private） | ✅ | ✅ | 一致 |
| 待办备忘（优先级/勾选） | ✅ | ✅ | 一致 |
| 行程 / 纪念日倒计时 | ✅ | ✅ | 一致 |
| 生气模式 / 道歉信 | ✅ | ✅ | 一致 |
| 旅行地图（Leaflet 标记） | ✅ | ✅ | 一致 |
| 梦幻气泡（配置/照片池） | ✅ | ✅ | 一致 |
| 回收站（list/restore/purge） | ✅ `renderTrashPanel` | ✅ `loadTrashSection` | 一致（函数名不同） |
| 管理后台（用户/权限/角色/日志/内容） | ✅ | ✅ | 一致 |
| **邮箱通知面板 / 自绑邮箱 / 测试邮件** | ❌ | ✅ 新增 | **v2 独有** |
| **离线缓存 + 增量同步（省流量秒开）** | ❌ | ✅ 新增 | **v2 独有** |
| **Toast 轻提示** | ❌（用 alert） | ✅ 新增 | v2 体验更好 |
| QQ 同步面板 | ✅（已废弃） | ❌ 已移除 | v2 删了（合理） |
| 上传大小限制 | 图10M/视频50M（>1M 仍会失败） | 95M 且关压缩（>1M 仍会失败） | **两者都有 P1-01 bug** |
| XSS 转义 | 同病（P1-02/P1-03） | 同病（P1-02/P1-03） | 都要修 |

> 结论：v2 没有"少功能"，反而是超集（多了通知面板、离线缓存、Toast）。v1 未被 v2 修复覆盖的同一批 bug（XSS、上传容量、点赞竞态）**两版都要各自打补丁**，不能只改一边。

---

## 附录 B：结项验收检查表

- [ ] P0-01：以一个 comment 权限账号尝试 `POST /api/db/rest/v1/site_config`，返回 403
- [ ] P0-01：确认 `bubble_config/bubble_photos` 的 POST 同样仅管理员可写
- [ ] P0-02：普通用户无法用 `{likes:[]}` 清空他人动态点赞；无法整列覆盖他人评论
- [ ] P1-01：上传一张 2MB 图片 / 一段 2MB 视频能成功且能在 `/api/img` 正常打开
- [ ] P1-01：v2 图片恢复压缩，前端限额与 GitHub API 实际能力一致
- [ ] P1-02：在留言/相册描述里输入含 `"` 的文本，渲染后无属性 breakout
- [ ] P1-03：注册被限制为 `[A-Za-z0-9_.-]`；道歉信作者名、生气状态开启者均已转义
- [ ] P1-04：两人同时点赞，最终点赞数正确（无丢失）
- [ ] P1-05：把一张图移入回收站后，原路径在可接受时间内不再返回旧图
- [ ] P1-06：改名后，历史评论显示新昵称、生气状态开启者为新名
- [ ] P1-07：删除一个账号后，其旧 token 访问 `/api/db` 立即 401
- [ ] P2-01：超大 base64 头像被服务端拒绝/截断
- [ ] P2-05：PWA 下发布新留言后能立刻看到（SW 不再缓存 `/api`）
- [ ] 安全头在线上仍在（CSP/HSTS/X-Frame-Options/nosniff）——已实测通过
- [ ] 未登录访问 `/api/db`、`/api/img`、`/api/trash` 均 401——已实测通过
- [ ] 前端/仓库中无任何真实 service_role key / PAT（已确认；仅出现 anon publishable key，属公开）
- [ ] `api/upload-to-github.js` 等死代码已删除或归档
- [ ] 版本戳 `?v=2026xxxx` 已 bump，避免旧 JS 缓存
- [ ] keepalive workflow 最近一次运行成功（保活 Supabase 免费版）

---

## 附录 C：修复状态总表（2026-10-22 收尾，已随 main 部署）

| 编号 | 问题 | 状态 | 修复位置 / 说明 |
|---|---|---|---|
| P0-01 | 越权写 site_config/bubble_* | ✅ 已修 | `db/[[path]].js` 写表白名单 + 显式 ADMIN_ONLY_TABLES；非 OWNER 表 POST 一律拒绝。curl 实测普通账号 403 |
| P0-02 | 点赞/评论整列覆盖 | ✅ 已修 | `sanitizeInteractionPatch()` 服务端 read-modify-write，以库内数组为基准，只允许增删本人点赞/评论。**管理员也不再绕过**（E2E 实测修复，陈旧覆盖已拦截） |
| P1-01 | 上传 GitHub API 容量/1MB 限制 | ✅ 已修 | 上传改 Git Data API（blob→tree→commit），图片 10MB/视频 30MB；img 代理改 raw.githubusercontent.com 透传 Range |
| P1-02 | XSS 引号转义不全 | ✅ 已修 | 两版 `escapeHtml` 升级为 `& < > " '` 五字符，属性上下文全覆盖 |
| P1-03 | 道歉/生气模式作者名直拼 | ✅ 已修 | mode.by / a.fromName / 点赞用户名全部转义 + textContent；旧缓存名 stripNameEmoji |
| P1-04 | 点赞并发竞态 | ✅ 已修 | 同 P0-02，原子化后无丢失 |
| P1-05 | 图片边缘缓存旧字节 | ✅ 已修 | 分级 TTL（图 1h/视频 1d）+ trash 删除主动 purge；命中缓存 Range 切片 206 |
| P1-06 | 改名级联不全 | ⚠️ 需手动 SQL | `sql/rename-cascade-supplement.sql`（comments.authorName + by 列），用户在 SQL Editor 执行 |
| P1-07 | 幽灵令牌仍可用 | ✅ 已修 | 抽 `functions/_lib/session.js`，所有端点校验 HMAC+过期+users 存活 |
| P2-01 | 超大 base64 头像 | ✅ 已修 | account.js 解码后 >500KB 拒绝 |
| P2-02 | 口令强度/哈希 | ✅ 已修 | 最小 8 位（登录路径不校验）；PBKDF2-SHA256 12 万次，旧 SHA256 透明升级 |
| P2-03 | 回收站单侧失败无补偿 | ✅ 已修 | trash.js 任一步失败写 admin_logs（trash_compensation_needed） |
| P2-04 | CORS 预检回显任意外域 | ✅ 已修 | 预检也走白名单，恶意 Origin 403 无 ACAO |
| P2-05 | Service Worker 缓存 /api | ✅ 已修 | app/sw.js `/api/` network only，仅 `/api/img/` cache-first |
| P2-07 | 改名正则不一致 | ✅ 已修 | db 代理 safeName 与前端统一 `[A-Za-z0-9_.-]{1,64}` |
| P2-08 | localStorage 缓存写爆 | ✅ 已修 | 写失败按 syncedAt 淘汰最旧 section 缓存后重试 |
| P3-02 | 旧 api/ 死代码、私测文件 | ✅ 已修 | 删旧 api/，index.txt/private-test.html 入 archive/，敏感目录 functions 404 |
| P3-03 | 硬编码 owner | ✅ 已修 | env 优先，兜底保留 |
| P3-04 | 会话逻辑重复 | ✅ 已修 | 统一 `_lib/session.js` |
| — | users.password 明文凭据列 | ⚠️ 需手动 SQL | `sql/final-maintenance-20261022.sql` 步骤 1（DROP COLUMN），本地无 service 凭据无法执行 |
| — | couple-media 公开桶 | ⚠️ 需手动 SQL | 同上步骤 2（改私有），业务实际不用此桶 |
| — | CSP unsafe-inline | ⏸ 已接受 | 全站 inline onclick 架构所致，已有同源+转义+防 CSRF 兜底，结项不重构 |
| — | Cookie 非 HttpOnly | ⏸ 已接受 | 前端需读 cookie 走图片代理，架构权衡；令牌有效期 30 天 + HMAC |
| — | 图片/视频冷回源慢 | ⏸ 已优化 | 私仓 + 跨太平洋 raw 回源固有；已用边缘分级缓存/Range 切片/骨架占位缓解，首次仍慢，重复访问秒开。彻底解决需迁移到 R2/CDN（可选，见安全监控文档） |

### 附录 C 备注
- 所有"✅ 已修"均已 `node --check` 通过、push main 部署，并经 API 级（curl）或浏览器真机走查验证。
- 三个"⚠️ 需手动 SQL"为本地无 service_role 连接凭据，无法代为执行；文件幂等，按 `final-maintenance → monitoring_rpcs → rename-cascade` 顺序执行后，安全评分预期升至约 94/A（仅剩 CSP 一项）。
- 已确认：旧密码账号 doubaotest/doubao、test/0000 登录完全兼容（哈希透明升级）。
