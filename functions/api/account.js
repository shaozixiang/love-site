const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_MIN_LENGTH = 4;
// 事件通知实例级限流表（同发布者同类型 30 秒内最多 1 封）
const NOTIFY_RATE = new Map();
const USER_COLUMNS = 'username,password,password_hash,password_salt,avatar,permission,role,last_active,is_online';
const PUBLIC_USER_COLUMNS = 'username,avatar,permission,role,last_active,is_online';

export async function onRequest(context) {
  const { request, env } = context;
  const originCheck = checkAllowedOrigin(request.headers.get('Origin') || '', env.ACCOUNT_ALLOWED_ORIGINS || env.UPLOAD_ALLOWED_ORIGINS);
  const headers = corsHeaders(originCheck.corsOrigin);

  if (!originCheck.allowed) return jsonResponse({ error: 'Account origin is not allowed.' }, 403, headers);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method === 'GET') return jsonResponse(healthPayload(env), 200, headers);
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, headers);

  const config = getConfig(env);
  if (!config.ok) return jsonResponse({ error: config.error }, 500, headers);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ error: 'Expected JSON request body.' }, 400, headers);
  }

  try {
    const result = await handleAction(config, body || {});
    return jsonResponse(result, 200, headers);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Account request failed.' }, error.status || 500, headers);
  }
}

async function handleAction(config, body) {
  const action = String(body.action || '');
  if (action === 'login') return login(config, body);
  if (action === 'publicRegister') return publicRegister(config, body);

  const session = await requireSession(config, body.sessionToken);
  if (action === 'me') return { user: await getPublicUser(config, session.username) };
  if (action === 'listUsers') return requireAdminThen(config, session.username, () => listUsers(config));
  if (action === 'createUser') return requireAdminThen(config, session.username, () => createUser(config, body));
  if (action === 'deleteUser') return requireAdminThen(config, session.username, () => deleteUser(config, body.username));
  if (action === 'toggleUserRole') return requireAdminThen(config, session.username, () => toggleUserRole(config, body.username));
  if (action === 'setUserPermission') return requireAdminThen(config, session.username, () => setUserPermission(config, body.username, body.permission));
  if (action === 'setUserPassword') return requireAdminThen(config, session.username, () => setUserPassword(config, body.username, body.newPassword));
  if (action === 'changePassword') return changePassword(config, session.username, body.oldPassword, body.newPassword);
  if (action === 'updateAvatar') return updateAvatar(config, session.username, body.avatar);
  if (action === 'updateActivity') return updateActivity(config, session.username);
  if (action === 'onlineStatus') return onlineStatus(config, session.username);
  if (action === 'setMyEmail') return setMyEmail(config, session.username, body.email);
  if (action === 'getNotifyConfig') return getNotifyConfig(config, session.username);
  if (action === 'notify') return sendNotify(config, session.username, body);
  if (action === 'setNotifyConfig') return requireAdminThen(config, session.username, () => setNotifyConfig(config, session.username, body));
  if (action === 'setNotifySwitches') return requireAdminThen(config, session.username, () => setNotifySwitches(config, body));
  if (action === 'setUserEmail') return requireAdminThen(config, session.username, () => setUserEmail(config, body));
  if (action === 'setSignupCode') return requireAdminThen(config, session.username, () => setSignupCode(config, body));
  if (action === 'getSignupCode') return requireAdminThen(config, session.username, () => getSignupCode(config));
  if (action === 'testNotify') return requireAdminThen(config, session.username, () => testNotify(config, session.username, body));
  if (action === 'logout') return logout(config, session.username);

  throw httpError(400, 'Unknown account action.');
}

async function login(config, body) {
  const username = cleanUsername(body.username);
  const password = String(body.password || '');
  if (!username || !password) throw httpError(400, '请输入账号和密码');

  const user = await fetchUser(config, username, USER_COLUMNS);
  if (!user || !(await verifyPassword(config, password, user))) throw httpError(401, '账号或密码错误');

  if (!user.password_hash) await updatePassword(config, username, password);
  await patchUser(config, username, { last_active: new Date().toISOString(), is_online: true });

  return {
    user: sanitizeUser({ ...user, password: undefined }),
    sessionToken: await signSession(config, username)
  };
}

async function listUsers(config) {
  // 后台用户列表只展示首字母/角色/权限/在线状态，不返回大体积 base64 头像，
  // 避免响应体过大（此前可达 180KB+）导致移动端/弱网下后台加载超时
  const LIST_USER_COLUMNS = 'username,permission,role,last_active,is_online';
  const rows = await supabase(config, `/users?select=${encodeURIComponent(LIST_USER_COLUMNS)}&order=username.asc`, { method: 'GET' });
  return { users: (rows || []).map(sanitizeUser) };
}

