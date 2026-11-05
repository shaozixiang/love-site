// ============================================================
// 多租户上下文共享模块
// - resolveTenant：从路由层注入的请求头识别当前租户，查 tenants 表（带短 TTL 缓存）
// - 无租户头（根站/旧入口）→ 默认租户 id=1，保证向后兼容
// - isPlatformAdmin：平台超管判定（仅默认租户 + 环境变量白名单）
// 安全约定：X-Tenant-Id / X-Tenant-Slug 只由 functions/s 路由层注入；
//           外部请求即使伪造同名头，也会在路由层被剥离/覆盖，且这里以数据库校验为准。
// ============================================================

import { authHeaders } from './session.js';

export const DEFAULT_TENANT_ID = 1;
const DEFAULT_TENANT = {
  id: 1, slug: 'default', name: '默认主站', owner_id: null, status: 'active'
};

const CACHE_TTL_MS = 30 * 1000;
const tenantCache = new Map(); // key -> { value, exp }

function cacheGet(key) {
  const hit = tenantCache.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) { tenantCache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  if (tenantCache.size > 200) tenantCache.clear();
  tenantCache.set(key, { value, exp: Date.now() + CACHE_TTL_MS });
}

// 内部：按字段查询 tenants
async function fetchTenantRow(config, field, value) {
  const q = field === 'id'
    ? `id=eq.${encodeURIComponent(value)}`
    : `slug=eq.${encodeURIComponent(value)}`;
  const resp = await fetch(
    `${config.supabaseUrl}/rest/v1/tenants?select=id,slug,name,owner_id,status&${q}&limit=1`,
    { headers: authHeaders(config) }
  );
  if (!resp.ok) return null;
  const rows = await resp.json().catch(() => null);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// 解析当前租户。返回租户对象；查不到时回退默认租户（路由层已对不存在的 slug 做 404，
// 这里的回退仅用于根站/异常兜底）。
export async function resolveTenant(request, config) {
  const headerId = String(request.headers.get('X-Tenant-Id') || '').trim();
  const headerSlug = String(request.headers.get('X-Tenant-Slug') || '').trim();

  if (!headerId && !headerSlug) return DEFAULT_TENANT;

  const cacheKey = headerId ? `id:${headerId}` : `slug:${headerSlug}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let row = null;
  if (headerId && /^\d+$/.test(headerId)) {
    row = await fetchTenantRow(config, 'id', Number(headerId));
  }
  if (!row && headerSlug) {
    row = await fetchTenantRow(config, 'slug', headerSlug);
  }
  if (!row) return DEFAULT_TENANT;

  cacheSet(`id:${row.id}`, row);
  cacheSet(`slug:${row.slug}`, row);
  return row;
}

// 平台超管：必须属于默认租户，且用户名在环境变量白名单（默认 admin）
export async function isPlatformAdmin(env, username, tenant) {
  if (!tenant || Number(tenant.id) !== DEFAULT_TENANT_ID) return false;
  const allow = String(env.PLATFORM_ADMIN_USERNAMES || 'admin')
    .split(',').map(s => s.trim()).filter(Boolean);
  return allow.includes(String(username));
}

// 清除租户缓存（租户状态变更/重置后调用，避免读到旧状态）
export function invalidateTenantCache(tenant) {
  if (!tenant) return;
  tenantCache.delete(`id:${tenant.id}`);
  tenantCache.delete(`slug:${tenant.slug}`);
}
