// ============================================================
// 媒体上传（登录用户）：走 Git Data API（blob → tree → commit → ref）
// - 不再使用 /contents PUT（该端点 base64 上传单文件硬上限约 1MB）
// - 单文件上限：图片 10MB / 视频 30MB（与前端限额一致）
// - 保留原校验：登录会话、Origin 白名单、MIME 白名单、SVG 拒绝、路径规则
// ============================================================

import {
  requireSession, checkAllowedOrigin, corsHeaders, jsonResponse,
  readCookie, randomHex
} from '../_lib/session.js';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;   // 图片 10MB
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;   // 视频 30MB
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;   // 音频 20MB
const ALLOWED_FOLDERS = new Set(['common', 'feeds', 'messages', 'bubbles', 'avatars', 'loginbg']);

// 媒体类型白名单（S3：只收图片/视频/音频，杜绝 html/svg/js 等可执行/可脚本类型）
const MIME_TO_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg',
  'image/png': 'png', 'image/x-png': 'png',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/heic': 'heic', 'image/heif': 'heic',
  'image/bmp': 'bmp', 'image/x-ms-bmp': 'bmp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/3gpp': '3gp', 'video/3gpp2': '3g2', 'video/m4v': 'm4v', 'video/x-m4v': 'm4v',
  'video/x-msvideo': 'avi', 'video/mpeg': 'mpeg',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'weba'
};
const ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'heif', 'bmp',
  'mp4', 'mov', 'webm', '3gp', '3g2', 'm4v', 'avi', 'mpeg',
  'mp3', 'm4a', 'aac', 'wav', 'ogg', 'weba']);

// 判断是否为安全的媒体类型：图片（svg 除外）、视频、音频、或未知二进制（按扩展名判）
function isMediaMime(mime) {
  if (!mime) return 'unknown';
  if (mime.indexOf('image/') === 0) return mime === 'image/svg+xml' ? false : 'image';
  if (mime.indexOf('video/') === 0) return 'video';
  if (mime.indexOf('audio/') === 0) return 'audio';
  if (mime === 'application/octet-stream') return 'unknown';
  return false;
}

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const originCheck = checkAllowedOrigin(origin, env.UPLOAD_ALLOWED_ORIGINS);
  const headers = corsHeaders(originCheck.corsOrigin, { methods: 'POST, OPTIONS' });

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (!originCheck.allowed) {
    return jsonResponse({ error: '上传来源不被允许。' }, 403, headers);
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, headers);
  }

  // 登录会话校验：上传必须登录（S3，封死匿名上传）
  const sessionConfig = {
    supabaseUrl: String(env.SUPABASE_URL || '').replace(/\/$/, ''),
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY,
    sessionSecret: env.AUTH_SESSION_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY
  };
  const token = readCookie(request.headers.get('Cookie') || '', 'couple_t') || request.headers.get('X-Couple-Token') || '';
  let session;
  try { session = await requireSession(sessionConfig, token); }
  catch (e) { return jsonResponse({ error: '请先登录后再上传。' }, 401, headers); }

  const ghToken = env.GITHUB_TOKEN;
  const owner = env.GITHUB_OWNER || 'shaozixiang';
  const repo = env.GITHUB_REPO || 'couple-images';
  const branch = env.GITHUB_BRANCH || 'main';

  if (!ghToken) {
    return jsonResponse({ error: 'GITHUB_TOKEN is not configured in Cloudflare Pages.' }, 500, headers);
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') || formData.get('media');

    if (!file || typeof file.arrayBuffer !== 'function') {
      return jsonResponse({ error: 'No media file received.' }, 400, headers);
    }

    // 文件类型白名单：只收图片/视频/音频；SVG 可内嵌脚本、html/js 等一律拒绝
    const mime = String(file.type || '').toLowerCase();
    const kind = isMediaMime(mime);
    if (kind === false) {
      return jsonResponse({ error: '不支持这个文件格式：请上传 jpg/png/gif/webp/heic/avif 照片，mp4/mov/webm/3gp 视频，或 mp3/m4a/wav/ogg 音乐。' }, 400, headers);
    }
    const extension = getExtension(file.name, mime, kind);
    if (!extension) {
      return jsonResponse({ error: '无法识别这个文件的类型：请上传 jpg/png/gif/webp/heic/avif 照片，mp4/mov/webm/3gp 视频，或 mp3/m4a/wav/ogg 音乐。' }, 400, headers);
    }

    // 大小上限：图片 10MB / 视频 30MB / 音频 20MB（Git Data blob 支持 base64 ≤100MB）
    const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : (kind === 'video' ? MAX_VIDEO_BYTES : (kind === 'audio' ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES));
    if (file.size > maxBytes) {
      const limitMb = Math.round(maxBytes / 1024 / 1024);
      return jsonResponse({ error: `文件过大：${kind === 'video' ? '视频' : (kind === 'audio' ? '音乐' : '图片')}请控制在 ${limitMb}MB 以内。` }, 413, headers);
    }

    const folder = sanitizeFolder(formData.get('folder') || 'common');

    // 登录页背景文件夹：仅管理员或被授权用户可传（服务端强制，防止越权塞内容）
    if (folder === 'loginbg') {
      let allowed = session && (session.username === 'admin');
      try {
        const adminResp = await fetch(`${sessionConfig.supabaseUrl}/rest/v1/users?select=role&username=eq.${encodeURIComponent(session.username)}&limit=1`, {
          headers: { apikey: sessionConfig.serviceKey, Authorization: `Bearer ${sessionConfig.serviceKey}` }
        });
        const rows = await adminResp.json().catch(() => null);
        if (Array.isArray(rows) && rows.length && rows[0].role === 'admin') allowed = true;
      } catch (e) {}
      if (!allowed) {
        try {
          const cfgResp = await fetch(`${sessionConfig.supabaseUrl}/rest/v1/login_bg_config?select=authorized_users&limit=1`, {
            headers: { apikey: sessionConfig.serviceKey, Authorization: `Bearer ${sessionConfig.serviceKey}` }
          });
          const cfgRows = await cfgResp.json().catch(() => null);
          const authUsers = Array.isArray(cfgRows) && cfgRows[0] && Array.isArray(cfgRows[0].authorized_users) ? cfgRows[0].authorized_users : [];
          if (authUsers.indexOf(session.username) !== -1) allowed = true;
        } catch (e) {}
      }
      if (!allowed) {
        return jsonResponse({ error: '无权限：登录页背景媒体仅管理员或被授权用户可上传。' }, 403, headers);
      }
    }
    const datedFolder = new Date().toISOString().slice(0, 7);
    const objectName = `${Date.now()}-${randomHex(4)}.${extension}`;
    const githubPath = `${folder}/${datedFolder}/${objectName}`;
    const encodedPath = githubPath.split('/').map(encodeURIComponent).join('/');
    const content = arrayBufferToBase64(await file.arrayBuffer());

    // Git Data API：create blob → tree → commit → update ref
    const gh = (path, opts = {}) => ghFetch(owner, repo, ghToken, path, opts);

    const blob = await gh(`/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content, encoding: 'base64' })
    });
    if (!blob.ok) {
      return jsonResponse({ error: '上传失败（建 blob）：' + (blob.json && blob.json.message || blob.status) }, blob.status || 502, headers);
    }

    const ref = await gh(`/git/ref/heads/${encodeURIComponent(branch)}`);
    if (!ref.ok) {
      return jsonResponse({ error: '上传失败（取分支）：' + (ref.json && ref.json.message || ref.status) }, ref.status || 502, headers);
    }
    const baseCommitSha = ref.json.object.sha;
    const baseCommit = await gh(`/git/commits/${baseCommitSha}`);
    if (!baseCommit.ok) {
      return jsonResponse({ error: '上传失败（取提交）：' }, 502, headers);
    }
    const newTree = await gh(`/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: baseCommit.json.tree.sha,
        tree: [{ path: githubPath, mode: '100644', type: 'blob', sha: blob.json.sha }]
      })
    });
    if (!newTree.ok) {
      return jsonResponse({ error: '上传失败（建树）：' + (newTree.json && newTree.json.message || newTree.status) }, newTree.status || 502, headers);
    }
    const newCommit = await gh(`/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message: `Upload ${folder} media ${objectName}`, tree: newTree.json.sha, parents: [baseCommitSha] })
    });
    if (!newCommit.ok) {
      return jsonResponse({ error: '上传失败（建提交）：' + (newCommit.json && newCommit.json.message || newCommit.status) }, newCommit.status || 502, headers);
    }
    const upd = await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommit.json.sha, force: false })
    });
    if (!upd.ok) {
      return jsonResponse({ error: '上传失败（更新分支）：' + (upd.json && upd.json.message || upd.status) }, upd.status || 502, headers);
    }

    const cdnUrl = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${encodedPath}`;
    return jsonResponse({
      url: cdnUrl,
      cdnUrl,
      path: githubPath,
      size: file.size,
      contentType: mime || MIME_TO_EXT_LOOKUP(extension) || 'application/octet-stream'
    }, 200, headers);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Upload failed.' }, 500, headers);
  }
}

