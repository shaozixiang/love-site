// ============================================================
// 共享会话/鉴权/CORS 工具（Pages Functions 各入口统一引用）
// - requireSession：HMAC 验签 + 过期校验 + users 表存活校验（防幽灵令牌）
// - checkAdmin：管理员判定
// - checkAllowedOrigin：Origin 白名单（空 Origin = 同源请求一律放行）
// - 各入口保持原有行为：验签失败/账号已删 → 抛出 Error('登录已失效')，
//   由调用方翻译成 401 JSON。
// ============================================================

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

// ---------- 配置 ----------
export function getConfig(env) {
  const supabaseUrl = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const sessionSecret = env.AUTH_SESSION_SECRET || serviceKey;
  if (!supabaseUrl) return { ok: false, error: 'SUPABASE_URL is not configured.' };
  if (!serviceKey) return { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' };
  if (!sessionSecret) return { ok: false, error: 'AUTH_SESSION_SECRET is not configured.' };
  return { ok: true, supabaseUrl, serviceKey, sessionSecret };
}

export function authHeaders(config) {
  return {
    apikey: config.serviceKey,
    Authorization: `Bearer ${config.serviceKey}`,
    'Content-Type': 'application/json'
  };
}

// ---------- 底层算法 ----------
export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return arrayBufferToHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

export function arrayBufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer), value => value.toString(16).padStart(2, '0')).join('');
}

export function base64UrlEncode(value) {
  return btoa(unescape(encodeURIComponent(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  return decodeURIComponent(escape(atob(padded)));
}

export function constantTimeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomHex(bytes) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, value => value.toString(16).padStart(2, '0')).join('');
}

// ---------- 会话 ----------
export async function signSession(config, username) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { u: username, iat: now, exp: now + SESSION_TTL_SECONDS, n: randomHex(8) };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${await hmacHex(config.sessionSecret, encoded)}`;
}

// 账号是否仍存在（防幽灵令牌：删号后旧 token 立即失效）
export async function isUserAlive(config, username) {
  try {
    const resp = await fetch(`${config.supabaseUrl}/rest/v1/users?select=username&username=eq.${encodeURIComponent(username)}&limit=1`, { headers: authHeaders(config) });
    const rows = await resp.json().catch(() => null);
    return Array.isArray(rows) && rows.length > 0 && rows[0].username === username;
  } catch (e) { return false; }
}

// 验签 + 过期 + 存活；失败抛 Error('登录已失效')
export async function requireSession(config, token) {
  const value = String(token || '');
  const parts = value.split('.');
  if (parts.length !== 2) throw new Error('登录已失效');
  const expected = await hmacHex(config.sessionSecret, parts[0]);
  if (!constantTimeEqual(expected, parts[1])) throw new Error('登录已失效');
  let payload;
  try { payload = JSON.parse(base64UrlDecode(parts[0])); } catch (_) { throw new Error('登录已失效'); }
  if (!payload.u || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('登录已失效');
  if (!await isUserAlive(config, payload.u)) throw new Error('登录已失效');
  return { username: payload.u };
}

// ---------- 角色 ----------
export async function checkAdmin(config, username) {
  try {
    const resp = await fetch(`${config.supabaseUrl}/rest/v1/users?select=role&username=eq.${encodeURIComponent(username)}&limit=1`, { headers: authHeaders(config) });
    const rows = await resp.json().catch(() => null);
    return Array.isArray(rows) && rows.length > 0 && (rows[0].role === 'admin' || String(username).toLowerCase() === 'admin');
  } catch (e) { return false; }
}

// ---------- Cookie ----------
export function readCookie(cookieHeader, name) {
  for (const part of String(cookieHeader || '').split(';')) {
    const pair = part.trim().split('=');
    if (pair[0] === name) return decodeURIComponent(pair.slice(1).join('='));
  }
  return '';
}

// ---------- CORS / Origin 白名单（与 account.js 语义一致） ----------
// - 未配置白名单：放行全部（corsOrigin='*'），保持旧行为
// - Origin 为空（同源请求）：放行，corsOrigin 取白名单第一项
// - 配置了白名单：仅白名单内 Origin 放行；恶意 Origin → allowed=false（不回显）
export function checkAllowedOrigin(origin, allowedOriginsConfig) {
  const allowedOrigins = String(allowedOriginsConfig || '').split(',').map(item => item.trim()).filter(Boolean);
  if (allowedOrigins.length === 0) return { allowed: true, corsOrigin: '*' };
  if (!origin) return { allowed: true, corsOrigin: allowedOrigins[0] };
  const allowed = allowedOrigins.includes(origin);
  return { allowed, corsOrigin: allowed ? origin : '' };
}

export function corsHeaders(corsOrigin, opts = {}) {
  const headers = {
    'Access-Control-Allow-Methods': opts.methods || 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': opts.headers || 'Content-Type, X-Couple-Token',
    Vary: 'Origin'
  };
  if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin;
  return headers;
}

export function jsonResponse(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...(headers || {}), 'Content-Type': 'application/json; charset=utf-8' }
  });
}
