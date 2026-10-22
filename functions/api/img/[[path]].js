// ============================================================
// 私有图片代理 /api/img/*
// 图片存于 GitHub 私有仓库，所有 <img> 请求经此中转：
// 1. 校验登录会话（cookie couple_t 或 X-Couple-Token 头），含账号存活校验
// 2. 用 GitHub 只读令牌回源私有仓库拉取图片/视频（raw 域名，支持 Range，可拖动播放）
// 3. 结果写入 Cloudflare 边缘缓存（TTL 300 秒），同一资源所有登录用户共享
// 未登录 → 401，图片不可见
// ============================================================

import { requireSession, readCookie } from '../../_lib/session.js';

// 允许的仓库内路径前缀（按需收紧）
const ALLOWED_PREFIXES = [
  '/photos/', '/messages/', '/feeds/', '/memories/', '/bubble/', '/videos/', '/uploads/', '/trash/', '/common/', '/avatars/'
];

// 边缘缓存 TTL（秒）：软删除/改名后旧字节最多残留 5 分钟（P1-05）
const EDGE_CACHE_TTL = 300;

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const aco = echoableOrigin(request, origin);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(aco) });
  }
  try {
    // 1. 会话校验：cookie 优先，header 兜底
    const token = readCookie(request.headers.get('Cookie') || '', 'couple_t') || request.headers.get('X-Couple-Token') || '';
    try { await requireSession({ sessionSecret: env.AUTH_SESSION_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY, supabaseUrl: String(env.SUPABASE_URL || '').replace(/\/$/, ''), serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY }, token); }
    catch (e) { return jsonResponse({ error: '未登录或登录已失效' }, 401); }

    // 2. 解析仓库内路径：仅解码一次，按“段”拆分，拒绝任何 . / .. / 反斜杠段，防路径穿越（H1）
    const url = new URL(request.url);
    const decoded = decodeURIComponent(url.pathname.replace(/^\/api\/img\/?/, ''));
    if (!decoded) return jsonResponse({ error: '缺少文件路径' }, 400);
    const segs = decoded.split('/').filter(s => s !== '');
    if (segs.length === 0 || segs.some(s => s === '.' || s === '..' || s.indexOf('\\') >= 0)) {
      return jsonResponse({ error: '非法文件路径' }, 403);
    }
    const rel = '/' + segs.join('/');
    if (!ALLOWED_PREFIXES.some(p => rel.startsWith(p))) {
      return jsonResponse({ error: '该路径不允许访问' }, 403);
    }

    // 3. 边缘缓存：按“仓库内路径”缓存，所有登录用户共享（Range 请求不缓存）
    const rangeHeader = request.headers.get('Range') || '';
    const cache = caches.default;
    const cacheKey = new Request(`https://img-cache.local/${rel}`);
    if (!rangeHeader) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const ch = new Headers(cached.headers);
        ch.delete('Access-Control-Allow-Origin');
        if (aco) ch.set('Access-Control-Allow-Origin', aco);
        return new Response(cached.body, { status: 200, headers: ch });
      }
    }

    // 4. 回源 GitHub 私有仓库（raw 域名：无 /contents 的 1MB 限制，原生支持 Range）
    const owner = String(env.GITHUB_IMG_OWNER || '');
    const repo = String(env.GITHUB_IMG_REPO1 || env.GITHUB_IMG_REPO || '');
    const branch = String(env.GITHUB_IMG_BRANCH || 'main');
    const pat = String(env.GITHUB_IMG_TOKEN || '');
    if (!owner || !repo || !pat) return jsonResponse({ error: '图片服务未配置完整' }, 500);

    const upstreamPath = segs.map(s => encodeURIComponent(s)).join('/');
    const upstream = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${upstreamPath}`;
    const upstreamHeaders = {
      Authorization: `Bearer ${pat}`,
      'User-Agent': 'couple-site-private-img'
    };
    if (rangeHeader) upstreamHeaders['Range'] = rangeHeader;

    const ghResp = await fetch(upstream, { headers: upstreamHeaders });
    if (!ghResp.ok && ghResp.status !== 206) {
      return jsonResponse({ error: '图片获取失败：' + ghResp.status }, ghResp.status === 404 ? 404 : 502);
    }
    const contentType = guessContentType(rel) || ghResp.headers.get('Content-Type') || 'application/octet-stream';
    const outHeaders = {
      'Content-Type': contentType,
      'Cache-Control': `public, max-age=${EDGE_CACHE_TTL}`,
      'Accept-Ranges': 'bytes',
      ...(aco ? { 'Access-Control-Allow-Origin': aco } : {})
    };
    // 透传 Range 相关头（视频拖动播放）
    const contentRange = ghResp.headers.get('Content-Range');
    const contentLength = ghResp.headers.get('Content-Length');
    if (contentRange) outHeaders['Content-Range'] = contentRange;
    if (contentLength) outHeaders['Content-Length'] = contentLength;

    const response = new Response(ghResp.body, { status: ghResp.status, headers: outHeaders });

    // 整文件响应写入边缘缓存（分段 Range 响应不缓存）
    if (!rangeHeader && cache.put) {
      try { await cache.put(cacheKey, response.clone()); } catch (e) {}
    }
    return response;
  } catch (e) {
    return jsonResponse({ error: '图片代理错误：' + ((e && e.message) || String(e)) }, 500);
  }
}

function guessContentType(rel) {
  const lower = String(rel).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
    '.heic': 'image/heic', '.heif': 'image/heif',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2', '.m4v': 'video/x-m4v',
    '.avi': 'video/x-msvideo', '.mpeg': 'video/mpeg'
    // 注意：不映射 .svg（svg 可内嵌脚本），万一误传也会以 octet-stream 下载而非执行
  };
  for (const ext in map) { if (lower.endsWith(ext)) return map[ext]; }
  return 'application/octet-stream';
}

// 仅回显同源 Origin（M3：不再对任意外域回显，避免外域页面跨域读取图片字节）
function echoableOrigin(request, origin) {
  if (!origin) return '';
  try { return new URL(origin).host === new URL(request.url).host ? origin : ''; }
  catch (e) { return ''; }
}

function corsHeaders(aco) {
  const headers = { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Couple-Token', Vary: 'Origin' };
  if (aco) headers['Access-Control-Allow-Origin'] = aco;
  return headers;
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
