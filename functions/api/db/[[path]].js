// ============================================================
// 数据库安全代理 /api/db/*
// 前端所有 Supabase REST 请求都经此中转：先校验登录会话，
// 再用 service role 密钥直连真实数据库（绕过 RLS）。
// 未登录 / 无有效会话 → 一律拒绝，封死“匿名裸读数据库”漏洞。
// 配合“所有表启用 RLS 且不开放匿名策略”，即使拿到公开 anon key 也读不到任何数据。
//
// 写策略（显式白名单，P0 修复）：
// - users 表：一律拒绝（账号管理只走 /api/account）
// - admin_logs：仅管理员 DELETE；其余拒绝
// - site_config / bubble_config / logs：一律要求管理员
// - bubble_photos：登录用户内容表，按 author 本人校验（与 feeds 同级）
// - 归属表（feeds/messages/...）POST 必须 author===本人；PATCH/DELETE 仅本人或管理员
// - feeds/messages 的 likes/comments：服务端 read-modify-write，只允许本人增删
// ============================================================

import {
  getConfig, requireSession, checkAdmin,
  checkAllowedOrigin, corsHeaders, jsonResponse, authHeaders
} from '../../_lib/session.js';

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

// 含 author 归属字段的业务表：写操作须校验归属
const OWNER_TABLES = new Set([
  'feeds', 'messages', 'loves', 'memories', 'memos', 'schedules', 'countdowns',
  'travel_markers', 'angry_mode', 'apologies', 'bubble_photos'
]);
// 系统/共享表：POST/PATCH/DELETE 一律要求管理员（P0-01）
// bubble_photos 是情侣双方内容（带 author 列），走 OWNER 本人校验
const ADMIN_ONLY_TABLES = new Set(['site_config', 'bubble_config', 'logs']);

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const originCheck = checkAllowedOrigin(origin, env.ACCOUNT_ALLOWED_ORIGINS || env.UPLOAD_ALLOWED_ORIGINS);
  if (request.method === 'OPTIONS') {
    if (!originCheck.allowed) return jsonResponse({ error: 'Origin is not allowed.' }, 403);
    return new Response(null, {
      status: 204,
      headers: corsHeaders(originCheck.corsOrigin, {
        methods: 'GET, POST, PATCH, DELETE, OPTIONS',
        headers: 'Content-Type, Prefer, X-Couple-Token'
      })
    });
  }
  try {
    const config = getConfig(env);
    if (!config.ok) return jsonResponse({ error: config.error }, 500);

    // 1. 会话校验：没有有效登录会话（含账号已删除），一律拒绝
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
    let body = (method === 'GET' || method === 'HEAD') ? undefined : await request.text();

    // 角色只判定一次（管理员/情侣账号）
    const isAdmin = await checkAdmin(config, session.username);
    const isCouple = COUPLE_USERNAMES.has(session.username);

    // 读操作：操作日志仅管理员可查看（M1/S2）
    if ((method === 'GET' || method === 'HEAD') && table === 'admin_logs') {
      if (!isAdmin) {
        return jsonResponse({ error: '操作日志仅管理员可查看' }, 403);
      }
    }

    // 2.5 写操作权限校验：只能删/改自己的内容（admin 例外），评论点赞交互走服务端原子化
    try {
      const writeResult = await enforceWritePolicy(config, session, method, table, url.search, body);
      if (writeResult && writeResult.replacementBody !== undefined) body = JSON.stringify(writeResult.replacementBody);
    } catch (e) { return jsonResponse({ error: e.message || '无权操作' }, 403); }

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

// 返回 null 表示原样转发；返回 {replacementBody} 表示用服务端重写后的请求体转发
async function enforceWritePolicy(config, session, method, table, search, bodyText) {
  if (method === 'GET' || method === 'HEAD') return null;

  // users 表：任何写操作一律拒绝（S1 提权）。账号创建/改密/改角色只能走 /api/account 专用接口
  if (table === 'users') {
    throw new Error('用户表不能通过数据接口写入，账号管理请使用 /api/account');
  }

  // admin_logs 表：仅允许管理员清空（DELETE），其余写入/修改一律拒绝（M1 日志伪造）
  if (table === 'admin_logs') {
    if (method === 'DELETE') {
      if (!(await checkAdmin(config, session.username))) throw new Error('仅管理员可清空操作日志');
      return null;
    }
    throw new Error('操作日志不允许写入或修改');
  }

  // site_config / bubble_config / logs：一律要求管理员（P0-01）
  if (ADMIN_ONLY_TABLES.has(table)) {
    if (!(await checkAdmin(config, session.username))) throw new Error('该表不允许普通用户写入');
    return null;
  }

  const isAdmin = await checkAdmin(config, session.username);

  // POST：归属表必须用当前用户身份发布，防止冒充他人
  if (method === 'POST') {
    if (!OWNER_TABLES.has(table)) throw new Error('无权写入该数据表');
    let payload = {};
    try { payload = JSON.parse(bodyText || '{}'); } catch (e) { throw new Error('请求体无效'); }
    const author = String(payload.author || '');
    if (!author) throw new Error('缺少发布者');
    if (author !== session.username) throw new Error('无权以他人身份发布');
    return null;
  }

  // PATCH / DELETE：管理员放行
  if (isAdmin) return null;

  const idMatch = String(search || '').match(/id=eq\.([^&]+)/);
  if (!idMatch) throw new Error('缺少记录 ID');

  // 评论/点赞交互（P0-02/P1-04）：服务端 read-modify-write，只允许本人增删，
  // 校验通过后以库内数组为基准应用该增/删再发给 PostgREST（顺带修并发丢赞）
  if (method === 'PATCH' && (table === 'feeds' || table === 'messages')) {
    let payload = {};
    try { payload = JSON.parse(bodyText || '{}'); } catch (e) { throw new Error('请求体无效'); }
    const keys = Object.keys(payload);
    if (keys.length && keys.every(k => k === 'comments' || k === 'likes')) {
      return await sanitizeInteractionPatch(config, session, table, idMatch[1], payload);
    }
  }

  // 其余 PATCH/DELETE：归属表仅本人
  const qUrl = `${config.supabaseUrl}/rest/v1/${table}?select=author&id=eq.${encodeURIComponent(decodeURIComponent(idMatch[1]))}&limit=1`;
  const qResp = await fetch(qUrl, { headers: authHeaders(config) });
  const qRows = await qResp.json().catch(() => null);
  if (!Array.isArray(qRows) || qRows.length === 0) throw new Error('记录不存在');
  if (qRows[0].author === session.username) return null;
  throw new Error('只能操作自己发布的内容');
}

// 点赞/评论原子化重写：以库内当前数组为基准，只允许会话本人的项发生变化
async function sanitizeInteractionPatch(config, session, table, idRaw, payload) {
  const id = decodeURIComponent(idRaw);
  const me = session.username;
  const rowResp = await fetch(
    `${config.supabaseUrl}/rest/v1/${table}?select=likes,comments&id=eq.${encodeURIComponent(id)}&limit=1`,
    { headers: authHeaders(config) }
  );
  const rows = await rowResp.json().catch(() => null);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('记录不存在');
  const dbLikes = Array.isArray(rows[0].likes) ? rows[0].likes : [];
  const dbComments = Array.isArray(rows[0].comments) ? rows[0].comments : [];
  const out = {};

  if (payload.likes !== undefined) {
    const clientLikes = payload.likes;
    if (!Array.isArray(clientLikes)) throw new Error('点赞数据格式不正确');
    if (new Set(clientLikes).size !== clientLikes.length) throw new Error('点赞数据格式不正确');
    // 客户端相对库内数组的差异：只能是“增/删本人一项”
    const added = clientLikes.filter(x => !dbLikes.includes(x));
    const removed = dbLikes.filter(x => !clientLikes.includes(x));
    if (added.length > 1 || removed.length > 1) throw new Error('只能增删自己的点赞');
    if (added.some(x => x !== me) || removed.some(x => x !== me)) throw new Error('只能增删自己的点赞');
    if (added.length === 0 && removed.length === 0) {
      out.likes = dbLikes; // 无变化：原样写回库内数组
    } else {
      // 以库内数组为基准应用该增/删（其他人的项原样保留）
      out.likes = dbLikes.filter(x => x !== me);
      if (added.length) out.likes.push(me);
    }
  }

  if (payload.comments !== undefined) {
    const clientComments = payload.comments;
    if (!Array.isArray(clientComments)) throw new Error('评论数据格式不正确');
    const norm = (c) => JSON.stringify(c && typeof c === 'object' ? c : {}, Object.keys(c || {}).sort());
    const dbNorms = dbComments.map(norm);
    // 逐个配对：client 中在库内找不到的元素 = 新增；库内未被匹配的元素 = 删除
    const dbUsed = new Array(dbComments.length).fill(false);
    const addedClient = [];
    for (const c of clientComments) {
      const idx = dbNorms.findIndex((n, i) => !dbUsed[i] && n === norm(c));
      if (idx >= 0) dbUsed[idx] = true; else addedClient.push(c);
    }
    const removedDb = dbComments.filter((_, i) => !dbUsed[i]);
    if (addedClient.length > 1 || removedDb.length > 1) throw new Error('只能增删自己的评论');
    for (const c of addedClient) {
      if (!c || typeof c !== 'object' || String(c.author || '') !== me) throw new Error('只能发布自己的评论');
    }
    for (const c of removedDb) {
      const author = String((c && c.author) || '');
      if (author !== me && !(await checkAdmin(config, me))) throw new Error('只能删除自己的评论');
    }
    // 以库内数组为基准：未变化的评论原样保留，新增评论前置
    out.comments = addedClient.concat(dbComments.filter((_, i) => dbUsed[i]));
  }

  return { replacementBody: out };
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
  // 用户名字符集与改名字符集一致（P2-07）
  const safeName = /^[A-Za-z0-9_.-]{1,64}$/.test(String(username)) ? username : '';

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
