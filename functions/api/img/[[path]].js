// ============================================================
// 私有图片代理 /api/img/*
// 图片存于 GitHub 私有仓库，所有 <img> 请求经此中转：
// 1. 校验登录会话（cookie couple_t 或 X-Couple-Token 头）
// 2. 用 GitHub 只读令牌回源私有仓库拉取图片/视频
// 3. 结果写入 Cloudflare 边缘缓存，同一资源所有登录用户共享
// 未登录 → 401，图片不可见
// ============================================================

// 允许的仓库内路径前缀（按需收紧）
const ALLOWED_PREFIXES = [
  '/photos/', '/messages/', '/feeds/', '/memories/', '/bubble/', '/videos/', '/uploads/'
];

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  try {
    const config = getConfig(env);
    if (!config.ok) return jsonResponse({ error: config.error }, 500);

    // 解析仓库内路径（去掉 /api/img 前缀，解码）
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname.replace(/^\/api\/img\/?/, ''));
    if (!rel) return jsonResponse({ error: '缺少文件路径' }, 400);
    if (rel.charAt(0) !== '/') rel = '/' + rel;
    if (!ALLOWED_PREFIXES.some(p => rel.startsWith(p))) {
      return jsonResponse({ error: '该路径不允许访问' }, 403);
    }

    // 1. 会话校验：cookie 优先，header 兜底
    const token = readCookie(request.headers.get('Cookie') || '', 'couple_t') || request.headers.get('X-Couple-Token') || '';
    try { await requireSession(config, token); }
    catch (e) { return jsonResponse({ error: '未登录或登录已失效' }, 401); }

    // 2. 边缘缓存：按“仓库内路径”缓存，所有登录用户共享
    const cache = caches.default;
    const cacheKey = new Request(`https://img-cache.local/${rel}`);
    const cached = await cache.match(cacheKey);
    if (cached) return new Response(cached.body, { status: 200, headers: cached.headers });

    // 3. 回源 GitHub 私有仓库
    const owner = String(env.GITHUB_IMG_OWNER || '');
    const repo = String(env.GITHUB_IMG_REPO || env.GITHUB_IMG_REPO1 || '');
    const branch = String(env.GITHUB_IMG_BRANCH || 'main');
    const pat = String(env.GITHUB_IMG_TOKEN || '');
    if (!owner || !repo || !pat) return jsonResponse({ error: '图片服务未配置完整' }, 500);

    const upstream = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(rel).replace(/%2F/g, '/')}?ref=${encodeURIComponent(branch)}`;
    const ghResp = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github.raw+json',
        'User-Agent': 'couple-site-private-img'
      }
    });
    if (!ghResp.ok) {
      const txt = await ghResp.text().catch(() => '');
      return jsonResponse({ error: '图片获取失败：' + ghResp.status }, ghResp.status === 404 ? 404 : 502);
    }
    const blob = await ghResp.arrayBuffer();
    const contentType = guessContentType(rel) || ghResp.headers.get('Content-Type') || 'application/octet-stream';
    const body = new Uint8Array(blob);
    const response = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': origin || '*'
      }
    });
    // 存入边缘缓存（最多 24 小时，由 CDN 容量决定）
    const cacheClone = response.clone();
    const ttl = 86400;
    if (cache.put) { await cache.put(cacheKey, withTtl(cacheClone, ttl)); }
    return response;
  } catch (e) {
    return jsonResponse({ error: '图片代理错误：' + ((e && e.message) || String(e)) }, 500);
  }
}

function withTtl(response, ttl) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', `public, max-age=${ttl}`);
  return new Response(response.body, { status: response.status, headers });
}

function guessContentType(rel) {
  const lower = String(rel).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.heic': 'image/heic',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.avi': 'video/x-msvideo'
  };
  for (const ext in map) { if (lower.endsWith(ext)) return map[ext]; }
  return 'application/octet-stream';
}

function readCookie(cookieHeader, name) {
  const parts = String(cookieHeader || '').split(';');
  for (const part of parts) {
    const pair = part.trim().split('=');
    if (pair[0] === name) return decodeURIComponent(pair.slice(1).join('='));
  }
  return '';
}

// ---------- 会话校验（与 /api/account 同一套实现） ----------
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

function getConfig(env) {
  const sessionSecret = env.AUTH_SESSION_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!sessionSecret) return { ok: false, error: 'AUTH_SESSION_SECRET is not configured.' };
  return { ok: true, sessionSecret };
}

function corsHeaders(origin) {
  const headers = { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Couple-Token', Vary: 'Origin' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
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
