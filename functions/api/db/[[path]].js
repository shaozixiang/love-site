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

// 带软删除字段（回收站）的表，共 9 张：本代理读取时一律只返回未删除记录，
// 已删除内容只能由管理员通过独立 /api/trash 接口查看
const SOFT_DELETE_TABLES = new Set([
  'feeds', 'messages', 'loves', 'memories', 'memos',
  'schedules', 'countdowns', 'travel_markers', 'apologies'
]);
// 带 visibility 字段的内容表（8 张；apologies 无该字段）：普通用户强制只见公开
const VISIBILITY_TABLES = new Set([
  'feeds', 'messages', 'loves', 'memories', 'memos',
  'schedules', 'countdowns', 'travel_markers'
]);
// 情侣账号（硬编码，与前端一致）：可看 couple_only
const COUPLE_USERNAMES = new Set(['boy', 'girl']);
// users 表中绝不能通过数据代理下发的敏感列
const SENSITIVE_USER_COLS = ['password_hash', 'password_salt', 'password'];

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

    const method = request.method;
    const body = (method === 'GET' || method === 'HEAD') ? undefined : await request.text();

    // 角色只判定一次（管理员/情侣账号）
    const isAdmin = await checkAdmin(config, session.username);
    const isCouple = COUPLE_USERNAMES.has(session.username);

    // 读操作：操作日志仅管理员可查看（M1/S2）
    if ((method === 'GET' || method === 'HEAD') && table === 'admin_logs') {
      if (!isAdmin) {
        return jsonResponse({ error: '操作日志仅管理员可查看' }, 403);
      }
    }

    // 2.5 写操作权限校验：只能删/改自己的内容（admin 例外），评论点赞交互放行
    try { await enforceWritePolicy(config, session, method, table, url.search, body); }
    catch (e) { return jsonResponse({ error: e.message || '无权操作' }, 403); }

    // 3. 用 service role 转发到真实 Supabase（service role 绕过 RLS）
    // 读取请求在服务端强制注入行级条件（S2）：无论前端 select 哪些列、带什么参数，
    // 软删除/可见性/私密规则都在数据库层生效，无法靠精简 select 绕过
    const safeSearch = buildSafeSearch(url, table, method, session.username, isAdmin, isCouple);
    const upstream = `${config.supabaseUrl}/rest/v1/${table}${safeSearch}`;
    const headers = {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      'Content-Type': 'application/json'
    };
    const prefer = request.headers.get('Prefer');
    if (prefer) headers['Prefer'] = prefer;
    const range = request.headers.get('Range');
    if (range) headers['Range'] = range;

    const resp = await fetch(upstream, { method, headers, body });
    let respText = await resp.text();
    // 出口过滤/裁剪作为纵深防御（S2）：正常情况下入口已保证数据安全
    if (method === 'GET' || method === 'HEAD') {
      respText = await applyReadFilter(config, session.username, table, respText, resp.status, isAdmin, isCouple);
    }
    // 写操作成功后由服务端记录操作日志（带真实 IP/UA，M1 防伪造；日志表自身除外）
    if (resp.ok && method !== 'GET' && method !== 'HEAD' && table !== 'admin_logs') {
      try {
        const idMatch = String(url.search).match(/id=eq\.([^&]+)/);
        const row = {
          action: describeDbAction(method, table, body),
          user: session.username || 'guest',
          details: JSON.stringify({
            table, method,
            target: idMatch ? decodeURIComponent(idMatch[1]) : '',
            query: String(url.search).substring(0, 200),
            ip: request.headers.get('CF-Connecting-IP') || request.headers.get('x-real-ip') || '',
            user_agent: (request.headers.get('user-agent') || '').substring(0, 120)
          }),
          created_at: new Date().toISOString()
        };
        context.waitUntil(fetch(`${config.supabaseUrl}/rest/v1/admin_logs`, { method: 'POST', headers: authHeaders(config), body: JSON.stringify(row) }));
      } catch (e) {}
    }
    return new Response(respText, { status: resp.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  } catch (e) {
    return jsonResponse({ error: '数据库代理错误：' + ((e && e.message) || String(e)) }, 500);
  }
}

// 含 author 归属字段的业务表：写操作须校验归属
const OWNER_TABLES = new Set([
  'feeds', 'messages', 'loves', 'memories', 'memos', 'schedules', 'countdowns',
  'travel_markers', 'angry_mode', 'apologies'
]);
// 系统/共享表：POST 放行（登录即可），PATCH 放行，DELETE 仅管理员
const SHARED_TABLES = new Set([
  'bubble_config', 'bubble_photos', 'admin_logs', 'site_config', 'users', 'logs'
]);

