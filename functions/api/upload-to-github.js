const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;
const ALLOWED_FOLDERS = new Set(['common', 'feeds', 'messages', 'bubbles', 'avatars']);

export async function onRequest(context) {
  const { request, env } = context;
  const originCheck = checkAllowedOrigin(request.headers.get('Origin') || '', env.UPLOAD_ALLOWED_ORIGINS);
  const headers = corsHeaders(originCheck.corsOrigin);

  if (!originCheck.allowed) {
    return jsonResponse({ error: 'Upload origin is not allowed.' }, 403, headers);
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, headers);
  }

  // 安全：上传必须携带有效登录会话（X-Couple-Token），匿名一律拒绝
  const config = getConfig(env);
  if (!config.ok) return jsonResponse({ error: config.error }, 500, headers);
  const token = request.headers.get('X-Couple-Token') || '';
  try { await requireSession(config, token); }
  catch (e) { return jsonResponse({ error: '未登录或登录已失效，请重新登录' }, 401, headers); }

  const githubToken = env.GITHUB_TOKEN;
  const owner = env.GITHUB_OWNER || 'shaozixiang';
  const repo = env.GITHUB_REPO || 'couple-images';
  const branch = env.GITHUB_BRANCH || 'main';

  if (!githubToken) {
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

    const folder = sanitizeFolder(formData.get('folder') || 'common');
    const extension = getExtension(file.name, file.type);
    const datedFolder = new Date().toISOString().slice(0, 7);
    const objectName = `${Date.now()}-${randomHex(4)}.${extension}`;
    const githubPath = `${folder}/${datedFolder}/${objectName}`;
    const encodedPath = githubPath.split('/').map(encodeURIComponent).join('/');
    const content = arrayBufferToBase64(await file.arrayBuffer());

    const githubResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
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
    // 安全：默认返回代理路径（/api/img/...）存库——需要登录才能取图，不再产生公开 CDN 引用
    const proxyPath = `/api/img/${githubPath}`;
    return jsonResponse({
      url: proxyPath,
      cdnUrl,
      path: githubPath,
      size: file.size,
      contentType: file.type || 'application/octet-stream'
    }, 200, headers);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Upload failed.' }, 500, headers);
  }
}

function getConfig(env) {
  const supabaseUrl = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const sessionSecret = env.AUTH_SESSION_SECRET || serviceKey;
  if (!supabaseUrl) return { ok: false, error: 'SUPABASE_URL is not configured.' };
  if (!serviceKey) return { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' };
  if (!sessionSecret) return { ok: false, error: 'AUTH_SESSION_SECRET is not configured.' };
  return { ok: true, supabaseUrl, serviceKey, sessionSecret };
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

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function checkAllowedOrigin(origin, allowedOriginsConfig) {
  const allowedOrigins = parseAllowedOrigins(allowedOriginsConfig);
  if (allowedOrigins.length === 0) return { allowed: true, corsOrigin: '*' };
  if (!origin) return { allowed: true, corsOrigin: allowedOrigins[0] };
  const allowed = allowedOrigins.includes(origin);
  return { allowed, corsOrigin: allowed ? origin : '' };
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

function getExtension(filename, contentType) {
  const mimeExtension = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov'
  }[String(contentType || '').toLowerCase()];

  if (mimeExtension) return mimeExtension;

  const nameMatch = String(filename || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return nameMatch ? nameMatch[1] : 'bin';
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
