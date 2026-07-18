# GitHub 上传与流量优化修改报告

生成日期：2026-07-18

## 这次改了什么

1. 新增 Cloudflare Pages Function 上传代理：`functions/api/upload-to-github.js`
   - 新上传的图片、视频不再写入 Supabase Storage。
   - 浏览器把文件发给 `/api/upload-to-github`。
   - Cloudflare 后台接口再用 GitHub token 写入 `shaozixiang/couple-images`。
   - 接口返回 jsDelivr CDN 地址，页面继续把这个地址存进 Supabase 数据库。

2. 修改主源码：`index.txt`
   - `uploadToBucket()` 已从 Supabase Storage 上传改成 GitHub 上传接口。
   - 原数据库里的旧图片、旧视频链接没有改，页面仍然按原 URL 展示。
   - 新动态、新留言图片、背景气泡图片会存为 GitHub CDN 链接。

3. 降低数据库请求频率
   - 原来 `startAutoSync()` 每 5 秒刷新留言、动态、感动的话、回忆、待办、行程、倒计时、生气模式、气泡、地图，开着页面就会不断请求数据库。
   - 现在改成每 60 秒只刷新当前正在看的页面。
   - 切换页面时会立即刷新当前页面，所以正常使用不会感觉太慢。
   - 发布、删除、评论、点赞后仍然会立即刷新相关区域。

4. 降低在线状态请求频率
   - 在线心跳从 15 秒一次改为 60 秒一次。
   - 在线状态查询也改为单个受控定时器，避免重复登录/自动登录后叠加多个 `setInterval`。
   - 点击、滚动、输入触发的在线状态写入增加了节流，不会每次操作都写数据库。

5. 降低媒体加载流量
   - 相册和留言图片增加 `loading="lazy"` 和 `decoding="async"`。
   - 视频缩略展示增加 `preload="metadata"`，避免列表页直接下载完整视频。
   - 点击打开大图/视频弹窗的逻辑保持不变。

6. 新增 Cloudflare Pages Function：`functions/api/upload-to-github.js`
   - Cloudflare 会把 `/api/upload-to-github` 请求交给这个文件处理。
   - GitHub token 从 Cloudflare 环境变量读取，不写进前端。
   - `api/upload-to-github.js` 仍保留为 Vercel 备用，不影响 Cloudflare。

7. 新增验证脚本：`tests/verify-output.ps1`
   - 检查没有提交 `ghp_...` token。
   - 检查 `index.txt` 不再使用 Supabase Storage 上传。
   - 检查 `/api/upload-to-github`、懒加载、视频 metadata preload、当前页面刷新优化都存在。

## Cloudflare 部署配置

在 Cloudflare Pages 项目里配置环境变量：

```text
GITHUB_TOKEN=你的新 GitHub token
GITHUB_OWNER=shaozixiang
GITHUB_REPO=couple-images
GITHUB_BRANCH=main
```

重要：你之前发到聊天里的 GitHub token 已经暴露，建议立刻在 GitHub 删除/撤销，然后重新生成一个只给 `couple-images` 仓库写入权限的新 token。

## 使用注意

- 如果直接双击本地 `index.html` 打开，`/api/upload-to-github` 不会存在，上传会失败。
- 要隐藏 token，必须通过 Cloudflare Pages Functions 这类带后台接口的部署方式访问网站。
- Supabase 仍然会保存文字、评论、点赞、行程等数据；只是新媒体文件不再占用 Supabase Storage 出站流量。
- Cloudflare Pages Functions 对请求体大小也有限制，特别大的视频可能上传失败。如果后续视频很多，建议单独做分片上传或改用 Cloudflare R2/GitHub Release 等更适合大文件的方案。
- 前端直传测试已经关闭：`GITHUB_DIRECT_UPLOAD_TEST_MODE = false`。正式部署后会走 Cloudflare `/api/upload-to-github` 代理，GitHub token 放在 Cloudflare 环境变量里。

## 旧照片迁移会不会麻烦

不算特别麻烦，但建议单独做，不要和这次代码改造混在一起。安全做法是：

1. 从 Supabase 读取 `feeds.medias`、`messages.photo`、`bubble_photos.photo_url` 里的旧 URL。
2. 下载旧图片/视频。
3. 上传到 GitHub 仓库。
4. 生成新 CDN 地址。
5. 先导出一份映射表确认无误。
6. 再批量更新 Supabase 数据库里的旧 URL。

这样能保留回滚空间，避免旧照片链接更新错。