async function createUser(config, body) {
  const username = cleanUsername(body.username);
  const password = String(body.password || '');
  if (!username || !password) throw httpError(400, '请填写账号和密码');
  assertPassword(password);
  if (await fetchUser(config, username, PUBLIC_USER_COLUMNS)) throw httpError(409, '账号已存在');

  const passwordData = await buildPasswordFields(config, password);
  const row = await insertUser(config, {
    username,
    password: null,
    ...passwordData,
    avatar: '',
    permission: 'full',
    role: 'user',
    is_online: false
  });
  return { user: sanitizeUser(row) };
}

// 登录页公开注册：不需要登录，但必须持有管理员在后台设置的"注册邀请码"
// 未设置 signup_code 时通道默认关闭，避免私密小站被陌生人自助注册
async function publicRegister(config, body) {
  const username = cleanUsername(body.username);
  const password = String(body.password || '');
  const inviteCode = String(body.inviteCode || '').trim();
  if (!username || !password) throw httpError(400, '请填写账号和密码');
  if (!inviteCode) throw httpError(400, '请填写注册邀请码');
  assertPassword(password);

  let m = {};
  try { m = await getSiteValues(config); } catch (e) { throw httpError(400, '注册服务暂不可用，请稍后再试'); }
  const signupCode = String(m.signup_code || '').trim();
  if (!signupCode) throw httpError(403, '注册通道未开通，请联系管理员');
  if (inviteCode !== signupCode) throw httpError(403, '邀请码不正确');

  if (await fetchUser(config, username, PUBLIC_USER_COLUMNS)) throw httpError(409, '账号已存在');
  const passwordData = await buildPasswordFields(config, password);
  const row = await insertUser(config, {
    username,
    password: null,
    ...passwordData,
    avatar: '',
    permission: 'comment',  // 自助注册默认仅可评论/点赞，管理员可在后台提升为完全权限
    role: 'user',
    is_online: false
  });
  // 注册成功直接登录，省去再次输入
  await patchUser(config, username, { last_active: new Date().toISOString(), is_online: true });
  return { user: sanitizeUser(row), sessionToken: await signSession(config, username) };
}

async function setSignupCode(config, body) {
  const code = String(body.code || '').trim();
  await setSiteValue(config, 'signup_code', code);  // 空字符串即关闭注册通道
  return { ok: true, code };
}

async function getSignupCode(config) {
  let m = {};
  try { m = await getSiteValues(config); } catch (e) { return { code: '' }; }
  return { code: m.signup_code || '' };
}

async function deleteUser(config, usernameInput) {
  const username = cleanUsername(usernameInput);
  if (!username) throw httpError(400, '用户不存在');
  if (username === 'admin') throw httpError(400, '不能删除管理员账号');
  await supabase(config, `/users?username=eq.${encodeURIComponent(username)}`, { method: 'DELETE' });
  return { ok: true };
}

async function toggleUserRole(config, usernameInput) {
  const username = cleanUsername(usernameInput);
  if (!username) throw httpError(400, '用户不存在');
  if (username === 'admin') throw httpError(400, '不能修改超级管理员的角色');
  const user = await fetchUser(config, username, PUBLIC_USER_COLUMNS);
  if (!user) throw httpError(404, '用户不存在');
  const role = user.role === 'admin' ? 'user' : 'admin';
  return { user: sanitizeUser(await patchUser(config, username, { role })) };
}

async function setUserPermission(config, usernameInput, permissionInput) {
  const username = cleanUsername(usernameInput);
  const permission = String(permissionInput || '');
  if (!username) throw httpError(400, '用户不存在');
  if (username === 'admin') throw httpError(400, '不能修改超级管理员的权限');
  if (!['view', 'comment', 'full'].includes(permission)) throw httpError(400, '权限值不正确');
  const user = await fetchUser(config, username, PUBLIC_USER_COLUMNS);
  if (!user) throw httpError(404, '用户不存在');
  return { user: sanitizeUser(await patchUser(config, username, { permission })) };
}

