# 小白部署步骤：把 love 网站上线到 Cloudflare Pages

这份说明按“照着点”的方式写。你之前已经用 Cloudflare 部署静态网站，所以这次继续用 Cloudflare 就行，不一定要换 Vercel。

## 一、为什么 Cloudflare 可以做到

以前你部署的是“纯静态网站”：只有 `index.html`，没有后台。

现在上传 GitHub 图片需要隐藏 token，所以要多一个“小后台”。Cloudflare Pages 支持这个东西，叫 **Pages Functions**。

大白话理解：

- `index.html`：给你和对象看的网页。
- `functions/api/upload-to-github.js`：Cloudflare 后台小接口，负责拿 token 上传到 GitHub。
- `GITHUB_TOKEN`：放在 Cloudflare 后台环境变量里，不写进网页源码。

你的网站前端已经调用这个地址：

```text
/api/upload-to-github
```

Cloudflare 会自动把这个请求交给：

```text
functions/api/upload-to-github.js
```

## 二、你现在要上传到 Cloudflare 的文件

`C:\Users\邵子祥\Desktop\love` 里面这些都要放进你的 Cloudflare Pages 项目对应的 GitHub 仓库：

- `index.html`
- `index.txt`
- `functions` 文件夹
- `api` 文件夹（Vercel 备用，可以保留，不影响 Cloudflare）
- `docs` 文件夹
- `tests` 文件夹
- `.env.example`

重点是：`functions` 文件夹一定要上传，否则 Cloudflare 没有后台接口，图片上传会失败。

## 三、重新生成 GitHub token

你之前把 token 发在聊天里了，这个 token 要当成已经不安全。

大白话：token 就像仓库钥匙，发出来以后别人可能复制，所以要换一把新钥匙。

操作：

1. 打开 GitHub。
2. 点右上角头像。
3. 点 `Settings`。
4. 左边拉到最下面，点 `Developer settings`。
5. 点 `Personal access tokens`。
6. 推荐点 `Fine-grained tokens`。
7. 点 `Generate new token`。
8. Repository access 选择 `Only select repositories`。
9. 仓库选择 `couple-images`。
10. Permissions 里找到 `Contents`，选择 `Read and write`。
11. 生成 token 后复制，先放到你自己的记事本里。
12. 把旧 token 删除或撤销。

## 四、把代码放到 GitHub 网站仓库

Cloudflare Pages 通常是从 GitHub 仓库自动部署的。

如果你已经有原来部署 Cloudflare 的网站仓库，就把 `love` 文件夹里的新文件上传/覆盖到那个仓库。

如果你还没有网站仓库，就新建一个：

1. 打开 GitHub。
2. 右上角点 `+`。
3. 点 `New repository`。
4. Repository name 填：`love-site`。
5. 选 `Private` 或 `Public` 都可以。
6. 点 `Create repository`。
7. 点 `uploading an existing file`。
8. 把 `love` 文件夹里的文件拖进去。
9. 点 `Commit changes`。

提醒：图片仓库 `couple-images` 和网站源码仓库最好分开。`couple-images` 放图片，`love-site` 放网站代码。

## 五、Cloudflare Pages 设置

### 1. 打开 Cloudflare Pages

1. 打开 Cloudflare 控制台。
2. 左侧找到 `Workers & Pages`。
3. 点 `Pages`。
4. 如果已有你的项目，就点进去。
5. 如果没有，点 `Create application` / `Create project`。

### 2. 连接 GitHub 仓库

如果新建项目：

1. 选择 `Connect to Git`。
2. 登录/授权 GitHub。
3. 选择你的网站源码仓库，比如 `love-site`。
4. 进入部署设置。

### 3. 构建设置怎么填

这个项目不用 npm，不用打包。

设置时这样填：

```text
Framework preset: None / 其他 / 无框架
Build command: 留空
Build output directory: /
Root directory: / （如果你的 index.html 在仓库根目录）
```

如果 Cloudflare 不允许 output directory 留 `/`，你可以填：

```text
.
```

大白话：意思就是“直接把仓库根目录当网站目录”。

## 六、Cloudflare 环境变量怎么填

进入 Cloudflare Pages 项目：

1. 点 `Settings`。
2. 点 `Environment variables`。
3. 添加 Production 环境变量。
4. 填这四个：

```text
GITHUB_TOKEN=你刚刚重新生成的新 token
GITHUB_OWNER=shaozixiang
GITHUB_REPO=couple-images
GITHUB_BRANCH=main
```

注意：

- `GITHUB_TOKEN` 填真实 token。
- 另外三个照抄。
- 保存后要重新部署一次。

## 七、重新部署

环境变量填完以后：

1. 回到 Pages 项目的 `Deployments`。
2. 点最新一次部署右边的三个点。
3. 点 `Retry deployment` / `Redeploy`。
4. 等它部署成功。
5. 打开 Cloudflare 给你的网站地址测试上传图片。

## 八、如果上传失败怎么查

### 情况 1：提示 GITHUB_TOKEN 没配置

说明 Cloudflare 环境变量没有填好，或者填完没有重新部署。

处理：

1. 进入 Cloudflare Pages 项目。
2. `Settings` -> `Environment variables`。
3. 检查 `GITHUB_TOKEN` 是否存在。
4. 保存后重新部署。

### 情况 2：GitHub 仓库没有出现图片

检查：

1. token 是否给了 `couple-images` 仓库。
2. token 的 `Contents` 是否是 `Read and write`。
3. `GITHUB_OWNER` 是否是 `shaozixiang`。
4. `GITHUB_REPO` 是否是 `couple-images`。
5. `functions/api/upload-to-github.js` 是否已经上传到网站源码仓库。

### 情况 3：网页提示 `/api/upload-to-github` 404

说明 Cloudflare 没识别到 Functions。

检查：

1. 仓库根目录有没有 `functions/api/upload-to-github.js`。
2. Cloudflare Pages 的 Root directory 是否指向这个根目录。
3. 重新部署一次。

### 情况 4：图片仓库有图片，但前端显示慢

jsDelivr CDN 对新文件有时要等几十秒。刷新页面或等一会儿就好。

## 九、权限功能需要做的 Supabase SQL

打开 Supabase：

1. 进入你的 Supabase 项目。
2. 左侧点 `SQL Editor`。
3. 点 `New query`。
4. 复制 `docs/supabase-permissions.sql` 里的内容。
5. 点 `Run`。

这个 SQL 的作用：给 `users` 表补上 `permission`、`role`、在线状态字段。没有这些字段，管理后台设置权限会保存失败。

## 十、权限规则

- `view`：只能浏览，不能点赞、评论、发布、删除。
- `comment`：可以点赞、评论、提交道歉，但不能发布新内容、上传图片、添加行程/地图/待办。
- `full`：完整权限，可以发布内容、上传图片、添加行程/地图/待办，删除自己发的内容。
- `admin`：管理员，不受限制。

## 十一、部署前确认

源码里现在应该是：

```js
const GITHUB_DIRECT_UPLOAD_TEST_MODE = false;
```

这个意思是：正式部署不再弹窗要 token，而是走 Cloudflare 后台环境变量。