async function ghFetch(owner, repo, token, path, opts = {}) {
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'couple-love-site-uploader',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: opts.body
  });
  let json = null;
  const txt = await resp.text();
  try { json = txt ? JSON.parse(txt) : null; } catch (_) { json = { raw: txt }; }
  return { ok: resp.ok, status: resp.status, json };
}

function MIME_TO_EXT_LOOKUP(ext) {
  return Object.keys(MIME_TO_EXT).find(m => MIME_TO_EXT[m] === ext) || '';
}

function sanitizeFolder(folder) {
  const normalized = String(folder || 'common').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return ALLOWED_FOLDERS.has(normalized) ? normalized : 'common';
}

// 决定落盘扩展名（保证永远是受控的图片/视频扩展名，杜绝 html/svg/js）
function extFromFilename(filename) {
  const nameMatch = String(filename || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  const ext = nameMatch ? nameMatch[1] : null;
  return ext && ALLOWED_EXT.has(ext) ? ext : null;
}

function getExtension(filename, contentType, kind) {
  // 标准 MIME 映射优先（忽略文件名里的可疑后缀，例如伪造 .html 的图片）
  if (contentType && MIME_TO_EXT[contentType]) return MIME_TO_EXT[contentType];
  const nameExt = extFromFilename(filename);
  if (kind === 'image') return nameExt || 'jpg'; // 其他图片格式兜底为 jpg
  if (kind === 'video') return nameExt || 'mp4'; // 其他视频格式兜底为 mp4
  if (kind === 'audio') return nameExt || 'mp3'; // 其他音频格式兜底为 mp3
  // 类型未知（浏览器未报 type 或 octet-stream）：只能依赖文件名扩展名白名单
  return nameExt;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}
