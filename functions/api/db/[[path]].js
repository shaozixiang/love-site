// ============================================================
// 数据库安全代理 /api/db/*
// 前端所有 Supabase REST 请求都经此中转：先校验登录会话，
// 再用 service role 密钥直连真实数据库（绕过 RLS）。
// 未登录 / 无有效会话 → 一律拒绝，封死“匿名裸读数据库”漏洞。
// 配合“所有表启用 RLS 且不开放匿名策略”，即使拿到公开 anon key 也读不到任何数据。
// ============================================================

const ALLOWED_TABLES = new Set([
  'feeds', 'messages', 'loves', 'memories', 'memos', 'schedules', 'countdowns',
  'travel_markers', 'users', 'bubble_config', 'bubble_photos', 'angry_mode',
  'apologies', 'admin_logs', 'site_config'
]);

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  try {
    const config = getConfig(env);
    if (!config.ok) return jsonResponse({ error: config.error }, 500);

    // 1. 会话校验：没有有效登录会话，一律拒绝
    const token = request.headers.get('X-Couple-Token') || '';
    let session;
    try { session = await requireSession(config, token); }
    catch (e) { return jsonResponse({ error: '未登录或登录已失效，请重新登录' }, 401); }

    // 2. 表白名单
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/db\/rest\/v1\/([^/?]+)/);
    if (!match) return jsonResponse({ error: '请求路径无效' }, 400);
    const table = match[1];
    if (!ALLOWED_TABLES.has(table)) return jsonResponse({ error: '该数据表不允许直接访问' }, 403);

    // 3. 用 service role 转发到真实 Supabase（service role 绕过 RLS）
    const upstream = `${config.supabaseUrl}/rest/v1/${table}${url.search}`;
    const headers = {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      'Content-Type': 'application/json'
    };
    const prefer = request.headers.get('Prefer');
    if (prefer) headers['Prefer'] = prefer;
    const method = request.method;
    const body = (method === 'GET' || method === 'HEAD') ? undefined : await request.text();

    const resp = await fetch(upstream, { method, headers, body });
    return new Response(await resp.text(), { status: resp.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  } catch (e) {
    return jsonResponse({ error: '数据库代理错误：' + ((e && e.message) || String(e)) }, 500);
  }
}

// ---------- 以下为会话校验与辅助函数（与 /api/account 同一套实现） ----------

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
  const supabaseUrl = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const sessionSecret = env.AUTH_SESSION_SECRET || serviceKey;
  if (!supabaseUrl) return { ok: false, error: 'SUPABASE_URL is not configured.' };
  if (!serviceKey) return { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' };
  if (!sessionSecret) return { ok: false, error: 'AUTH_SESSION_SECRET is not configured.' };
  return { ok: true, supabaseUrl, serviceKey, sessionSecret };
}

function corsHeaders(origin) {
  const headers = { 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Prefer, X-Couple-Token', Vary: 'Origin' };
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
