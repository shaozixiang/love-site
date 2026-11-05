// ============================================================
// 平台超管 · 租户管理接口 /api/tenants
// 仅平台超管（默认租户 id=1 + PLATFORM_ADMIN_USERNAMES 白名单）可调用，其他一律 403。
// 动作（POST body.action）：
//   list    列出全部租户
//   create  开通新租户（空白站，status=awaiting_owner，等待首用户抢占）
//   suspend 停用租户
//   resume  恢复租户
//   reset   软重置：保留内容，清空 owner 回 awaiting_owner，旧管理员降级
//   purge   硬重置：删除该租户全部数据 + 清图仓（需 body.confirm === true）
//   delete  彻底删除：清空全部数据 + 图仓后删除 tenant 行（需 body.confirm === true）
// ============================================================

import {
  getConfig, authHeaders, requireSession, checkAllowedOrigin,
  corsHeaders, jsonResponse, readCookie
} from '../_lib/session.js';
import { resolveTenant, isPlatformAdmin, invalidateTenantCache } from '../_lib/tenant.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

// 17 张业务表（硬重置时按 tenant_id 清空）
const TENANT_TABLES = [
  'feeds', 'messages', 'loves', 'memories', 'memos', 'schedules', 'countdowns', 'travel_markers',
  'users', 'bubble_config', 'angry_mode', 'site_config', 'bubble_photos',
  'apologies', 'admin_logs', 'login_bg_config', 'login_bg_media'
];

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const originCheck = checkAllowedOrigin(origin, env.ACCOUNT_ALLOWED_ORIGINS || env.UPLOAD_ALLOWED_ORIGINS);
  const headers = corsHeaders(originCheck.corsOrigin, { methods: 'POST, OPTIONS' });
  if (!originCheck.allowed) return jsonResponse({ error: 'Origin is not allowed.' }, 403, headers);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, headers);

  const config = getConfig(env);
  if (!config.ok) return jsonResponse({ error: config.error }, 500, headers);

  let body = {};
  try { body = await request.json(); } catch (e) {
    return jsonResponse({ error: 'Expected JSON request body.' }, 400, headers);
  }

  // 平台超管必须在默认租户下操作
  const tenant = await resolveTenant(request, config);
  const token = request.headers.get('X-Couple-Token') || readCookie(request.headers.get('Cookie') || '', 'couple_t');
  let session;
  try { session = await requireSession(config, token, tenant); }
  catch (e) { return jsonResponse({ error: '未登录或登录已失效，请重新登录' }, 401, headers); }
  const platformAdmin = await isPlatformAdmin(env, session.username, tenant);
  if (!platformAdmin) return jsonResponse({ error: '无权限：仅平台超管可管理租户' }, 403, headers);

  try {
    const action = String(body.action || 'list');
    let result;
    switch (action) {
      case 'list': result = await listTenants(config); break;
      case 'create': result = await createTenant(config, body); break;
      case 'suspend': result = await changeStatus(config, body, 'suspended'); break;
      case 'resume': result = await resumeTenant(config, body); break;
      case 'reset': result = await softReset(config, body); break;
      case 'purge': result = await hardPurge(config, body, env); break;
      case 'delete': result = await deleteTenant(config, body, env); break;
      default: return jsonResponse({ error: '未知操作：' + action }, 400, headers);
    }
    return jsonResponse(result, 200, headers);
  } catch (error) {
    return jsonResponse({ error: error.message || 'Tenant action failed.' }, error.status || 500, headers);
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function sb(config, path, options = {}) {
  const resp = await fetch(`${config.supabaseUrl}/rest/v1${path}`, {
    method: options.method || 'GET',
    headers: { ...authHeaders(config), ...(options.prefer ? { Prefer: options.prefer } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await resp.text();
  const data = text ? JSON.parse(text) : null;
  if (!resp.ok) throw httpError(resp.status, data && (data.message || data.error) || 'Supabase request failed.');
  return data;
}

// ---------- 列表 ----------
async function listTenants(config) {
  const rows = await sb(config, '/tenants?select=id,slug,name,owner_id,status,created_at,updated_at&order=id.asc');
  return { tenants: rows || [] };
}

// ---------- 开通（空白站） ----------
async function createTenant(config, body) {
  const slug = String(body.slug || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  if (!SLUG_RE.test(slug)) {
    throw httpError(400, '网址标识不合法：2-32 位小写字母/数字/连字符，首尾为字母或数字');
  }
  if (!name) throw httpError(400, '请填写站点名称');
  if (slug === 'default') throw httpError(400, '该标识不可用');

  // 唯一性预检（DB unique 约束兜底）
  const exist = await sb(config, `/tenants?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`);
  if (Array.isArray(exist) && exist.length) throw httpError(409, '该网址标识已被占用');

  const now = new Date().toISOString();
  const rows = await sb(config, '/tenants', {
    method: 'POST',
    prefer: 'return=representation',
    body: { slug, name, owner_id: null, status: 'awaiting_owner', created_at: now, updated_at: now }
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  return { ok: true, tenant: row, url: `/s/${slug}/` };
}

// ---------- 停用/通用状态变更 ----------
async function changeStatus(config, body, status) {
  const id = parseInt(body.id, 10);
  if (!id) throw httpError(400, '缺少租户 id');
  if (id === 1) throw httpError(400, '不能停用默认主站');
  const rows = await sb(config, `/tenants?id=eq.${id}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { status, updated_at: new Date().toISOString() }
  });
  if (rows && rows[0]) invalidateTenantCache(rows[0]);
  return { ok: true, tenant: rows && rows[0] };
}

// ---------- 恢复：有 owner 回 active，无 owner 回 awaiting_owner ----------
async function resumeTenant(config, body) {
  const id = parseInt(body.id, 10);
  if (!id) throw httpError(400, '缺少租户 id');
  const cur = await sb(config, `/tenants?id=eq.${id}&select=id,slug,owner_id&limit=1`);
  if (!Array.isArray(cur) || !cur.length) throw httpError(404, '租户不存在');
  const status = cur[0].owner_id ? 'active' : 'awaiting_owner';
  const rows = await sb(config, `/tenants?id=eq.${id}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { status, updated_at: new Date().toISOString() }
  });
  if (rows && rows[0]) invalidateTenantCache(rows[0]);
  return { ok: true, tenant: rows && rows[0] };
}

// ---------- 软重置：保留内容，清空 owner，旧管理员降级 ----------
async function softReset(config, body) {
  const id = parseInt(body.id, 10);
  if (!id) throw httpError(400, '缺少租户 id');
  if (id === 1) throw httpError(400, '不能重置默认主站');
  const cur = await sb(config, `/tenants?id=eq.${id}&select=id,slug&limit=1`);
  if (!Array.isArray(cur) || !cur.length) throw httpError(404, '租户不存在');

  // 旧管理员全部降级为普通用户，保证抢占后只有一个管理员
  await sb(config, `/users?tenant_id=eq.${id}`, { method: 'PATCH', body: { role: 'user' } });
  const rows = await sb(config, `/tenants?id=eq.${id}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { owner_id: null, status: 'awaiting_owner', updated_at: new Date().toISOString() }
  });
  if (rows && rows[0]) invalidateTenantCache(rows[0]);
  return { ok: true, tenant: rows && rows[0], note: '内容已保留，等待新管理员抢占' };
}

// ---------- 硬重置：删全部数据 + 清图仓，tenant 行回到待接管 ----------
async function hardPurge(config, body, env) {
  if (body.confirm !== true) throw httpError(400, '硬重置需显式确认：confirm=true');
  const purged = await purgeTenantData(config, body, env);
  const rows = await sb(config, `/tenants?id=eq.${purged.id}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { owner_id: null, status: 'awaiting_owner', updated_at: new Date().toISOString() }
  });
  if (rows && rows[0]) invalidateTenantCache(rows[0]);
  return {
    ok: true, tenant: rows && rows[0], deleted: purged.deleted,
    storagePurged: purged.storagePurged, storageError: purged.storageError,
    note: purged.storageError ? '数据已清空，但图仓清理失败需人工核对' : '已完全清空并回到待接管状态'
  };
}

// ---------- 彻底删除：清空数据 + 图仓后删除 tenant 行 ----------
async function deleteTenant(config, body, env) {
  if (body.confirm !== true) throw httpError(400, '删除站点需显式确认：confirm=true');
  const purged = await purgeTenantData(config, body, env);
  await sb(config, `/tenants?id=eq.${purged.id}`, { method: 'DELETE' });
  invalidateTenantCache({ id: purged.id, slug: purged.slug });
  return {
    ok: true, id: purged.id, slug: purged.slug, deleted: purged.deleted,
    storagePurged: purged.storagePurged, storageError: purged.storageError,
    note: purged.storageError ? '站点已删除，但图仓清理失败需人工核对' : '站点及其全部数据、文件已彻底删除'
  };
}

// 共用清理：校验 + 删 17 表 + 清图仓
async function purgeTenantData(config, body, env) {
  const id = parseInt(body.id, 10);
  if (!id) throw httpError(400, '缺少租户 id');
  if (id === 1) throw httpError(400, '不能删除默认主站');
  const cur = await sb(config, `/tenants?id=eq.${id}&select=id,slug&limit=1`);
  if (!Array.isArray(cur) || !cur.length) throw httpError(404, '租户不存在');
  const slug = cur[0].slug;

  // 逐表删除该租户数据（独立容错，失败即抛出）
  const deleted = {};
  for (const table of TENANT_TABLES) {
    await sb(config, `/${table}?tenant_id=eq.${id}`, { method: 'DELETE' });
    deleted[table] = true;
  }

  // 清图仓 t/<slug>/（失败不阻断，返回告警）
  let storagePurged = false;
  let storageError = null;
  try {
    storagePurged = await deleteTenantFiles(env, slug);
  } catch (e) { storageError = String(e.message || e); }

  return { id, slug, deleted, storagePurged, storageError };
}

// 通过 Git Data API 删除图仓 t/<slug>/ 下所有文件
async function deleteTenantFiles(env, slug) {
  const ghToken = env.GITHUB_TOKEN;
  const owner = env.GITHUB_OWNER || 'shaozixiang';
  const repo = env.GITHUB_REPO || 'couple-images';
  const branch = env.GITHUB_BRANCH || 'main';
  if (!ghToken) throw new Error('GITHUB_TOKEN 未配置');
  const prefix = `t/${slug}/`;

  const gh = (path, opts = {}) => githubFetch(owner, repo, ghToken, path, opts);

  const refResp = await gh(`/git/ref/heads/${encodeURIComponent(branch)}`);
  if (!refResp.ok) throw new Error('取分支失败');
  const commitSha = refResp.json.object.sha;
  const baseCommit = await gh(`/git/commits/${commitSha}`);
  if (!baseCommit.ok) throw new Error('取提交失败');
  const baseTreeSha = baseCommit.json.tree.sha;

  const treeResp = await gh(`/git/trees/${baseTreeSha}?recursive=1`);
  if (!treeResp.ok) throw new Error('取目录树失败');
  const tree = Array.isArray(treeResp.json.tree) ? treeResp.json.tree : [];
  const victimPaths = tree.filter(t => t.path.startsWith(prefix)).map(t => t.path);
  if (victimPaths.length === 0) return true; // 无文件即视为已清空

  const newTree = await gh('/git/trees', {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: victimPaths.map(path => ({ path, mode: '100644', type: 'blob', sha: null }))
    })
  });
  if (!newTree.ok) throw new Error('建树（删除）失败');

  const newCommit = await gh('/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: `Purge tenant ${slug} media`,
      tree: newTree.json.sha,
      parents: [commitSha]
    })
  });
  if (!newCommit.ok) throw new Error('建提交失败');

  const upd = await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.json.sha, force: false })
  });
  if (!upd.ok) throw new Error('更新分支失败');
  return true;
}

async function githubFetch(owner, repo, token, path, opts = {}) {
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'couple-tenant-admin',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: opts.body
  });
  const txt = await resp.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch (e) { json = { raw: txt }; }
  return { ok: resp.ok, status: resp.status, json };
}
