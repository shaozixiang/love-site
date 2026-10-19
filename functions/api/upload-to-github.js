const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;
const ALLOWED_FOLDERS = new Set(['common', 'feeds', 'messages', 'bubbles', 'avatars']);

// 媒体类型白名单（S3：只收图片/视频，杜绝 html/svg/js 等可执行/可脚本类型）
// 注意：
// - 安卓新机默认存 AVIF、部分图库报 image/jpg、iPhone 存 HEIF/HEIC，均需覆盖
// - 分类以 isMediaMime 为准（image/* 除 svg 外放行，video/* 全放行），本表只决定标准扩展名
const MIME_TO_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg',
  'image/png': 'png', 'image/x-png': 'png',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/heic': 'heic', 'image/heif': 'heic',
  'image/bmp': 'bmp', 'image/x-ms-bmp': 'bmp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/3gpp': '3gp', 'video/3gpp2': '3g2', 'video/m4v': 'm4v', 'video/x-m4v': 'm4v',
  'video/x-msvideo': 'avi', 'video/mpeg': 'mpeg'
};
const ALLOWED_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'heif', 'bmp',
  'mp4', 'mov', 'webm', '3gp', '3g2', 'm4v', 'avi', 'mpeg']);

// 判断是否为安全的媒体类型：图片（svg 除外，可内嵌脚本）、视频、或未知二进制（按扩展名判）
function isMediaMime(mime) {
  if (!mime) return 'unknown';
  if (mime.indexOf('image/') === 0) return mime === 'image/svg+xml' ? false : 'image';
  if (mime.indexOf('video/') === 0) return 'video';
  if (mime === 'application/octet-stream') return 'unknown';
  return false;
}

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const originCheck = checkAllowedOrigin(request, origin, env.UPLOAD_ALLOWED_ORIGINS);
  const headers = corsHeaders(originCheck.corsOrigin);

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
  const config = getConfig(env);
  if (!config.ok) return jsonResponse({ error: config.error }, 500, headers);
  const token = readCookie(request.headers.get('Cookie') || '', 'couple_t') || request.headers.get('X-Couple-Token') || '';
  try { await requireSession(config, token); }
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

    if (file.size > MAX_UPLOAD_BYTES) {
      return jsonResponse({ error: 'The selected media is too large for this upload endpoint.' }, 413, headers);
    }

    // 文件类型白名单：只收图片/视频；SVG 可内嵌脚本、html/js 等一律拒绝
    const mime = String(file.type || '').toLowerCase();
    const kind = isMediaMime(mime);
    if (kind === false) {
      return jsonResponse({ error: '不支持这个文件格式：请上传 jpg/png/gif/webp/heic/avif 照片，或 mp4/mov/webm/3gp 视频。' }, 400, headers);
    }
    const extension = getExtension(file.name, mime, kind);
    if (!extension) {
      return jsonResponse({ error: '无法识别这个文件的类型：请上传 jpg/png/gif/webp/heic/avif 照片，或 mp4/mov/webm/3gp 视频。' }, 400, headers);
    }

    const folder = sanitizeFolder(formData.get('folder') || 'common');
    const datedFolder = new Date().toISOString().slice(0, 7);
    const objectName = `${Date.now()}-${randomHex(4)}.${extension}`;
    const githubPath = `${folder}/${datedFolder}/${objectName}`;
    const encodedPath = githubPath.split('/').map(encodeURIComponent).join('/');
    const content = arrayBufferToBase64(await file.arrayBuffer());

    const githubResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'couple-love-site-uploader',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        message: `Upload ${folder} media ${objectName}`,
        branch,
        content
      })
    });

    const githubJson = await githubResponse.json().catch(() => ({}));
    if (!githubResponse.ok) {
      return jsonResponse({ error: githubJson.message || 'GitHub upload failed.' }, githubResponse.status, headers);
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

function MIME_TO_EXT_LOOKUP(ext) {
  return Object.keys(MIME_TO_EXT).find(m => MIME_TO_EXT[m] === ext) || '';
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Couple-Token',
    'Vary': 'Origin'
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

// Origin 校验：配置了白名单则严格匹配；未配置时仅允许同源（登录 token 已是强校验）
function checkAllowedOrigin(request, origin, allowedOriginsConfig) {
  const configured = parseAllowedOrigins(allowedOriginsConfig);
  let sameOrigin = false;
  if (origin) {
    try { sameOrigin = new URL(origin).host === new URL(request.url).host; } catch (e) { sameOrigin = false; }
  }
  if (configured.length > 0) {
    const allowed = configured.includes(origin) || sameOrigin;
    return { allowed, corsOrigin: allowed ? origin : '' };
  }
  if (!origin) return { allowed: true, corsOrigin: '' };
  return { allowed: sameOrigin, corsOrigin: sameOrigin ? origin : '' };
}

function parseAllowedOrigins(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function jsonResponse(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
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
  // 类型未知（浏览器未报 type 或 octet-stream）：只能依赖文件名扩展名白名单
  return nameExt;
}

// ---------- 会话校验（与 /api/account 同一套实现） ----------
function getConfig(env) {
  const sessionSecret = env.AUTH_SESSION_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!sessionSecret) return { ok: false, error: 'AUTH_SESSION_SECRET is not configured.' };
  return { ok: true, sessionSecret };
}

async function requireSession(config, token) {
  const value = String(token || '');
  const parts = value.split('.');
  if (parts.length !== 2) throw new Error('登录已失效');
  const expected = await hmac(config.sessionSecret, parts[0]);
  if (!constantTimeEqual(expected, parts[1])) throw new Error('登录已失效');
  let payload;
  try { payload = JSON.parse(base64UrlDecode(parts[0])); } catch (_) { throw new Error('登录已失效'); }
  if (!payload.u || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('登录已失效');
  return { username: payload.u };
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return arrayBufferToHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

function readCookie(cookieHeader, name) {
  const parts = String(cookieHeader || '').split(';');
  for (const part of parts) {
    const pair = part.trim().split('=');
    if (pair[0] === name) return decodeURIComponent(pair.slice(1).join('='));
  }
  return '';
}

function randomHex(bytes) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, value => value.toString(16).padStart(2, '0')).join('');
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

function arrayBufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer), value => value.toString(16).padStart(2, '0')).join('');
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  return decodeURIComponent(escape(atob(padded)));
}

function constantTimeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