async function setUserPassword(config, usernameInput, newPassword) {
  const username = cleanUsername(usernameInput);
  if (!username) throw httpError(400, '用户不存在');
  // 安全：任何管理员都不能重置超级管理员 admin 的密码（admin 只能通过“修改密码”并输入原密码自己改）
  if (username === 'admin') throw httpError(400, '不能修改超级管理员的密码');
  const user = await fetchUser(config, username, PUBLIC_USER_COLUMNS);
  if (!user) throw httpError(404, '用户不存在');
  assertPassword(String(newPassword || ''));
  await updatePassword(config, username, String(newPassword));
  return { ok: true };
}

async function changePassword(config, username, oldPassword, newPassword) {
  const user = await fetchUser(config, username, USER_COLUMNS);
  if (!user || !(await verifyPassword(config, String(oldPassword || ''), user))) throw httpError(401, '原密码错误');
  assertPassword(String(newPassword || ''));
  await updatePassword(config, username, String(newPassword));
  return { ok: true };
}

async function updateAvatar(config, username, avatar) {
  const value = String(avatar || '');
  if (!value.startsWith('data:image/')) throw httpError(400, '头像格式不正确');
  return { user: sanitizeUser(await patchUser(config, username, { avatar: value })) };
}

async function updateActivity(config, username) {
  await patchUser(config, username, { last_active: new Date().toISOString(), is_online: true });
  return { ok: true };
}

async function onlineStatus(config, username) {
  // admin 登录时也能看到对方的在线状态（返回 boy/girl 中存在的账号）
  if (username === 'admin') {
    for (const t of ['girl', 'boy']) {
      const u = await fetchUser(config, t, PUBLIC_USER_COLUMNS);
      if (u) return { user: sanitizeUser(u) };
    }
    return { user: null };
  }
  const target = username === 'boy' ? 'girl' : (username === 'girl' ? 'boy' : '');
  if (!target) return { user: null };
  return { user: sanitizeUser(await fetchUser(config, target, PUBLIC_USER_COLUMNS)) };
}

// ---------- 邮箱通知 ----------

async function getSiteValues(config) {
  const rows = await supabase(config, '/site_config?select=key,value&limit=1000', { method: 'GET' });
  const m = {};
  for (const r of (rows || [])) m[r.key] = r.value || '';
  return m;
}

async function setSiteValue(config, key, value) {
  await supabase(config, '/site_config', { method: 'POST', body: { key, value }, prefer: 'resolution=merge-duplicates' });
}

async function setMyEmail(config, username, email) {
  const value = String(email || '').trim();
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw httpError(400, '邮箱格式不正确');
  await setSiteValue(config, `email_${username}`, value);
  return { ok: true, email: value };
}

function readSwitches(m) {
  const off = (v) => v === '0' || v === 'false' || v === 'off';
  return {
    enabled: !off(m.notify_enabled),
    feed: !off(m.notify_feed),
    message: !off(m.notify_message),
    like: !off(m.notify_like)
  };
}

function isCouplePair(username) {
  return username === 'boy' || username === 'girl';
}

function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 1) return s;
  return s.slice(0, 1) + '***' + s.slice(at);
}

async function getNotifyConfig(config, username) {
  let m;
  try { m = await getSiteValues(config); }
  catch (e) { throw httpError(400, '通知配置表未初始化：请先在 Supabase SQL Editor 运行 site_config 建表 SQL（见管理后台提示）'); }
  const emails = {};
  for (const [k, v] of Object.entries(m)) if (k.startsWith('email_') && v) emails[k.slice(6)] = v;
  const switches = readSwitches(m);
  const me = await fetchUser(config, username, 'username,role');
  const admin = username === 'admin' || (me && me.role === 'admin');
  // 普通用户只需拿到自己的邮箱与开关，不下发 EmailJS 凭证与全员邮箱，避免被拿去刷配额
  if (!admin) return { isAdmin: false, myEmail: emails[username] || '', switches };
  return {
    isAdmin: true,
    emailjs: {
      publicKey: m.emailjs_public_key || '',
      serviceId: m.emailjs_service_id || '',
      templateId: m.emailjs_template_id || ''
    },
    emails,
    switches
  };
}