async function enforceWritePolicy(config, session, method, table, search, bodyText) {
  if (method === 'GET' || method === 'HEAD') return;

  // users 表：任何写操作一律拒绝（S1 提权）。账号创建/改密/改角色只能走 /api/account 专用接口
  if (table === 'users') {
    throw new Error('用户表不能通过数据接口写入，账号管理请使用 /api/account');
  }

  // admin_logs 表：仅允许管理员清空（DELETE），其余写入/修改一律拒绝（M1 日志伪造）
  if (table === 'admin_logs') {
    if (method === 'DELETE') {
      if (!(await checkAdmin(config, session.username))) throw new Error('仅管理员可清空操作日志');
      return;
    }
    throw new Error('操作日志不允许写入或修改');
  }

  // POST：归属表必须用当前用户身份发布，防止冒充他人
  if (method === 'POST') {
    if (OWNER_TABLES.has(table)) {
      let payload = {};
      try { payload = JSON.parse(bodyText || '{}'); } catch (e) { throw new Error('请求体无效'); }
      const author = String(payload.author || '');
      if (!author) throw new Error('缺少发布者');
      if (author !== session.username) throw new Error('无权以他人身份发布');
    }
    return;
  }
  // PATCH / DELETE
  const isAdmin = await checkAdmin(config, session.username);
  if (isAdmin) return;
  const idMatch = String(search || '').match(/id=eq\.([^&]+)/);
  if (!idMatch) throw new Error('缺少记录 ID');
  const id = decodeURIComponent(idMatch[1]);
  const cols = OWNER_TABLES.has(table) ? 'author' : 'id';
  const qUrl = `${config.supabaseUrl}/rest/v1/${table}?select=${cols}&id=eq.${encodeURIComponent(id)}&limit=1`;
  const qResp = await fetch(qUrl, { headers: authHeaders(config) });
  const qRows = await qResp.json().catch(() => null);
  if (!Array.isArray(qRows) || qRows.length === 0) throw new Error('记录不存在');
  // 评论/点赞交互：对他人内容更新 comments / likes 数组放行
  if (method === 'PATCH' && (table === 'feeds' || table === 'messages')) {
    let payload = {};
    try { payload = JSON.parse(bodyText || '{}'); } catch (e) { throw new Error('请求体无效'); }
    const keys = Object.keys(payload);
    if (keys.length && keys.every(k => k === 'comments' || k === 'likes')) return;
  }
  if (OWNER_TABLES.has(table)) {
    if (qRows[0].author === session.username) return;
    throw new Error('只能操作自己发布的内容');
  }
  throw new Error('无权操作该数据');
}

async function checkAdmin(config, username) {
  const qUrl = `${config.supabaseUrl}/rest/v1/users?select=role&username=eq.${encodeURIComponent(username)}&limit=1`;
  const qResp = await fetch(qUrl, { headers: authHeaders(config) });
  const qRows = await qResp.json().catch(() => null);
  return Array.isArray(qRows) && qRows.length > 0 && (qRows[0].role === 'admin' || String(username).toLowerCase() === 'admin');
}

// 读取结果按角色过滤（S2，出口纵深防御，正常情况下入口 buildSafeSearch 已保证）：
// - users：剥掉密码哈希/盐/遗留明文列；非管理员只能看到自己那一行
// - 软删除表：所有角色都看不到已进回收站的记录
// - 可见性表：非管理员且非情侣账号看不到 couple_only
// - loves：private 仅作者本人和管理员可见
async function applyReadFilter(config, username, table, text, status, isAdmin, isCouple) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return text; }
  if (!status || status < 200 || status >= 300) return text;

  const scrubUser = (row) => {
    if (row && typeof row === 'object') {
      SENSITIVE_USER_COLS.forEach(c => { try { delete row[c]; } catch (e) {} });
    }
    return row;
  };

  if (table === 'users') {
    if (Array.isArray(data)) {
      data = data.filter(r => isAdmin || (r && r.username === username)).map(scrubUser);
    } else if (data && typeof data === 'object') {
      scrubUser(data);
      if (!isAdmin && data.username !== username) data = null;
    }
    return JSON.stringify(data);
  }

  if (SOFT_DELETE_TABLES.has(table) && Array.isArray(data)) {
    data = data.filter(r => {
      if (!r || typeof r !== 'object') return true;
      // 行中带 deleted_at 字段且非空（已进回收站）→ 隐藏
      if (r.deleted_at !== null && r.deleted_at !== undefined && r.deleted_at !== '') return false;
      // 情侣私密内容仅管理员和情侣账号可见
      if (VISIBILITY_TABLES.has(table) && r.visibility === 'couple_only' && !isAdmin && !isCouple) return false;
      // 感动的话：private 仅作者本人和管理员可见
      if (table === 'loves' && r.privacy === 'private' && !isAdmin && r.author !== username) return false;
      return true;
    });
    return JSON.stringify(data);
  }

  return text;
}

