// ============================================================
// 登录页背景 /api/login-bg
// - getConfig   ：登录页公开读取（未登录也能拿；带会话时额外返回 canEdit/授权列表）
// - saveConfig  ：管理员或授权用户保存（总开关 authorized_users 仅管理员可改，服务端强制）
// 媒体上传复用 /api/upload-to-github（folder=loginbg，服务端校验管理员/授权用户）
// ============================================================

import {
  getConfig as getBaseConfig, requireSession, checkAdmin,
  checkAllowedOrigin, corsHeaders, jsonResponse
} from '../_lib/session.js';

const VALID_MODES = new Set(['photos', 'video', 'mixed']);
const VALID_ORDERS = new Set(['sequence', 'random']);
const VALID_TEMPLATES = new Set(['t1', 't2', 't3', 't4']);
const MAX_ITEMS = 50;
const MAX_AUTH_USERS = 100;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function supabase(config, path, options) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1${path}`, {
    method: options.method,
    headers: {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=minimal'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw httpError(response.status, (data && (data.message || data.error)) || 'Supabase request failed.');
  return data;
}

async function serverLog(config, action, username, details) {
  try {
    const row = { action, user: username || 'guest', details: JSON.stringify(details || {}), created_at: new Date().toISOString() };
    await fetch(`${config.supabaseUrl}/rest/v1/admin_logs`, {
      method: 'POST',
      headers: { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(row)
    });
  } catch (e) {}
}

async function fetchConfigRow(config) {
  try {
    const rows = await supabase(config, '/login_bg_config?select=*&limit=1', { method: 'GET' });
    return rows && rows[0] ? rows[0] : null;
  } catch (e) {
    if (e && (e.status === 404 || e.status === 400 || e.status === 428)) {
      throw httpError(501, '登录页背景表未初始化：请在 Supabase SQL Editor 执行「登录页背景_建表SQL.sql」后刷新重试。');
    }
    throw e;
  }
}

async function fetchMedia(config) {
  try {
    const rows = await supabase(config, '/login_bg_media?select=id,kind,url,dynamic,sort_order&order=sort_order.asc,id.asc&limit=200', { method: 'GET' });
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    if (e && (e.status === 404 || e.status === 400 || e.status === 428)) {
      throw httpError(501, '登录页背景表未初始化：请在 Supabase SQL Editor 执行「登录页背景_建表SQL.sql」后刷新重试。');
    }
    throw e;
  }
}

async function authorizedUsernames(config) {
  const row = await fetchConfigRow(config);
  return Array.isArray(row && row.authorized_users) ? row.authorized_users : [];
}

// 私有仓库媒体 URL 归一化：jsdelivr/raw 直链（私有仓必 404）→ 站内代理 /api/img/*（免登录、支持视频 Range）
function normalizeMediaUrl(u) {
  if (!u) return u;
  const s = String(u).trim();
  let m = s.match(/^https:\/\/cdn\.jsdelivr\.net\/gh\/[^/]+\/[^/]+@[^/]+\/(.+)$/);
  if (m) return '/api/img/' + m[1];
  m = s.match(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/(?:main|master)\/(.+)$/);
  if (m) return '/api/img/' + m[1];
  return s;
}

function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  for (const it of items.slice(0, MAX_ITEMS)) {
    if (!it || !it.url || typeof it.url !== 'string') continue;
    const url = normalizeMediaUrl(String(it.url).trim());
    if (!url || (url.indexOf('/api/img/') !== 0 && !/^https:\/\//.test(url))) continue;
    const kind = it.kind === 'video' ? 'video' : 'photo';
    const key = url + '|' + kind;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind,
      url,
      dynamic: kind === 'photo' ? !!it.dynamic : false,
      sort_order: Number.isFinite(Number(it.sort_order)) ? Number(it.sort_order) : 0
    });
  }
  return out;
}

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const originCheck = checkAllowedOrigin(origin, env.ACCOUNT_ALLOWED_ORIGINS);
  const headers = corsHeaders(originCheck.corsOrigin, { methods: 'POST, OPTIONS' });

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (!originCheck.allowed) return jsonResponse({ error: '来源不被允许。' }, 403, headers);
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, headers);

  const config = getBaseConfig(env);
  if (!config.ok) return jsonResponse({ error: config.error }, 500, headers);

  let body = null;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: '请求体不是合法 JSON。' }, 400, headers); }
  const action = String(body.action || '');

  try {
    if (action === 'trace') {
      // 环境取证：登录页加载时上报 UA/屏幕/入口/事件，落 admin_logs 供排查三平台差异（不涉及敏感信息）
      const td = (body && body.data) || {};
      await serverLog(config, '登录页背景-环境上报', 'guest', {
        ev: String(td.ev || '').slice(0, 40),
        ua: String(td.ua || '').slice(0, 400),
        platform: String(td.platform || '').slice(0, 100),
        screen: String(td.screen || '').slice(0, 60),
        href: String(td.href || '').slice(0, 200),
        v: String(td.v || '').slice(0, 30),
        extra: JSON.stringify(td).slice(0, 500)
      });
      return jsonResponse({ ok: true }, 200, headers);
    }
    if (action === 'getConfig') {
      // 会话可选：带会话时判断是否可编辑
      let session = null;
      const token = body.sessionToken || '';
      if (token) {
        try { session = await requireSession(config, token); } catch (e) { session = null; }
      }
      const row = await fetchConfigRow(config);
      const items = await fetchMedia(config);
      const out = {
        enabled: !!row.enabled,
        mode: row.mode || 'photos',
        order_mode: row.order_mode || 'sequence',
        template: row.template || 't1',
        music_enabled: !!row.music_enabled,
        video_sound: !!row.video_sound,
        music_url: row.music_url || null,
        music_name: row.music_name || null,
        photo_duration: row.photo_duration != null ? Number(row.photo_duration) : 6,
        static_url: row.static_url || null,
        loop_count: row.loop_count != null ? Number(row.loop_count) : 0,
        items: items.map(it => ({ id: it.id, kind: it.kind, url: normalizeMediaUrl(it.url), dynamic: !!it.dynamic, sort_order: Number(it.sort_order || 0) }))
      };
      if (session) {
        const username = session.username;
        const isAdmin = await checkAdmin(config, username);
        const authUsers = await authorizedUsernames(config).catch(() => []);
        out.canEdit = isAdmin || authUsers.indexOf(username) !== -1;
        if (out.canEdit) {
          out.isAdmin = isAdmin;
          out.authorized_users = authUsers;
        }
      }
      return jsonResponse(out, 200, headers);
    }

    if (action === 'saveConfig') {
      const token = body.sessionToken || '';
      let session;
      try { session = await requireSession(config, token); }
      catch (e) { return jsonResponse({ error: '登录已失效，请重新登录。' }, 401, headers); }
      const username = session.username;
      const isAdmin = await checkAdmin(config, username);
      const authUsers = await authorizedUsernames(config);
      if (!isAdmin && authUsers.indexOf(username) === -1) {
        return jsonResponse({ error: '无权限：仅管理员或被授权的用户可设置登录页背景。' }, 403, headers);
      }

      const row = await fetchConfigRow(config);
      const curEnabled = !!row.enabled;
      const curAuth = Array.isArray(row.authorized_users) ? row.authorized_users : [];

      // 校验
      const mode = VALID_MODES.has(body.mode) ? body.mode : 'photos';
      const order_mode = VALID_ORDERS.has(body.order_mode) ? body.order_mode : 'sequence';
      const template = VALID_TEMPLATES.has(body.template) ? body.template : 't1';
      let music_url = body.music_url ? String(body.music_url).trim() : null;
      // 允许站内代理路径（/api/music?action=resolve&rid=... 酷我完整版 / /api/music/play?id=... 网易云）或 https 直链
      if (music_url && !/^(https:\/\/|\/api\/music(\?action=(resolve&rid=MUSIC_\d+|play&id=\d+)|play\?id=\d+))/.test(music_url)) music_url = null;
      let music_name = body.music_name ? String(body.music_name).trim().slice(0, 120) : null;
      let photo_duration = Number(body.photo_duration);
      if (!Number.isFinite(photo_duration)) photo_duration = 6;
      photo_duration = Math.min(20, Math.max(3, photo_duration));

      // 权限边界（服务端强制，不信任前端）
      let enabled = curEnabled;
      if (body.enabled !== undefined && typeof body.enabled === 'boolean') {
        if (!isAdmin) return jsonResponse({ error: '无权限：总开关仅管理员可以设置。' }, 403, headers);
        enabled = body.enabled;
      }
      let authorized = curAuth;
      if (body.authorized_users !== undefined) {
        if (!isAdmin) return jsonResponse({ error: '无权限：授权用户列表仅管理员可以设置。' }, 403, headers);
        if (!Array.isArray(body.authorized_users)) return jsonResponse({ error: 'authorized_users 必须是数组。' }, 400, headers);
        authorized = body.authorized_users
          .map(u => String(u).trim()).filter(Boolean)
          .filter(u => /^[A-Za-z0-9_\u4e00-\u9fa5]{1,40}$/.test(u))
          .slice(0, MAX_AUTH_USERS);
      }

      const items = sanitizeItems(body.items);
      const music_enabled = !!body.music_enabled && !!music_url;
      const video_sound = !!body.video_sound;

      // 新列（static_url 定格帧 / loop_count 循环次数）容错：列不存在时忽略，仅保存旧字段
      let extra = {};
      try {
        await supabase(config, '/login_bg_config?select=static_url,loop_count&limit=0', { method: 'GET' });
        extra.static_url = body.static_url && /^(https:\/\/|\/api\/img\/)/.test(String(body.static_url).trim()) ? String(body.static_url).trim() : null;
        const lc = parseInt(body.loop_count, 10);
        extra.loop_count = Number.isFinite(lc) ? Math.min(9, Math.max(0, lc)) : 0;
      } catch (e) { /* 列尚未添加：跳过 */ }

      // 保存配置（幂等 upsert id=1）
      await supabase(config, '/login_bg_config', {
        method: 'POST',
        body: {
          id: 1, enabled, mode, order_mode, template,
          music_enabled, video_sound, music_url, music_name, photo_duration,
          authorized_users: authorized, updated_by: username, updated_at: new Date().toISOString(),
          ...extra
        },
        prefer: 'resolution=merge-duplicates'
      });

      // 媒体全量替换（确认保存语义）
      await supabase(config, '/login_bg_media?id=neq.0', { method: 'DELETE' });
      for (const it of items) {
        await supabase(config, '/login_bg_media', {
          method: 'POST',
          body: { kind: it.kind, url: it.url, dynamic: it.dynamic, sort_order: it.sort_order }
        });
      }

      await serverLog(config, '登录页背景更新', username, { mode, template, items: items.length, enabled, authorized: authorized.length });
      return jsonResponse({ ok: true, saved: { enabled, mode, template, items: items.length } }, 200, headers);
    }

    return jsonResponse({ error: 'Unknown login-bg action.' }, 400, headers);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Login-bg request failed.' }, error.status || 500, headers);
  }
}