// 事件通知：仅 boy/girl 发布时，把通知发给"对方"。管理员、测试账号等不发送；
// 对方未绑定邮箱、开关关闭、EmailJS 未配置时静默跳过，不占用免费额度。
async function sendNotify(config, username, body) {
  const kind = String(body.kind || '');
  if (!['feed', 'message', 'like'].includes(kind)) return { ok: true, sent: false, reason: 'unknown_kind' };
  if (!isCouplePair(username)) return { ok: true, sent: false, reason: 'not_couple' };

  let m;
  try { m = await getSiteValues(config); }
  catch (e) { return { ok: true, sent: false, reason: 'config_unavailable' }; }

  const sw = readSwitches(m);
  if (!sw.enabled) return { ok: true, sent: false, reason: 'disabled' };
  if (!sw[kind]) return { ok: true, sent: false, reason: 'kind_disabled' };

  const recipient = username === 'boy' ? 'girl' : 'boy';
  const to = String(m['email_' + recipient] || '').trim();
  if (!to) return { ok: true, sent: false, reason: 'recipient_no_email' };

  const publicKey = m.emailjs_public_key, serviceId = m.emailjs_service_id, templateId = m.emailjs_template_id;
  if (!publicKey || !serviceId || !templateId) return { ok: true, sent: false, reason: 'emailjs_not_configured' };

  // 实例级限流：同一发布者、同一事件 30 秒内最多 1 封，防止前端重试或脚本刷配额
  const rk = username + ':' + kind;
  const now = Date.now();
  const last = NOTIFY_RATE.get(rk) || 0;
  if (now - last < 30000) return { ok: true, sent: false, reason: 'rate_limited' };
  NOTIFY_RATE.set(rk, now);

  const detail = String(body.detail || '').slice(0, 60);
  const texts = {
    feed: `你的TA在时光相册发布了新内容${detail ? '：' + detail : ''}`,
    message: `你的TA在留言板写了一条留言${detail ? '：' + detail : ''}`,
    like: `你的TA点赞了你的内容`
  };
  const resp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: serviceId,
      template_id: templateId,
      user_id: publicKey,
      template_params: { to_email: to, from_name: '我们的专属小站', message: texts[kind] }
    })
  });
  const text = await resp.text();
  if (!resp.ok) throw httpError(502, '通知发送失败：' + (text || ('HTTP ' + resp.status)));
  return { ok: true, sent: true, to: maskEmail(to) };
}

async function setNotifySwitches(config, body) {
  const map = { enabled: 'notify_enabled', feed: 'notify_feed', message: 'notify_message', like: 'notify_like' };
  const out = {};
  for (const [k, kv] of Object.entries(map)) {
    if (body[k] !== undefined) { const v = body[k] ? '1' : '0'; await setSiteValue(config, kv, v); out[k] = !!body[k]; }
  }
  return { ok: true, switches: out };
}

// 管理员为指定账号设置/清空通知邮箱（用于后台直接绑定 boy/girl 的收件邮箱）
async function setUserEmail(config, body) {
  const target = cleanUsername(body.username);
  if (!target) throw httpError(400, '请选择要设置邮箱的账号');
  const user = await fetchUser(config, target, 'username');
  if (!user) throw httpError(404, '账号不存在');
  const email = String(body.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, '邮箱格式不正确');
  await setSiteValue(config, 'email_' + target, email);
  return { ok: true, username: target, email };
}

async function setNotifyConfig(config, username, body) {
  const keys = { publicKey: 'emailjs_public_key', serviceId: 'emailjs_service_id', templateId: 'emailjs_template_id' };
  for (const [k, kv] of Object.entries(keys)) {
    await setSiteValue(config, kv, String(body[k] || ''));
  }
  return { ok: true };
}

async function testNotify(config, username, body) {
  let m;
  try { m = await getSiteValues(config); }
  catch (e) { throw httpError(400, '通知配置表未初始化：请先执行 site_config 建表 SQL'); }
  const publicKey = m.emailjs_public_key, serviceId = m.emailjs_service_id, templateId = m.emailjs_template_id;
  if (!publicKey || !serviceId || !templateId) throw httpError(400, '请先填写完整的 EmailJS 配置（公钥 / 服务ID / 模板ID）');
  const to = String(body.to || '').trim() || m[`email_${username}`] || '';
  if (!to) throw httpError(400, '请填写收件邮箱（当前账号也未绑定邮箱）');
  const resp = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: serviceId,
      template_id: templateId,
      user_id: publicKey,
      template_params: {
        to_email: to,
        from_name: '我们的专属小站',
        message: '✅ 这是一封来自情侣小站的测试通知邮件，说明邮箱通知配置成功！'
      }
    })
  });
  const text = await resp.text();
  if (!resp.ok) throw httpError(502, '发送失败：' + (text || ('HTTP ' + resp.status)));
  return { ok: true, to };
}

async function logout(config, username) {
  await patchUser(config, username, { is_online: false, last_active: new Date().toISOString() });
  return { ok: true };
}

async function requireAdminThen(config, username, fn) {
  const user = await fetchUser(config, username, PUBLIC_USER_COLUMNS);
  if (!user || !(username === 'admin' || user.role === 'admin')) throw httpError(403, '无权限：只有管理员可以操作这里');
  return fn();
}