// 服务端在转发前强制注入行级过滤条件（S2 的核心防线）
// 与前端传入的 select 列、where 条件完全无关：数据库层先过滤，再返回结果
function buildSafeSearch(url, table, method, username, isAdmin, isCouple) {
  if (method !== 'GET' && method !== 'HEAD') return url.search;
  const params = new URLSearchParams(url.search);
  const andParts = [];
  const safeName = /^[A-Za-z0-9_-]{1,32}$/.test(String(username)) ? username : '';

  // 1) 软删除表：强制只返回未删除记录（回收站走独立 /api/trash）
  if (SOFT_DELETE_TABLES.has(table)) {
    params.delete('deleted_at');
    params.append('deleted_at', 'is.null');
  }

  // 2) 可见性表：普通用户（非管理员、非情侣账号）强制只见公开（null 或 public）
  if (VISIBILITY_TABLES.has(table) && !isAdmin && !isCouple) {
    params.delete('visibility'); // 忽略任何客户端传入的 visibility 探测
    andParts.push('or(visibility.is.null,visibility.eq.public)');
  }

  // 3) 感动的话：private 仅作者本人与管理员可见
  if (table === 'loves' && !isAdmin && safeName) {
    andParts.push('or(privacy.is.null,privacy.neq.private,author.eq.' + safeName + ')');
  }

  // 4) users 表：非管理员只能看到自己那一行
  if (table === 'users' && !isAdmin && safeName) {
    params.delete('username');
    params.append('username', 'eq.' + safeName);
  }

  // 保留客户端已有 and 条件（与服务端条件为 AND，无法绕过；前端目前未使用）
  // 注意 supabase-js 生成的 and 值自带外层括号，需剥掉后再合并
  params.getAll('and').forEach(v => {
    if (!v) return;
    let inner = String(v).trim();
    if (inner.startsWith('(') && inner.endsWith(')')) inner = inner.slice(1, -1).trim();
    if (inner) andParts.push(inner);
  });
  params.delete('and');
  if (andParts.length) params.append('and', '(' + andParts.join(',') + ')');

  const s = params.toString();
  return s ? '?' + s : '';
}

function authHeaders(config) {
  return { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}`, 'Content-Type': 'application/json' };
}

// 把数据库写操作翻译成人类可读的日志动作名
const TABLE_CN = {
  feeds: '相册', messages: '留言', loves: '心动', memories: '回忆', memos: '待办',
  schedules: '日程', countdowns: '倒计时', travel_markers: '足迹', angry_mode: '生气',
  apologies: '道歉', bubble_photos: '气泡照片', bubble_config: '气泡设置', site_config: '站点设置', users: '账号'
};
function describeDbAction(method, table, bodyText) {
  const cn = TABLE_CN[table] || table;
  let payload = {};
  try { payload = JSON.parse(bodyText || '{}'); } catch (e) {}
  if (method === 'POST') {
    if (table === 'bubble_photos') return '上传气泡照片';
    if (table === 'bubble_config') return '修改气泡设置';
    if (table === 'site_config') return '修改站点设置';
    if (table === 'users') return '新增账号';
    return '发布' + cn;
  }
  if (method === 'DELETE') return '彻底删除' + cn;
  if (method === 'PATCH') {
    if (payload.deleted_at !== undefined) return payload.deleted_at === null ? ('恢复' + cn + '（回收站）') : ('移入回收站·' + cn);
    if (payload.visibility !== undefined) return '调整' + cn + '可见性';
    if (payload.likes !== undefined) return '点赞' + cn;
    if (payload.comments !== undefined) return '评论' + cn;
    if (table === 'bubble_config') return '修改气泡设置';
    if (table === 'site_config') return '修改站点设置';
    if (table === 'users') return '编辑账号';
    return '编辑' + cn;
  }
  return cn + '操作';
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