async function getPublicUser(config, username) {
  const user = await fetchUser(config, username, PUBLIC_USER_COLUMNS);
  if (!user) throw httpError(401, '登录已失效，请重新登录');
  return sanitizeUser(user);
}

async function fetchUser(config, username, columns) {
  const rows = await supabase(config, `/users?username=eq.${encodeURIComponent(username)}&select=${encodeURIComponent(columns)}&limit=1`, { method: 'GET' });
  return rows && rows[0] ? rows[0] : null;
}

async function insertUser(config, row) {
  const rows = await supabase(config, '/users', { method: 'POST', body: row, prefer: 'return=representation' });
  return rows && rows[0] ? rows[0] : row;
}

async function patchUser(config, username, patch) {
  const rows = await supabase(config, `/users?username=eq.${encodeURIComponent(username)}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
  return rows && rows[0] ? rows[0] : { username, ...patch };
}

async function updatePassword(config, username, password) {
  await patchUser(config, username, { password: null, ...(await buildPasswordFields(config, password)), password_updated_at: new Date().toISOString() });
}

async function buildPasswordFields(config, password) {
  const salt = randomHex(16);
  return { password_hash: await hashPassword(config, password, salt), password_salt: salt };
}

async function verifyPassword(config, password, user) {
  if (user.password_hash && user.password_salt) return constantTimeEqual(await hashPassword(config, password, user.password_salt), user.password_hash);
  return String(user.password || '') === password;
}

async function hashPassword(config, password, salt) {
  const bytes = new TextEncoder().encode(`${salt}:${password}:${config.sessionSecret}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256$${salt}$${arrayBufferToHex(digest)}`;
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    username: user.username,
    avatar: user.avatar || '',
    permission: ['view', 'comment', 'full'].includes(user.permission) ? user.permission : 'full',
    role: (user.role === 'admin' || user.username === 'admin') ? 'admin' : 'user',
    last_active: user.last_active || null,
    is_online: !!user.is_online
  };
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
  if (!response.ok) throw httpError(response.status, data && (data.message || data.error) || 'Supabase request failed.');
  return data;
}

async function signSession(config, username) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { u: username, iat: now, exp: now + SESSION_TTL_SECONDS, n: randomHex(8) };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `${encoded}.${await hmac(config.sessionSecret, encoded)}`;
}

async function requireSession(config, token) {
  const value = String(token || '');
  const parts = value.split('.');
  if (parts.length !== 2) throw httpError(401, '登录已失效，请重新登录');
  const expected = await hmac(config.sessionSecret, parts[0]);
  if (!constantTimeEqual(expected, parts[1])) throw httpError(401, '登录已失效，请重新登录');
  let payload;
  try { payload = JSON.parse(base64UrlDecode(parts[0])); } catch (_) { throw httpError(401, '登录已失效，请重新登录'); }
  if (!payload.u || payload.exp < Math.floor(Date.now() / 1000)) throw httpError(401, '登录已失效，请重新登录');
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

function healthPayload(env) {
  return {
    ok: true,
    endpoint: '/api/account',
    runtime: 'cloudflare-pages-functions',
    hasSupabaseUrl: !!env.SUPABASE_URL,
    hasServiceRoleKey: !!(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY),
    hasSessionSecret: !!env.AUTH_SESSION_SECRET
  };
}

function corsHeaders(origin) {
  const headers = { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function checkAllowedOrigin(origin, allowedOriginsConfig) {
  const allowedOrigins = String(allowedOriginsConfig || '').split(',').map(item => item.trim()).filter(Boolean);
  if (allowedOrigins.length === 0) return { allowed: true, corsOrigin: '*' };
  if (!origin) return { allowed: true, corsOrigin: allowedOrigins[0] };
  const allowed = allowedOrigins.includes(origin);
  return { allowed, corsOrigin: allowed ? origin : '' };
}

function jsonResponse(payload, status, headers) {
  return new Response(JSON.stringify(payload), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

function assertPassword(password) {
  if (password.length < PASSWORD_MIN_LENGTH) throw httpError(400, `密码至少${PASSWORD_MIN_LENGTH}位`);
}

function cleanUsername(value) {
  return String(value || '').trim().slice(0, 64);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function randomHex(bytes) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, value => value.toString(16).padStart(2, '0')).join('');
}

function arrayBufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer), value => value.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(value) {
  return btoa(unescape(encodeURIComponent(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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
